import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { config } from '../src/config.ts';
import { SimExecutor } from '../src/executor/sim.ts';
import { PaperFarmer } from '../src/farm.ts';
import { Journal } from '../src/log.ts';
import type { Asset } from '../src/constants.ts';
import type { PriceFeed, Tick } from '../src/prices.ts';

class FakeFeed extends EventEmitter {
  ticks: Record<Asset, Tick[]> = { BTC: [], ETH: [] };
  push(asset: Asset, mid: number) {
    const t: Tick = { t: Date.now(), mid, bid: mid - 0.5, ask: mid + 0.5 };
    this.ticks[asset].push(t); this.emit('tick', asset, t);
  }
  latest(a: Asset) { return this.ticks[a].at(-1); }
  midAt(a: Asset, t: number) { const h = this.ticks[a]; for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i].mid; return h[0]?.mid; }
  ticksSince(a: Asset, t: number) { return this.ticks[a].filter((x) => x.t >= t); }
  healthy() { return true; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(path: number[], latency: [number, number] = [0, 0], stepMs = 60, over: Partial<typeof config> = {}) {
  const feed = new FakeFeed();
  const cfg = { ...config, leverage: 100, farmMoveBps: 60, maxConcurrentPairs: 1, pairCooldownMs: 1e9, closeRetryMs: 100, secondLegGraceMs: 200, ...over };
  const ex = new SimExecutor(feed as unknown as PriceFeed, 49, latency, false);
  await ex.init();
  for (let i = 0; i < 30; i++) { feed.push('BTC', 100_000 + (i % 2) * 2); feed.push('ETH', 3000); }
  feed.push('BTC', 100_000);
  const farmer = new PaperFarmer(cfg, feed as unknown as PriceFeed, ex, new Journal(`${mkdtempSync(`${tmpdir()}/ptf-`)}/j.jsonl`));
  farmer.start();
  await sleep(400);
  for (const mid of path) { feed.push('BTC', mid); await sleep(stepMs); }
  await sleep(300);
  await farmer.stop();
  return { stats: farmer.stats, ex };
}

test('farm: both legs closed together once the move reaches 60 bps; PAPER minted at ~15% of the loss', async () => {
  const path = [100_100, 100_200, 100_300, 100_400, 100_500, 100_620, 100_620];
  const { stats, ex } = await run(path);
  assert.equal(stats.cycles, 1);
  assert.equal(stats.liquidations, 0);
  assert.ok(stats.paperMinted > 100, `minted ${stats.paperMinted}`);
  // loser lost ~$6.2 (62 bps x 100x on $10); winner returned ~85% of it -> net cost about $0.9
  assert.ok(stats.net < 0 && stats.net > -1.5, `net ${stats.net}`);
  const costPer = -stats.net / stats.paperMinted;
  assert.ok(costPer < 0.012, `cost/PAPER ${costPer}`);
  assert.deepEqual(ex.openPositionIds(), []);
});

test('farm: a leg liquidated before the target still farms, and the survivor is closed at once', async () => {
  // Price gaps straight through the 100x bust (~95 bps) with fill latency, so the keeper liquidates the long first.
  const path = [100_000, 99_300, 98_900, 98_900, 98_900, 98_900];
  const { stats, ex } = await run(path, [150, 150]);
  assert.equal(stats.cycles, 1);
  assert.equal(stats.liquidations, 1);
  assert.ok(stats.paperMinted > 200, `minted ${stats.paperMinted}`); // full $10 margin minted
  assert.deepEqual(ex.openPositionIds(), []);
});

test('farm: when one asset will not open (OI cap), the other asset keeps farming', async () => {
  const feed = new FakeFeed();
  const cfg = { ...config, leverage: 100, farmMoveBps: 60, farmBudgetUsd: 0, maxConcurrentPairs: 1, pairCooldownMs: 50, closeRetryMs: 100, secondLegGraceMs: 200 };
  class BtcCapped extends SimExecutor {
    override open(asset: Asset, isLong: boolean, margin: number, leverage: number, signal?: AbortSignal) {
      return asset === 'BTC' ? Promise.reject(new Error('OI cap')) : super.open(asset, isLong, margin, leverage, signal);
    }
  }
  const ex = new BtcCapped(feed as unknown as PriceFeed, 49, [0, 0], false);
  await ex.init();
  for (let i = 0; i < 30; i++) { feed.push('BTC', 100_000 + (i % 2) * 20); feed.push('ETH', 3000 + (i % 2) * 0.1); } // BTC looks busier
  const farmer = new PaperFarmer(cfg, feed as unknown as PriceFeed, ex, new Journal(`${mkdtempSync(`${tmpdir()}/ptf-`)}/j.jsonl`));
  farmer.start();
  await sleep(1000);
  const active = farmer.activeCycles();
  assert.equal(active.length, 1);
  assert.equal(active[0].asset, 'ETH');
  assert.equal(active[0].state, 'holding');
  await farmer.stop();
  assert.deepEqual(ex.openPositionIds(), []);
});

test('farm at 50x / $20 legs: same $1,000 positions, a crash that liquidated 100x legs is closed cleanly at the target', async () => {
  // 1.2% gap in a few ticks with fill latency (like ETH on 2026-10-15): beyond the 100x bust, well inside the 50x one.
  const path = [100_000, 99_300, 98_900, 98_800, 98_800, 98_800];
  const { stats, ex } = await run(path, [150, 150], 60, { leverage: 50, marginPerLegUsd: 20 });
  assert.equal(stats.cycles, 1);
  assert.equal(stats.liquidations, 0);
  assert.ok(stats.paperMinted > 100, `minted ${stats.paperMinted}`);
  assert.ok(stats.net < 0 && stats.net > -3, `net ${stats.net}`);
  assert.deepEqual(ex.openPositionIds(), []);
});
