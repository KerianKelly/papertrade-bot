# Papertrade bot: full stats

As of **2026-10-19 16:54 UTC**. Wallet `0x03becbf8a067184b40f19c88f58f2731ea901c93`. Live figures are from the exchange's own records (trades, cashflows, staking); simulation figures are from the bot's journals in `logs/`.

## Summary

| | |
|---|---|
| Live trading period | Oct 14 16:05 → Oct 15 12:46 UTC |
| Hedged cycles (long + short pairs) | **19** (38 positions), all in farm mode (hold the hedge, close both together) |
| Leverage / size | 100× / $10 per leg ($1,000 positions) |
| Trading result | **−$22.87** (incl. $1.51 win fees) |
| Staking rewards claimed | +$1.38 |
| **Net result** | **−$21.49** |
| PAPER farmed | **1,743.5**, all 1,743 now staked |
| Average cost per PAPER | $0.0131 |
| Liquidations | 3 cycles |

## Money

| Date (UTC) | Flow | Amount |
|---|---|---|
| Oct 14 15:53 | Deposit (robinhood) | +$50.36 |
| Oct 15 10:24 | Deposit (robinhood) | +$12.00 |
| Oct 15 12:21 | Withdrawal to arbitrum (settled) | −$20.66 (received $19.66) |
| Oct 17 19:19 | Withdrawal to arbitrum (settled) | −$20.21 (received $20.21) |

- Deposited **$62.36**, withdrawn **$40.87** (received $39.87 after route fees), balance now **$0.00**.
- Net money lost: $62.36 − $40.87 = **$21.49**, which matches the trading loss minus staking rewards ($22.87 − $1.38).

## Normal cycles vs liquidations

| | Cycles | Lost | PAPER | Cost per PAPER |
|---|---|---|---|---|
| Normal hedged cycles | 16 | $11.42 | 1,208.0 | $0.0094 |
| Cycles with a liquidation | 3 | $11.45 | 535.5 | $0.0214 |
| **Total** | 19 | $22.87 | 1,743.5 | $0.0131 |

Normal cycles averaged $0.71 lost for 75 PAPER. The 3 liquidations were 50% of all losses.

## Every live cycle

| # | Opened (UTC) | Asset | Held | Exit | Peak move | Long | Short | Net | PAPER | $/PAPER |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Oct 14 16:05 | ETH | 58 min | target | 60 bps | +5.91 | -6.98 | -1.07 | 134.2 | 0.0080 |
| 2 | Oct 14 17:03 | ETH | 22 min | target | 61 bps | -6.04 | +5.08 | -0.96 | 115.7 | 0.0083 |
| 3 | Oct 14 17:25 | ETH | 92 min | shutdown | 59 bps | -2.26 | +1.76 | -0.50 | 42.7 | 0.0116 |
| 4 | Oct 14 18:59 | ETH | 107 min | target | 67 bps | -5.02 | +4.18 | -0.84 | 94.0 | 0.0089 |
| 5 | Oct 14 18:59 | BTC | 480 min | target | 63 bps | -10.00 **LIQ** | +1.93 | -8.07 | 183.6 | 0.0439 |
| 6 | Oct 14 20:47 | ETH | 19 min | target | 60 bps | -2.40 | +1.88 | -0.51 | 44.7 | 0.0115 |
| 7 | Oct 14 21:06 | ETH | 27 min | target | 60 bps | +5.11 | -6.07 | -0.96 | 112.8 | 0.0085 |
| 8 | Oct 14 21:32 | ETH | 35 min | target | 60 bps | -6.09 | +5.13 | -0.96 | 113.0 | 0.0085 |
| 9 | Oct 14 22:08 | ETH | 292 min | target | 67 bps | -10.00 **LIQ** | +12.54 | +2.54 | 184.2 | profit |
| 10 | Oct 15 03:00 | BTC | 31 min | target | 61 bps | -6.08 | +5.18 | -0.90 | 107.9 | 0.0083 |
| 11 | Oct 15 03:30 | ETH | 58 min | target | 60 bps | +5.06 | -6.01 | -0.95 | 106.1 | 0.0090 |
| 12 | Oct 15 04:29 | ETH | 59 min | target | 60 bps | -6.02 | +5.06 | -0.96 | 104.8 | 0.0091 |
| 13 | Oct 15 05:28 | ETH | 43 min | target | 61 bps | -3.30 | +2.68 | -0.63 | 56.7 | 0.0111 |
| 14 | Oct 15 06:11 | ETH | 74 min | target | 61 bps | +4.70 | -5.61 | -0.91 | 95.4 | 0.0095 |
| 15 | Oct 15 07:25 | ETH | 187 min | (not in journal) | – | -0.25 | +0.12 | -0.13 | 4.2 | 0.0305 |
| 16 | Oct 15 10:26 | BTC | 6 min | (not in journal) | – | +1.08 | -1.41 | -0.33 | 23.5 | 0.0140 |
| 17 | Oct 15 10:32 | BTC | 105 min | shutdown | 37 bps | -1.97 | +1.51 | -0.47 | 32.7 | 0.0143 |
| 18 | Oct 15 10:33 | ETH | 105 min | shutdown | 38 bps | -1.18 | +0.83 | -0.35 | 19.6 | 0.0178 |
| 19 | Oct 15 12:29 | ETH | 17 min | target | 69 bps | -10.00 **LIQ** | +4.08 | -5.92 | 167.6 | 0.0353 |

