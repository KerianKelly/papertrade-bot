// Live executor: signs intents and submits them through the Papertrade relayer.
//
// - The main wallet signs only: session-key registration, PAPER stake and claim.
// - A local session key (30-day, stored in state/) signs every open, close and cancel.
// - Fills and closes are confirmed from the wallet's live state stream, and reconciled against
//   trade history whenever a position we own disappears without a settlement event.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  ASSET_BY_ID, DOMAINS, E18, INSTRUMENTS, INTENT_DEADLINE_SEC, SESSION_KEY_TTL_SEC, ZERO_ADDRESS, type Asset,
} from '../constants.ts';
import { ApiError, getJson, postIntent, postJson, WalletStream, type ClosedPosition, type LivePosition } from '../papertrade/api.ts';
import { deadline, randomNonce, signIntent } from '../papertrade/signing.ts';
import { log } from '../log.ts';
import type { CloseResult, Executor, Position } from './types.ts';

const CLOSE_CHECK_MS = 30_000;          // how often an unsettled close is checked against the relayer queue
const CLOSE_MAX_WAIT_MS = 15 * 60_000;   // after this, cancel and resubmit even if it still looks queued
const SESSION_MIN_REMAINING_SEC = 24 * 3600;
const usd = (raw: bigint) => Number(raw) / 1e18;

interface PendingOpen { resolve: (lp: LivePosition) => void; reject: (e: Error) => void; asset: Asset; margin: number }
interface PendingClose { resolve: (r: CloseResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; promise: Promise<CloseResult>; intentId?: string; startedAt: number; misses: number }

export interface LiveOptions {
  openDeadlineSec: number;
  openTimeoutMs: number;
  onStartExisting: 'close' | 'ignore';
}

export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  private wallet: PrivateKeyAccount;
  private session!: PrivateKeyAccount;
  private user: `0x${string}`;
  private stream: WalletStream;
  private pendingOpens = new Map<string, PendingOpen>();   // keyed by the relayer's intentId
  private pendingCloses = new Map<string, PendingClose>(); // keyed by position id
  private ourPositions = new Map<string, Position>();      // positions this process manages
  private abandoned = new Set<string>();                   // open intents we gave up on; close them if they fill late
  private settledCbs: ((r: CloseResult) => void)[] = [];
  private minPaperStake = 1000n * E18;
  private mintedSession = 0;
  private reconciling = new Set<string>();
  private stakeInFlight = false;
  private registering?: Promise<void>;
  private sessionTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(walletKey: `0x${string}`, private stateDir: string, private opts: LiveOptions) {
    this.wallet = privateKeyToAccount(walletKey);
    this.user = this.wallet.address.toLowerCase() as `0x${string}`;
    this.stream = new WalletStream(this.user);
  }

  async init() {
    log.info(`live mode, wallet ${this.user}`);
    this.stream.on('state', () => this.onState());
    this.stream.on('closed', (c: ClosedPosition) => this.onClosed(c));
    this.stream.on('outcome', (id: string, outcome: string) => this.onOutcome(id, outcome));
    this.stream.start();
    const s = await this.stream.ready();
    log.info(`balance $${usd(s.funds.availableBalance).toFixed(2)} available, ${s.positions.size} open positions, PAPER ${usd(s.paper.balance).toFixed(0)} unstaked / ${usd(s.paper.staked).toFixed(0)} staked`);
    try {
      const t = await getJson<{ intake: [unknown, string] }>('/state/trading');
      this.minPaperStake = BigInt(t.intake[1]);
    } catch { /* keep default */ }
    await this.ensureSessionKey();
    this.sessionTimer = setInterval(() => void this.ensureSessionKey().catch((e) => log.error('session key check failed', e)), 3600_000);
    if (s.positions.size) {
      if (this.opts.onStartExisting === 'close') {
        log.warn(`closing ${s.positions.size} position(s) that were already open (ON_START_EXISTING=close)`);
        const existing = [...s.positions.values()].map((lp) => this.toPosition(lp)).filter((p): p is Position => !!p);
        for (const p of existing) this.ourPositions.set(p.id, p);
        await Promise.all(existing.map((p) => this.closeWithRetry(p)));
      } else {
        log.warn('wallet already has open positions; the bot will not manage them');
      }
    }
  }

