// PAPER farming strategy.
//
// Open a long and a short together and simply hold (there is no funding on Papertrade, so a hedge
// costs nothing to carry). When the price has moved FARM_MOVE_BPS from entry, close BOTH legs in one
// intent so they settle in the same block: the loser mints PAPER on its full loss, the winner hands
// most of that loss back (the exchange keeps ~15% of a large gain). Net cost per PAPER is far below
// the ~$0.04 of a naked loss. If one leg is liquidated first, the other is closed immediately.

import { ASSETS, INSTRUMENTS, type Asset } from './constants.ts';
import type { Config } from './config.ts';
import type { CloseResult, Executor, Position } from './executor/types.ts';
import { legValue } from './math.ts';
import type { PriceFeed, Tick } from './prices.ts';
import { pickAsset } from './selector.ts';
import { log, type Journal } from './log.ts';
import { paperYield, type PaperYield } from './papertrade/yield.ts';

type CycleState = 'opening' | 'holding' | 'closing' | 'done';

interface Cycle {
  id: number;
  asset: Asset;
  state: CycleState;
  startedAt: number;
  long?: Position;
  short?: Position;
  results: Map<string, CloseResult>;
  inFlight: Set<string>;
  aborts: AbortController[];
  lastCloseAttempt: number;
  peakMoveBps: number;
  exitReason?: string;
  closeRequested?: string;
}

export interface FarmStats {
  cycles: number; net: number; paperMinted: number; liquidations: number; aborted: number;
}

export class PaperFarmer {
  private cycles = new Map<number, Cycle>();
  private nextId = 1;
  private lastStart = 0;
  private assetFailures: Record<Asset, { n: number; until: number }> = { BTC: { n: 0, until: 0 }, ETH: { n: 0, until: 0 } };
  private lowBalanceLogged = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private lastLoopAt = 0;
  private feedStaleSince: Record<Asset, number> = { BTC: 0, ETH: 0 };
  private feedBadAt: Record<Asset, number> = { BTC: 0, ETH: 0 }; // last time the feed was unhealthy
  private unmatched = new Map<string, { r: CloseResult; at: number }>();
  private yield_?: PaperYield;
  readonly stats: FarmStats = { cycles: 0, net: 0, paperMinted: 0, liquidations: 0, aborted: 0 };

  constructor(private cfg: Config, private feed: PriceFeed, private ex: Executor, private journal: Journal) {}

  start() {
    this.feed.on('tick', (asset: Asset, tick: Tick) => {
      for (const c of this.cycles.values()) if (c.asset === asset && c.state === 'holding') this.guard(() => this.evaluate(c, tick));
    });
    this.ex.onSettled((r) => this.guard(() => this.handleSettled(r)));
    this.timer = setInterval(() => this.guard(() => this.loop()), 250);
    const refreshYield = () => paperYield().then((y) => { this.yield_ = y; }).catch((e) => log.warn('yield fetch failed', (e as Error).message));
    void refreshYield();
    setInterval(refreshYield, 10 * 60_000).unref();
  }

  activeCycles() { return [...this.cycles.values()].filter((c) => c.state !== 'done'); }