Exit reasons: *target* = price moved the target distance and both legs were closed together; *shutdown* = the bot was stopped mid-cycle (smaller move, less PAPER); *LIQ* = that leg hit its liquidation price first. Cycles 6 and 13 triggered at the target but filled at a smaller move (~24 and ~33 bps), so they minted less PAPER. Cycles 15 and 16 ran during a session whose journal entries weren't written.

## By asset and by day

| Group | Cycles | Lost | PAPER | $/PAPER |
|---|---|---|---|---|
| BTC | 4 | $9.76 | 347.8 | $0.0281 |
| ETH | 15 | $13.11 | 1,395.7 | $0.0094 |
| Oct 14 | 9 | $11.33 | 1,025.0 | $0.0111 |
| Oct 15 | 10 | $11.54 | 718.5 | $0.0161 |

A further 4 BTC cycles failed to open (BTC open interest was full) and cost nothing.

## The 3 liquidations

| When (UTC) | Cycle | What happened | Net |
|---|---|---|---|
| Oct 14 18:59 → Oct 15 02:59 | BTC | The Mac was asleep, so the bot couldn't close at the target. Price kept going, a leg was liquidated at 02:24, and the survivor was closed when the bot woke at 02:59 | −$8.07 |
| Oct 14 22:08 → Oct 15 03:00 | ETH | Same sleep. A leg was liquidated at 02:23; the survivor had kept running and closed in profit | +$2.54 |
| Oct 15 12:29 → 12:46 | ETH | ETH fell 1.2% in under a minute. The bot sent the close at 68 bps, but it didn't execute for 16 min; the long was liquidated at 12:32 | −$5.92 |

Fixes since: the bot keeps the Mac awake while running; failed close orders retry in ~2 s; the log is saved to `logs/run-*.log`; and the settings for the next run are 50× with $20 legs, which puts liquidation ~195 bps away instead of ~95.

## Staking

- First stake: 1,025 PAPER on Oct 14. On Oct 19, all 1,743 PAPER were restaked together.
- Rewards claimed so far: **$1.38** over 13 claims.

Total paid to all stakers per day (the yield pool):

| Day | Paid to stakers |
|---|---|
| Oct 10 | $1.82M |
| Oct 11 | $3.23M |
| Oct 12 | $3.82M |
| Oct 13 | $4.94M |
| Oct 14 | $5.94M |
| Oct 15 | $4.60M |
| Oct 16 | $0.67M |
| Oct 17 | $1.89M |
| Oct 18 | $1.11M |

At the last full day's payout and 8.70B PAPER staked, a PAPER earns about **$0.00013/day**, so your 1,743 PAPER earn roughly **$0.22/day**. Three days earlier it was about $0.00073/PAPER/day.

## Market conditions now

- Mint rate: **10.6 PAPER per $1 lost** (it was ~28 at launch and ~23.6 when live farming started; it falls as total losses across the protocol grow).
- At ~18% net cost per dollar of loss, new PAPER costs about **$0.017** each, which takes ~133 days of current yield to pay back.

## Simulations (no real money)

| Run | Setup | Cycles / pairs | Result | PAPER | Notes |
|---|---|---|---|---|---|
| Trade mode | 1000×, −30% stop, ride the winner | 37 pairs | −$86.98, 30% win rate | 4,339 | 6 liquidations; stops at 3 bps fill late |
| Trade mode | 100×, 30% stop / 30% take-profit | 5 pairs | −$5.81 | 294 | |
| Farm mode, 1 h | 100×, close at 60 bps | 6 cycles | −$3.87 | 536 | $0.0072/PAPER at the then mint rate |
| Farm mode, 1 h | 100×, close at 30 bps | 12 cycles | −$6.32 | 688 | $0.0092/PAPER |

Backtest (3.5 days of 1-minute candles): every trade-mode setting lost money on average at every leverage; the least bad was 100× / 30% / 30% at about −$0.23 per pair. Farm mode at 100×:

| Close at | Cycles/day | Avg minutes | $/PAPER (at 23.6/$) |
|---|---|---|---|
| 20 bps | 59 | 23 | 0.0139 |
| 30 bps | 32 | 44 | 0.0111 |
| 40 bps | 18 | 77 | 0.0096 |
| 60 bps | 8.7 | 156 | 0.0082 |
| 80 bps | 4.8 | 270 | 0.0074 |

Cost per PAPER depends only on the size of the move, not the leverage (50× and 100× were identical).

## Current settings (for the next run)

`LEVERAGE=50`, `MARGIN_PER_LEG_USD=20`, `FARM_MOVE_BPS=60`, `MAX_CONCURRENT_PAIRS=2`, `FARM_BUDGET_USD=63` (lifetime, so about $40 of new farming). The bot is not running; the Hetzner deployment is prepared in `deploy/` but not set up.
