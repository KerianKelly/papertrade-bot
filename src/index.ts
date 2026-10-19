import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { PriceFeed } from './prices.ts';
import { SimExecutor } from './executor/sim.ts';
import { LiveExecutor } from './executor/live.ts';
import type { Executor } from './executor/types.ts';
import { PairTrader } from './strategy.ts';
import { PaperFarmer } from './farm.ts';
import { Journal, log } from './log.ts';
import { refreshMarkets } from './markets.ts';
import { scoreAssets } from './selector.ts';

const mode = process.argv.find((a) => a.startsWith('--mode='))?.slice(7) ?? 'sim';
if (mode !== 'sim' && mode !== 'live') throw new Error(`unknown mode ${mode}`);

const root = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const strategy = process.argv.find((a) => a.startsWith('--strategy='))?.slice(11) ?? config.strategy;
  if (strategy !== 'trade' && strategy !== 'farm') throw new Error(`unknown strategy ${strategy}`);
  const tag = process.env.RUN_TAG ? `-${process.env.RUN_TAG}` : '';
  log.toFile(`${root}logs/run-${strategy === 'farm' ? 'farm-' : ''}${mode}${tag}.log`);
  log.info(`papertrade-bot starting in ${mode.toUpperCase()} mode`);
  if (strategy === 'farm') log.info(`strategy FARM: legs $${config.marginPerLegUsd} x${config.leverage}, close both at ${config.farmMoveBps} bps, budget ${config.farmBudgetUsd > 0 ? '$' + config.farmBudgetUsd : 'none (farm until the balance cannot fund a pair)'}, max ${config.maxConcurrentPairs} cycles`);
  else log.info(`strategy TRADE: legs $${config.marginPerLegUsd} x${config.leverage}, loser stop -${config.loserStopPct * 100}%, take-profit +${config.takeProfitPct * 100}% of pair, max ${config.maxConcurrentPairs} pairs, session loss limit $${config.maxSessionLossUsd}`);

  // Exchange minimums: $10 margin and $1,000 notional per position. Fail here rather than on every open.
  if (config.marginPerLegUsd < 10) throw new Error(`MARGIN_PER_LEG_USD ${config.marginPerLegUsd} is below the $10 minimum`);
  if (config.marginPerLegUsd * config.leverage < 1000) throw new Error(`$${config.marginPerLegUsd} x${config.leverage} is a $${config.marginPerLegUsd * config.leverage} position; the minimum is $1,000`);

  await refreshMarkets();
  setInterval(refreshMarkets, 60_000);

  const feed = new PriceFeed();
  await feed.start();

  let ex: Executor;
  if (mode === 'live') {
    const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined;
    if (!pk?.match(/^0x[0-9a-fA-F]{64}$/)) throw new Error('WALLET_PRIVATE_KEY missing or malformed in .env');
    log.warn('LIVE TRADING with real funds starts in 5 seconds. Ctrl+C to abort.');
    await new Promise((r) => setTimeout(r, 5000));
    ex = new LiveExecutor(pk, `${root}state`, { openDeadlineSec: config.openDeadlineSec, openTimeoutMs: config.openTimeoutMs, onStartExisting: config.onStartExisting });
  } else {
    ex = new SimExecutor(feed, config.simStartBalanceUsd, [config.simLatencyMinMs, config.simLatencyMaxMs]);
  }
  await ex.init();
  if (ex.freeBalance() < 2 * config.marginPerLegUsd && strategy === 'farm') {
    // On a server the bot should just wait for a deposit (and keep staking/claiming), not exit and restart-loop.
    log.warn(`free balance $${ex.freeBalance().toFixed(2)} is below one pair ($${2 * config.marginPerLegUsd}); waiting for a deposit`);
  } else if (ex.freeBalance() < 2 * config.marginPerLegUsd) {
    log.error(`free balance $${ex.freeBalance().toFixed(2)} is below one pair ($${2 * config.marginPerLegUsd}); nothing to do`);
    await ex.shutdown();
    process.exit(1);
  }

  // Warm up the asset selector with a little price history before trading.
  log.info('warming up price history (20s)…');
  await new Promise((r) => setTimeout(r, 20_000));

  const journal = new Journal(`${root}logs/journal-${strategy === 'farm' ? 'farm-' : ''}${mode}${tag}.jsonl`);
  const trader = strategy === 'farm' ? new PaperFarmer(config, feed, ex, journal) : new PairTrader(config, feed, ex, journal);
  trader.start();

  const stake = async () => { try { await ex.stakePaper(); } catch (e) { log.warn('stake failed:', (e as Error).message); } };
  const claim = async () => { try { await ex.claimRewards(); } catch (e) { log.warn('claim failed:', (e as Error).message); } };
  const stakeTimer = setInterval(stake, config.stakeIntervalMs);
  const claimTimer = setInterval(claim, config.claimIntervalMs);

  const statusTimer = setInterval(() => {
    const scores = scoreAssets(feed, config.selectorWindowMs).map((x) => `${x.asset} ${x.activityBps.toFixed(1)}bps`).join(' ');
    log.info(`${trader.statusLine()} | activity ${scores}`);
  }, 30_000);

  let shuttingDown = 0;
  const shutdown = async () => {
    // Wrappers (npm, caffeinate, a terminal) can deliver the same Ctrl+C several times at once.
    // Only a second request at least 3 s later forces an exit that skips closing positions.
    if (shuttingDown) {
      if (Date.now() - shuttingDown < 3000) return;
      log.warn('forced exit: positions may still be open'); process.exit(1);
    }
    shuttingDown = Date.now();
    log.info('shutting down: closing open positions…');
    clearInterval(stakeTimer); clearInterval(claimTimer); clearInterval(statusTimer);
    await trader.stop();
    await ex.shutdown();
    const left = ex.openPositionIds();
    if (left.length) log.error(`positions possibly still open: ${left.join(', ')} — check papertrade.xyz`);
    await stake();
    feed.stop();
    log.info(`FINAL: ${trader.statusLine()}`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // A crash must never leave 1000x positions unmanaged: flatten, then exit.
  process.on('uncaughtException', (e) => { log.error('uncaught exception, flattening', e); void shutdown(); });
  process.on('unhandledRejection', (e) => { log.error('unhandled rejection, flattening', e); void shutdown(); });
}

main().catch((e) => { log.error(e); process.exit(1); });