  // ---------- session key ----------

  private sessionFile() { return `${this.stateDir}/session-${this.user}.json`; }

  /** Make sure we hold a registered session key with at least 24h left; register a new one otherwise. */
  private async ensureSessionKey() {
    mkdirSync(this.stateDir, { recursive: true });
    const s = await this.stream.ready();
    const now = Math.floor(Date.now() / 1000);
    if (existsSync(this.sessionFile())) {
      const stored = JSON.parse(readFileSync(this.sessionFile(), 'utf8')) as { privateKey: `0x${string}`; expiry: number };
      const acct = privateKeyToAccount(stored.privateKey);
      const onchain = s.sessionKeys.find(([k]) => k === acct.address.toLowerCase());
      const expiry = Math.min(stored.expiry, onchain?.[1] ?? 0);
      if (expiry - now > SESSION_MIN_REMAINING_SEC) {
        if (!this.session || this.session.address !== acct.address) log.info(`session key ${acct.address} valid for ${((expiry - now) / 86400).toFixed(1)} more days`);
        this.session = acct;
        return;
      }
      log.info(onchain ? 'session key has < 24h left; registering a new one' : 'stored session key is not registered on-chain; registering a new one');
    }
    await this.registerSessionKey();
  }

  private registerSessionKey(): Promise<void> {
    if (!this.registering) this.registering = this.doRegister().finally(() => { this.registering = undefined; });
    return this.registering;
  }

  private async doRegister() {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const expiry = Math.floor(Date.now() / 1000) + SESSION_KEY_TTL_SEC;
    const { signed } = await signIntent(this.wallet, DOMAINS.exchange, 'RegisterSessionKey', {
      user: this.user, key: acct.address.toLowerCase(), expiry: BigInt(expiry), feeAddress: ZERO_ADDRESS,
      nonce: randomNonce(), deadline: deadline(INTENT_DEADLINE_SEC),
    });
    log.info(`registering new session key ${acct.address}…`);
    try {
      await postIntent('registerSessionKey', signed);
    } catch (e) {
      if (e instanceof ApiError && e.body.reason === 'sessionKeyLimit') {
        throw new Error('this wallet has too many session keys; revoke old ones (SessionKeyManager.revokeSessionKey) and restart');
      }
      throw e;
    }
    // Persist only after the relayer accepted it, so a rejected key is never reused.
    writeFileSync(this.sessionFile(), JSON.stringify({ privateKey: pk, expiry }), { mode: 0o600 });
    chmodSync(this.sessionFile(), 0o600);
    const t0 = Date.now();
    while (!this.stream.state?.sessionKeys.some(([k]) => k === acct.address.toLowerCase())) {
      if (Date.now() - t0 > 90_000) throw new Error('session key registration not confirmed within 90s');
      await new Promise((r) => setTimeout(r, 500));
    }
    this.session = acct;
    log.info('session key registered');
  }

