// All strategy parameters. Every value can be overridden via environment (.env).

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}: ${v}`);
  return n;
}

export const config = {
  strategy: (process.env.STRATEGY ?? 'trade') as 'trade' | 'farm',

  // PAPER farming (STRATEGY=farm): hold a hedge, close both legs together after this move
  farmMoveBps: num('FARM_MOVE_BPS', 60),            // bust is ~95 bps away at 100x, ~195 bps at 50x
  farmBustGuard: num('FARM_BUST_GUARD', 0.85),      // close both if a leg is this fraction of the way to its bust
  farmBudgetUsd: num('FARM_BUDGET_USD', 25),        // stop starting cycles once this much has been spent on PAPER; 0 = no cap (farm until the balance can't fund a pair)

  // Sizing
  marginPerLegUsd: num('MARGIN_PER_LEG_USD', 10),   // contract minimum is $10
  leverage: num('LEVERAGE', 100),                   // 100x: backtest least-bad; 1000x lost ~$4/pair
  maxConcurrentPairs: num('MAX_CONCURRENT_PAIRS', 2),
  onePairPerAsset: (process.env.ONE_PAIR_PER_ASSET ?? 'true') !== 'false', // concurrent pairs go on different assets
  pairCooldownMs: num('PAIR_COOLDOWN_MS', 5000),

  // Loser leg: close once its payout <= -stop (fraction of leg margin)
  loserStopPct: num('LOSER_STOP_PCT', 0.30),

  // Winner leg
  takeProfitPct: num('TAKE_PROFIT_PCT', 0.30),       // pair net profit target, fraction of pair margin (+$6 on a $20 pair)
  winnerFloorPct: num('WINNER_FLOOR_PCT', 0.05),     // close winner before its own payout drops below this (fraction of leg margin)
  breakevenBufferPct: num('BREAKEVEN_BUFFER_PCT', 0.01), // once loss is covered, close if pair net falls to this (fraction of pair margin)
  trailGivebackPct: num('TRAIL_GIVEBACK_PCT', 0.30), // in profit mode, close if 30% of peak pair profit is given back
  momentumWindowMs: num('MOMENTUM_WINDOW_MS', 3000),
  momentumMinBps: num('MOMENTUM_MIN_BPS', 1.0),      // favourable move over window to count as "still running"
  stallMs: num('STALL_MS', 3000),                    // no new favourable extreme for this long = momentum stopped
  maxPairHoldMs: num('MAX_PAIR_HOLD_MS', num('LEVERAGE', 100) > 100 ? 15 * 60_000 : 120 * 60_000),

  // Asset selection
  selectorWindowMs: num('SELECTOR_WINDOW_MS', 60_000),
  minActivityBps: num('MIN_ACTIVITY_BPS', 4),        // min price path length (bps) over window to start a pair

  // Safety
  maxSessionLossUsd: num('MAX_SESSION_LOSS_USD', 25), // stop opening new pairs after losing this much
  minFreeBalanceUsd: num('MIN_FREE_BALANCE_USD', 0),
  // Blind time we tolerate before closing open legs: 10 s at 1000x (stop is 3 bps away), 60 s at <=100x (30 bps away).
  feedStaleFlattenMs: num('FEED_STALE_FLATTEN_MS', num('LEVERAGE', 100) > 100 ? 10_000 : 60_000),
  closeRetryMs: num('CLOSE_RETRY_MS', 2000),

  // Live execution
  openDeadlineSec: num('OPEN_DEADLINE_SEC', 300),    // opens expire at the relayer after this (closes use 1h)
  openTimeoutMs: num('OPEN_TIMEOUT_MS', 20_000),     // give up (and cancel) an open not filled within this
  secondLegGraceMs: num('SECOND_LEG_GRACE_MS', 8000), // after one leg fills, abort the other if it hasn't within this
  onStartExisting: (process.env.ON_START_EXISTING ?? 'close') as 'close' | 'ignore', // positions already open at startup

  // PAPER
  stakeIntervalMs: num('STAKE_INTERVAL_MS', 15 * 60_000),
  claimIntervalMs: num('CLAIM_INTERVAL_MS', 60 * 60_000),

  // Simulation
  simStartBalanceUsd: num('SIM_START_BALANCE_USD', 49), // $50 deposit minus $1 activation fee
  simLatencyMinMs: num('SIM_LATENCY_MIN_MS', 900),
  simLatencyMaxMs: num('SIM_LATENCY_MAX_MS', 2000),
} as const;

export type Config = typeof config;