  async stop() {
    this.stopping = true;
    this.flatten('shutdown');
    const t0 = Date.now();
    while (this.activeCycles().length && Date.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 250));
    clearInterval(this.timer);
    const left = this.activeCycles();
    if (left.length) log.error(`${left.length} cycle(s) still unsettled after 120s`);
  }

  /** One-line status for the periodic log. */
  statusLine(): string {
    const s = this.stats;
    const costPer = s.paperMinted > 0 ? -s.net / s.paperMinted : NaN;
    const y = this.yield_;
    const payback = y && Number.isFinite(costPer) && y.perPaperPerDay > 0 ? costPer / y.perPaperPerDay : NaN;
    const live = this.activeCycles().map((c) => `#${c.id} ${c.asset} ${c.state}${c.state === 'holding' ? ` ${this.moveBps(c).toFixed(0)}/${this.cfg.farmMoveBps}bps` : ''}`).join(' ');
    const lifetime = this.ex.lifetimePnl();
    return `FARM bal $${this.ex.freeBalance().toFixed(2)} | cycles ${s.cycles} | PAPER +${s.paperMinted.toFixed(0)} for $${(-s.net).toFixed(2)}${lifetime !== undefined ? ` (lifetime $${(-lifetime).toFixed(2)}${this.cfg.farmBudgetUsd > 0 ? ` of $${this.cfg.farmBudgetUsd}` : ''})` : ''} (${Number.isFinite(costPer) ? '$' + costPer.toFixed(4) : '–'}/PAPER) | yield ${y ? '$' + y.perPaperPerDay.toFixed(5) + '/PAPER/day' : '–'} | payback ${Number.isFinite(payback) ? payback.toFixed(0) + 'd' : '–'} | liqs ${s.liquidations} | ${live || 'idle'}`;
  }

  private guard(fn: () => void) { try { fn(); } catch (e) { log.error('farm error', e); } }
  private legs(c: Cycle): Position[] { return [c.long, c.short].filter((x): x is Position => !!x); }
  private unsettled(c: Cycle): Position[] { return this.legs(c).filter((l) => !c.results.has(l.id)); }

  private moveBps(c: Cycle): number {
    const mid = this.feed.latest(c.asset)?.mid;
    const ref = c.long?.entry ?? c.short?.entry;
    return mid && ref ? Math.abs(mid - ref) / ref * 1e4 : 0;
  }

  // ---------- loop ----------

  private loop() {
    const now = Date.now();
    if (this.lastLoopAt && now - this.lastLoopAt > 5000) log.warn(`process was suspended for ${((now - this.lastLoopAt) / 1000).toFixed(0)}s (machine asleep?)`);
    this.lastLoopAt = now;
    this.watchFeed();
    for (const c of this.activeCycles()) {
      if (c.state === 'closing') this.ensureCloses(c);
      else if (c.state === 'holding') { const t = this.feed.latest(c.asset); if (t) this.evaluate(c, t); }
    }
    this.maybeStart();
  }

  private watchFeed() {
    for (const asset of ASSETS) {
      if (this.feed.healthy(undefined, asset)) { this.feedStaleSince[asset] = 0; continue; }
      this.feedBadAt[asset] = Date.now();
      if (!this.feedStaleSince[asset]) this.feedStaleSince[asset] = Date.now();
      const exposed = this.activeCycles().filter((c) => c.asset === asset && c.state !== 'closing');
      if (exposed.length && Date.now() - this.feedStaleSince[asset] > this.cfg.feedStaleFlattenMs) {
        log.warn(`${asset} price feed stale; closing its cycles`);
        this.feedStaleSince[asset] = Date.now();
        for (const c of exposed) this.closeNow(c, 'feed-stale');
      }
    }
  }

  private flatten(reason: string) { for (const c of this.activeCycles()) this.closeNow(c, reason); }

  private closeNow(c: Cycle, reason: string) {
    if (c.state === 'opening') { c.closeRequested = reason; for (const a of c.aborts) a.abort(); }
    else if (c.state !== 'closing') this.beginClosing(c, reason);
  }

  // ---------- opening ----------

  private maybeStart() {
    if (this.stopping) return;
    const active = this.activeCycles();
    if (active.length >= this.cfg.maxConcurrentPairs) return;
    const cooldown = this.cfg.pairCooldownMs * 2 ** Math.min(...ASSETS.map((a) => this.assetFailures[a].n), 6); // only slows down when every asset is failing
    if (Date.now() - this.lastStart < cooldown) return;
    const spent = -(this.ex.lifetimePnl() ?? this.stats.net); // live: whole account history, so restarts don't reset the cap
    if (this.cfg.farmBudgetUsd > 0 && spent >= this.cfg.farmBudgetUsd) {
      log.warn(`farm budget spent ($${spent.toFixed(2)} of $${this.cfg.farmBudgetUsd}, account lifetime); no new cycles`);
      this.stopping = true;
      return;
    }
    if (this.ex.freeBalance() < 2 * this.cfg.marginPerLegUsd + this.cfg.minFreeBalanceUsd) {
      if (!active.length && !this.lowBalanceLogged) log.warn(`free balance $${this.ex.freeBalance().toFixed(2)} can't fund another $${2 * this.cfg.marginPerLegUsd} pair; waiting (deposit more to keep farming)`);
      this.lowBalanceLogged = !active.length;
      return;
    }
    this.lowBalanceLogged = false;
    const busy = this.cfg.onePairPerAsset ? new Set(active.map((c) => c.asset)) : new Set<Asset>();
    // An asset whose opens keep failing (usually its OI cap is full) sits out; the other one keeps farming.
    // After a feed/network outage, wait until the connection has been steady for a while: a flaky link
    // otherwise opens a cycle only to close it at the next drop.
    for (const a of ASSETS) {
      if (!this.feed.healthy(undefined, a) || Date.now() < this.assetFailures[a].until) busy.add(a);
      if (this.feedBadAt[a] && Date.now() - this.feedBadAt[a] < this.cfg.feedRecoveryMs) busy.add(a);
    }
    const pick = pickAsset(this.feed, this.cfg.selectorWindowMs, 0, busy); // any activity level: we just wait for the move
    if (!pick) return;
    this.lastStart = Date.now();
    void this.openCycle(pick.asset);
  }

  private async openCycle(asset: Asset) {
    const c: Cycle = {
      id: this.nextId++, asset, state: 'opening', startedAt: Date.now(), results: new Map(), inFlight: new Set(),
      aborts: [new AbortController(), new AbortController()], lastCloseAttempt: 0, peakMoveBps: 0,
    };
    this.cycles.set(c.id, c);
    const m = this.cfg.marginPerLegUsd, lev = this.cfg.leverage;
    log.info(`cycle #${c.id} ${asset}: opening long+short $${m} x${lev}, target move ${this.cfg.farmMoveBps} bps`);
    let grace: NodeJS.Timeout | undefined;
    const onFill = (pos: Position, other: AbortController) => {
      if (pos.isLong) c.long = pos; else c.short = pos;
      if (!(c.long && c.short) && !grace) grace = setTimeout(() => other.abort(), this.cfg.secondLegGraceMs);
    };
    const [l, s] = await Promise.allSettled([
      this.ex.open(asset, true, m, lev, c.aborts[0].signal).then((p) => onFill(p, c.aborts[1])),
      this.ex.open(asset, false, m, lev, c.aborts[1].signal).then((p) => onFill(p, c.aborts[0])),
    ]);
    clearTimeout(grace);
    this.adoptUnmatched(c);
    if (!(c.long && c.short)) {
      if (!c.closeRequested) {
        const f = this.assetFailures[asset];
        f.n++; f.until = Date.now() + Math.min(30_000 * 2 ** (f.n - 1), 30 * 60_000);
        log.warn(`${asset} opens failing (${f.n}x in a row); trying the other asset for ${((f.until - Date.now()) / 1000).toFixed(0)}s`);
      }
      const err = [l, s].find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
      log.warn(`cycle #${c.id}: leg failed to open (${err?.message ?? err}); ${c.long || c.short ? 'closing the other' : 'nothing opened'}`);
      this.stats.aborted++;
      this.beginClosing(c, 'open-failed');
      return;
    }
    this.assetFailures[asset] = { n: 0, until: 0 };
    if (c.closeRequested) { this.beginClosing(c, c.closeRequested); return; }
    log.info(`cycle #${c.id}: filled long @${c.long.entry} short @${c.short.entry}; holding`);
    if (this.legs(c).some((x) => c.results.has(x.id))) { this.beginClosing(c, 'liquidated'); return; }
    c.state = 'holding';
  }

  // ---------- holding ----------

  private evaluate(c: Cycle, tick: Tick) {
    const inst = INSTRUMENTS[c.asset];
    const move = this.moveBps(c);
    c.peakMoveBps = Math.max(c.peakMoveBps, move);
    // Bust guard: close before either leg can be liquidated (liquidation still farms, but leaves the other leg naked).
    for (const leg of this.legs(c)) {
      const bustDist = Math.abs(leg.bust - leg.entry) / leg.entry * 1e4;
      const adverse = (leg.isLong ? leg.entry - tick.mid : tick.mid - leg.entry) / leg.entry * 1e4;
      if (adverse >= this.cfg.farmBustGuard * bustDist) { this.beginClosing(c, 'bust-guard'); return; }
    }
    if (move >= this.cfg.farmMoveBps) {
      const l = legValue(c.long!.entry, tick.mid, c.long!.margin, c.long!.leverage, true, inst).payout;
      const s = legValue(c.short!.entry, tick.mid, c.short!.margin, c.short!.leverage, false, inst).payout;
      log.info(`cycle #${c.id}: move ${move.toFixed(1)} bps reached; closing both (est. net ${fmt(l + s)})`);
      this.beginClosing(c, 'target');
    }
  }

  // ---------- closing ----------

  private beginClosing(c: Cycle, reason: string) {
    if (c.state === 'done') return;
    if (c.state !== 'closing') c.exitReason = reason;
    c.state = 'closing';
    this.ensureCloses(c);
  }

  private ensureCloses(c: Cycle) {
    if (c.state !== 'closing') return;
    const open = this.unsettled(c).filter((l) => !c.inFlight.has(l.id));
    if (!this.unsettled(c).length) { this.finish(c); return; }
    if (!open.length || Date.now() - c.lastCloseAttempt < this.cfg.closeRetryMs) return;
    c.lastCloseAttempt = Date.now();
    for (const l of open) c.inFlight.add(l.id);
    const done = (leg: Position, r: PromiseSettledResult<CloseResult>) => {
      c.inFlight.delete(leg.id);
      if (r.status === 'fulfilled') this.guard(() => this.settle(c, r.value));
      else log.error(`cycle #${c.id}: close of ${leg.id} failed (${r.reason?.message ?? r.reason}); will retry`);
    };
    if (open.length > 1) {
      // Both legs in one intent: same block, same price.
      void this.ex.closeMany(open).then((rs) => rs.forEach((r, i) => done(open[i], r)));
    } else {
      void this.ex.close(open[0]).then((v) => done(open[0], { status: 'fulfilled', value: v }), (e) => done(open[0], { status: 'rejected', reason: e }));
    }
  }

  private settle(c: Cycle, r: CloseResult) {
    if (c.results.has(r.positionId)) return;
    const leg = this.legs(c).find((x) => x.id === r.positionId);
    if (!leg) return;
    c.results.set(r.positionId, r);
    if (r.liquidated) log.warn(`cycle #${c.id}: ${leg.isLong ? 'long' : 'short'} LIQUIDATED (${fmt(r.netPnl)}, +${r.paperMinted.toFixed(0)} PAPER)`);
    if (c.state === 'holding') { this.beginClosing(c, 'liquidated'); return; } // close the survivor now
    if (c.state === 'closing') this.ensureCloses(c);
  }

  private handleSettled(r: CloseResult) {
    for (const c of this.activeCycles()) if (this.legs(c).some((x) => x.id === r.positionId)) { this.settle(c, r); return; }
    this.unmatched.set(r.positionId, { r, at: Date.now() });
    for (const [id, u] of this.unmatched) if (Date.now() - u.at > 60_000) this.unmatched.delete(id);
  }

  private adoptUnmatched(c: Cycle) {
    for (const leg of this.legs(c)) { const u = this.unmatched.get(leg.id); if (u) { this.unmatched.delete(leg.id); this.settle(c, u.r); } }
  }

  private finish(c: Cycle) {
    if (c.state === 'done') return;
    c.state = 'done';
    const reason = c.exitReason ?? 'unknown';
    const results = [...c.results.values()];
    const net = results.reduce((a, r) => a + r.netPnl, 0);
    const minted = results.reduce((a, r) => a + r.paperMinted, 0);
    const liqs = results.filter((r) => r.liquidated).length;
    if (reason !== 'open-failed') this.stats.cycles++;
    this.stats.net += net; this.stats.paperMinted += minted; this.stats.liquidations += liqs;
    const costPer = minted > 0 ? -net / minted : NaN;
    log.info(`cycle #${c.id} ${c.asset} done [${reason}] net ${fmt(net)}, +${minted.toFixed(0)} PAPER${Number.isFinite(costPer) ? ` ($${costPer.toFixed(4)}/PAPER)` : ''} in ${((Date.now() - c.startedAt) / 60000).toFixed(1)} min | session PAPER ${this.stats.paperMinted.toFixed(0)} for $${(-this.stats.net).toFixed(2)}`);
    this.journal.write({
      mode: this.ex.mode, strategy: 'farm', cycle: c.id, asset: c.asset, reason, net, paperMinted: minted, costPerPaper: Number.isFinite(costPer) ? costPer : null,
      heldMs: Date.now() - c.startedAt, peakMoveBps: c.peakMoveBps, liquidations: liqs,
      legs: results.map((r) => ({ id: r.positionId, pnl: r.netPnl, paper: r.paperMinted, liquidated: r.liquidated })),
    });
    setTimeout(() => this.cycles.delete(c.id), 60_000).unref();
  }
}

const fmt = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