  /** Run a session-signed submission; if the relayer says the key is unauthorized, re-register once and retry. */
  private async withSession<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.body.code === 'unauthorized_intent') {
        log.warn('intent rejected as unauthorized; re-registering session key and retrying');
        await this.registerSessionKey();
        return await fn();
      }
      throw e;
    }
  }

  // ---------- trading ----------

  async open(asset: Asset, isLong: boolean, margin: number, leverage: number, signal?: AbortSignal): Promise<Position> {
    if (signal?.aborted) throw new Error('open aborted');
    const inst = INSTRUMENTS[asset];
    const size = BigInt(Math.round(margin * 100)) * 10n ** 16n;

    const submit = async (deadlineSec: number): Promise<string> => {
      const { signed, intentId } = await signIntent(this.session, DOMAINS.exchange, 'OpenPosition', {
        user: this.user, instrumentId: inst.id, isLong, size, leverage, useDebt: false,
        nonce: randomNonce(), deadline: deadline(deadlineSec),
      });
      const localId = intentId.toLowerCase();
      let res: Awaited<ReturnType<typeof postIntent>>;
      try {
        res = await postIntent('openPosition', signed, {}, signal);
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          // Definitely rejected, never queued. Fall back to the frontend's 1h deadline once if that was the problem.
          if (['deadline_expired', 'invalid_intent'].includes(String(e.body.code)) && deadlineSec < INTENT_DEADLINE_SEC) {
            log.warn(`open rejected with ${e.body.code} at ${deadlineSec}s deadline; retrying with ${INTENT_DEADLINE_SEC}s`);
            this.opts.openDeadlineSec = INTENT_DEADLINE_SEC;
            return submit(INTENT_DEADLINE_SEC);
          }
          throw e;
        }
        // Timeout / 5xx / network: the relayer may still have queued it, so make sure it can't fill unmanaged.
        log.warn(`open ${localId.slice(0, 10)}… failed after sending (${(e as Error).message}); cancelling in case it was queued`);
        this.abandoned.add(localId);
        void this.cancelIntent(localId);
        throw e;
      }
      const id = String(res.intentId ?? localId).toLowerCase();
      if (id !== localId) log.warn(`relayer intentId ${id} differs from local ${localId}; using relayer's`);
      log.info(`open ${asset} ${isLong ? 'long' : 'short'} $${margin} x${leverage} sent, intent ${id.slice(0, 10)}…`);
      return id;
    };

    const id = await this.withSession(() => submit(this.opts.openDeadlineSec));
    if (signal?.aborted) {
      // Aborted while the POST was in flight: it may be queued, so cancel it and close it if it fills anyway.
      this.abandoned.add(id);
      void this.cancelIntent(id);
      throw new Error('open aborted');
    }
    return new Promise<Position>((resolve, reject) => {
      const giveUp = (msg: string) => {
        this.pendingOpens.delete(id);
        this.abandoned.add(id);
        void this.cancelIntent(id);
        reject(new Error(msg));
      };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); giveUp('open not filled within timeout'); }, this.opts.openTimeoutMs);
      const onAbort = () => { clearTimeout(timer); giveUp('open aborted'); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.pendingOpens.delete(id); };
      this.pendingOpens.set(id, {
        asset, margin,
        resolve: (lp) => {
          done();
          const pos = this.toPosition(lp);
          if (!pos) { reject(new Error(`filled on unknown instrument ${lp.instrumentId}`)); return; }
          this.ourPositions.set(pos.id, pos);
          resolve(pos);
        },
        reject: (e) => { done(); reject(e); },
      });
      this.onState(); // the fill may already be in the stream
    });
  }

  private async cancelIntent(intentId: string) {
    try {
      const { signed } = await signIntent(this.session, DOMAINS.cancellation, 'CancelIntent', {
        user: this.user, intentId, deadline: deadline(INTENT_DEADLINE_SEC),
      });
      const { intentId: _omit, ...body } = signed;
      await postJson(`/intents/${intentId}/cancel`, body);
      log.info(`cancelled intent ${intentId.slice(0, 10)}…`);
    } catch (e) {
      if (e instanceof ApiError && e.body.code === 'intent_not_found') return; // already executed or never queued
      log.warn(`cancel of ${intentId.slice(0, 10)}… failed (${(e as Error).message})`);
    }
  }

  close(pos: Position): Promise<CloseResult> {
    return this.closeMany([pos]).then((rs) => { const r = rs[0]; if (r.status === 'fulfilled') return r.value; throw r.reason; });
  }

  /** One Close intent carrying every id (max 12 per intent on the relayer), so the legs settle together. */
  closeMany(positions: Position[]): Promise<PromiseSettledResult<CloseResult>[]> {
    const fresh: Position[] = [];
    const promises = positions.map((pos) => {
      const existing = this.pendingCloses.get(pos.id);
      if (existing) return existing.promise;
      let resolve!: (v: CloseResult) => void, reject!: (e: Error) => void;
      const promise = new Promise<CloseResult>((res, rej) => { resolve = res; reject = rej; });
      const entry: PendingClose = { resolve, reject, promise, timer: undefined as unknown as NodeJS.Timeout, startedAt: Date.now(), misses: 0 };
      entry.timer = setTimeout(() => void this.checkClose(pos.id, entry), CLOSE_CHECK_MS);
      this.pendingCloses.set(pos.id, entry);
      fresh.push(pos);
      return promise;
    });
    if (fresh.length) void this.submitClose(fresh);
    return Promise.allSettled(promises);
  }

  /**
   * A close that hasn't settled yet. The relayer is a FIFO queue that gets congested, so cancelling
   * and resubmitting only sends us to the back of it. Keep waiting while the intent is still queued;
   * give up (cancel, let the caller retry) only once it has left the queue without settling twice in a
   * row, or after CLOSE_MAX_WAIT_MS.
   */
  private async checkClose(id: string, entry: PendingClose) {
    if (this.pendingCloses.get(id) !== entry) return;
    let queued: { position: number } | undefined | null = null; // null = couldn't tell
    if (entry.intentId) {
      try {
        const q = await getJson<{ entries?: { intentId: string; position: number }[] }>(`/queue-rank/accounts/${this.user}`);
        queued = q.entries?.find((e) => String(e.intentId).toLowerCase() === entry.intentId) ?? undefined;
      } catch { /* treat as unknown */ }
    }
    if (this.pendingCloses.get(id) !== entry) return; // settled while we were asking
    const waited = Date.now() - entry.startedAt;
    if (queued !== undefined) entry.misses = 0; else entry.misses++;
    if (waited < CLOSE_MAX_WAIT_MS && entry.misses < 2) {
      if (queued) log.info(`close of ${id} still queued at the relayer (position ${queued.position}, ${(waited / 1000).toFixed(0)}s); waiting`);
      entry.timer = setTimeout(() => void this.checkClose(id, entry), CLOSE_CHECK_MS);
      return;
    }
    this.pendingCloses.delete(id);
    if (entry.intentId) void this.cancelIntent(entry.intentId); // don't leave a duplicate close queued for a retry to collide with
    entry.reject(new Error(`close not confirmed after ${(waited / 1000).toFixed(0)}s`));
  }

  private async submitClose(positions: Position[]) {
    const ids = positions.map((p) => p.id);
    const entries = ids.map((id) => this.pendingCloses.get(id)).filter((e): e is PendingClose => !!e);
    try {
      const res = await this.withSession(async () => {
        const { signed } = await signIntent(this.session, DOMAINS.exchange, 'Close', {
          user: this.user, positionIds: ids.map((id) => BigInt(id)), nonce: randomNonce(), deadline: deadline(INTENT_DEADLINE_SEC),
        });
        return postIntent('closePositions', signed);
      });
      const intentId = String(res.intentId ?? '').toLowerCase() || undefined;
      for (const e of entries) e.intentId = intentId;
      log.info(`close ${ids.join('+')} sent, intent ${intentId?.slice(0, 10) ?? '?'}…`);
    } catch (e) {
      if (e instanceof ApiError && e.body.reason === 'noOpenPositions') {
        // At least one id is already gone (e.g. liquidated). Reconcile those; fail the rest so the caller retries them alone.
        for (const id of ids) {
          if (this.stream.state?.positions.has(id)) {
            const w = this.pendingCloses.get(id);
            if (w) { clearTimeout(w.timer); this.pendingCloses.delete(id); w.reject(new Error('batch close rejected; retry singly')); }
          } else void this.reconcileClosed(id);
        }
        return;
      }
      for (const id of ids) {
        const w = this.pendingCloses.get(id);
        if (w) { clearTimeout(w.timer); this.pendingCloses.delete(id); w.reject(e as Error); }
      }
    }
  }

  /** Close with bounded retries; used for positions nobody else will retry (startup, shutdown). */
  private async closeWithRetry(pos: Position, attempts = 5): Promise<CloseResult | undefined> {
    for (let i = 1; i <= attempts; i++) {
      try { return await this.close(pos); }
      catch (e) {
        log.error(`close of ${pos.id} failed (attempt ${i}/${attempts}): ${(e as Error).message}`);
        if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    return undefined;
  }

  private toPosition(lp: LivePosition): Position | undefined {
    const asset = ASSET_BY_ID[lp.instrumentId];
    if (!asset) { log.warn(`position ${lp.positionId} is on unknown instrument ${lp.instrumentId}; ignoring`); return undefined; }
    const scale = INSTRUMENTS[asset].priceScale;
    return {
      id: lp.positionId, asset, isLong: lp.isLong, entry: Number(lp.entryPriceRaw) / scale, margin: usd(lp.marginRaw),
      leverage: lp.leverage, bust: Number(lp.bustPriceRaw) / scale, openedAt: lp.openedAtMs,
    };
  }

  private onState() {
    const s = this.stream.state;
    if (!s) return;
    for (const lp of s.positions.values()) {
      if (!lp.intentId) continue;
      const w = this.pendingOpens.get(lp.intentId);
      if (w) w.resolve(lp);
      else if (this.abandoned.has(lp.intentId)) {
        this.abandoned.delete(lp.intentId);
        const pos = this.toPosition(lp);
        if (!pos) continue;
        log.warn(`late fill on abandoned open ${lp.positionId}; closing it`);
        this.ourPositions.set(pos.id, pos);
        void this.close(pos).catch((e) => log.error('failed to close late fill', e));
      }
    }
    // Anything we own that vanished from the stream without a 'closed' event (reconnect gap) is reconciled from history.
    for (const id of this.ourPositions.keys()) if (!s.positions.has(id)) void this.reconcileClosed(id);
  }

  private async reconcileClosed(id: string) {
    if (this.reconciling.has(id)) return;
    this.reconciling.add(id);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 3000)); // give the stream a chance first
        if (!this.ourPositions.has(id) && !this.pendingCloses.has(id)) return;
        const h = await getJson<{ items?: Record<string, string>[] }>(`/query/accounts/${this.user}/trades?limit=75`);
        const t = h.items?.find((x) => String(x.positionId) === id);
        if (t) {
          this.onClosed({
            positionId: id, instrumentId: Number(t.instrumentId), isLong: Boolean(t.isLong), marginRaw: BigInt(t.marginRaw),
            leverage: Number(t.leverage), liquidated: t.kind === 'Liquidated',
            netPnlRaw: BigInt(t.adjustedPnlRaw) - BigInt(t.userPaidFeeRaw ?? '0'), paperMintedRaw: BigInt(t.paperMintedRaw ?? '0'),
          });
          return;
        }
        if (this.stream.state?.positions.has(id)) return; // it's back in the stream; nothing to reconcile
      }
      log.error(`position ${id} vanished from the stream but is not in trade history; check the account manually`);
    } catch (e) {
      log.warn('reconcile failed', (e as Error).message);
    } finally {
      this.reconciling.delete(id);
    }
  }

  private onClosed(c: ClosedPosition) {
    const r: CloseResult = { positionId: c.positionId, netPnl: usd(c.netPnlRaw), liquidated: c.liquidated, paperMinted: usd(c.paperMintedRaw) };
    const wasOurs = this.ourPositions.delete(c.positionId);
    if (wasOurs) this.mintedSession += r.paperMinted;
    const w = this.pendingCloses.get(c.positionId);
    if (w) { clearTimeout(w.timer); this.pendingCloses.delete(c.positionId); w.resolve(r); return; }
    if (wasOurs) {
      log.warn(`position ${c.positionId} settled without our close (${c.liquidated ? 'liquidated' : 'closed elsewhere'})`);
      for (const cb of this.settledCbs) cb(r);
    }
  }

  private onOutcome(intentId: string, outcome: string) {
    if (outcome === 'succeeded') return;
    const w = this.pendingOpens.get(intentId);
    if (w) w.reject(new Error(`open ${outcome}`));
    this.abandoned.delete(intentId);
    // A close intent that ended without executing: fail it now so the caller retries in ~2 s
    // instead of waiting out the 60 s confirmation timeout while the price runs toward the bust.
    for (const [id, c] of this.pendingCloses) {
      if (c.intentId !== intentId) continue;
      log.warn(`close intent ${intentId.slice(0, 10)}… for ${id} ended as '${outcome}'; retrying`);
      clearTimeout(c.timer); this.pendingCloses.delete(id); c.reject(new Error(`close ${outcome}`));
    }
  }

  onSettled(cb: (r: CloseResult) => void) { this.settledCbs.push(cb); }
  openPositionIds() { return [...this.ourPositions.keys()]; }
  lifetimePnl() { const s = this.stream.state; return s ? usd(s.lifetimeRealizedPnl) : undefined; }

  freeBalance() {
    const s = this.stream.state;
    if (!s) return 0;
    let pending = 0;
    for (const p of this.pendingOpens.values()) pending += p.margin;
    return Math.max(0, usd(s.funds.availableBalance) - pending);
  }

  // ---------- PAPER ----------

  async stakePaper() {
    const bal = this.stream.state?.paper.balance ?? 0n;
    if (bal < this.minPaperStake || this.stakeInFlight) return;
    this.stakeInFlight = true;
    try {
      const { signed } = await signIntent(this.wallet, DOMAINS.paperStaking, 'Stake', {
        user: this.user, amount: bal, nonce: randomNonce(), deadline: deadline(INTENT_DEADLINE_SEC),
      });
      await postIntent('paperStake', signed);
      log.info(`staking ${usd(bal).toFixed(0)} PAPER`);
      await new Promise((r) => setTimeout(r, 30_000)); // let the stream catch up before considering another stake
    } finally {
      this.stakeInFlight = false;
    }
  }

  async claimRewards() {
    if ((this.stream.state?.paper.staked ?? 0n) === 0n) return;
    const { signed } = await signIntent(this.wallet, DOMAINS.paperStaking, 'Claim', {
      user: this.user, nonce: randomNonce(), deadline: deadline(INTENT_DEADLINE_SEC),
    });
    try {
      await postIntent('paperClaim', signed);
      log.info('claimed staking rewards (USDC to trading balance)');
    } catch (e) {
      if (e instanceof ApiError && ['noRewards', 'alreadyQueued'].includes(String(e.body.reason))) return;
      throw e;
    }
  }

  paperSummary() {
    const s = this.stream.state;
    return { unstaked: s ? usd(s.paper.balance) : 0, staked: s ? usd(s.paper.staked) : 0, mintedSession: this.mintedSession };
  }

  async shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.sessionTimer);
    for (const [id, w] of this.pendingOpens) { w.reject(new Error('shutdown')); this.abandoned.add(id); void this.cancelIntent(id); }
    await Promise.all([...this.ourPositions.values()].map((p) => this.closeWithRetry(p, 3)));
    if (this.ourPositions.size) log.error(`${this.ourPositions.size} position(s) may still be open: ${[...this.ourPositions.keys()].join(', ')}`);
    this.stream.stop();
  }
}
