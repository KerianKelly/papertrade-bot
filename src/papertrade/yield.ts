// Live PAPER staking yield: how much USDC a staked PAPER earned per day recently.
// Source: /query/house/staker-payouts (cumulative USD by day) and /query/protocol/summary (staked supply).

import { createPublicClient, http, parseAbi } from 'viem';
import { ADDR, URLS } from '../constants.ts';
import { getJson } from './api.ts';

export interface PaperYield {
  perPaperPerDay: number;  // USD
  lastFullDayUsd: number;  // total paid to stakers on the last complete day
  stakedPaper: number;
  mintRate: number;        // PAPER per $1 of loss right now
  at: number;
}

export async function paperYield(): Promise<PaperYield> {
  const [p, s] = await Promise.all([
    getJson<{ points: [number, number][] }>('/query/house/staker-payouts?interval=1d'),
    getJson<{ paper: { staked: string; trackedLp: string; tailProgress: string } }>('/query/protocol/summary'),
  ]);
  const pts = p.points;
  // points are cumulative; the last point is today (partial), so use the last complete day's increment.
  const lastFullDayUsd = pts.length >= 3 ? pts[pts.length - 2][1] - pts[pts.length - 3][1] : pts.length === 2 ? pts[1][1] - pts[0][1] : 0;
  const stakedPaper = Number(BigInt(s.paper.staked) / 10n ** 12n) / 1e6;
  const tracked = Number(BigInt(s.paper.trackedLp) / 10n ** 12n) / 1e6;
  const tail = Number(BigInt(s.paper.tailProgress) / 10n ** 12n) / 1e6;
  const mintRate = tracked < 2e6 ? 100 : 100 * (120e6 / (120e6 + tail)) ** 2;
  return { perPaperPerDay: stakedPaper > 0 ? lastFullDayUsd / stakedPaper : 0, lastFullDayUsd, stakedPaper, mintRate, at: Date.now() };
}

/** USDC staking rewards distributed to `user` but not yet claimed (PaperStaking.pendingReward). */
export async function pendingRewards(user: `0x${string}`): Promise<number> {
  const client = createPublicClient({ transport: http(URLS.rpc) });
  const v = await client.readContract({
    address: ADDR.paperStaking, abi: parseAbi(['function pendingReward(address) view returns (uint256)']),
    functionName: 'pendingReward', args: [user],
  });
  return Number(v) / 1e18;
}
