// Selective Runner: a paper-trading bot for the pump.fun replay harness.
//
// Idea, in one line: most new coins bleed out, a few run far — so buy early and
// cheap, hold for a big move or cut the loss, and never let a dead coin block a
// slot forever.
//
// Entry: a coin is considered once, on the first batch where its real SOL reserve
// reaches ENTER_REAL_SOL (1 SOL — early, while the price is still low). If a
// position slot is free and cash covers the stake, buy STAKE_LAMPORTS (or the
// harness size cap, whichever is smaller, but never below the guardrail's
// 0.01 SOL round-trip minimum). A coin that is skipped — slots full, cap too
// small, reserve never reaches the bar — is never revisited. No second entries,
// no averaging down.
//
// Exit, whichever comes first:
//   - Take profit: the price doubles from the fill price — sell everything.
//   - Stop loss: the price falls to 70% of the fill price — sell everything.
//   - Stale: the coin has not traded for STALE_SLOTS slots — its price is frozen,
//     so holding it only blocks a slot; sell it and move on.
// The harness closes positions itself when a curve completes or the replay ends,
// which is where the biggest wins come from: a coin that completes pays several
// times the stake, so the bot lets winners run to completion instead of cutting
// them on a small pullback.
//
// Prices are compared as scaled integers (no floats), and the bot reads no clock,
// environment, or randomness, so two runs produce byte-identical action logs.

import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, Fill, OrderInput } from './vendor/makefun-bot.ts';

/** Fixed stake per coin: 0.02 SOL. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 50n;
/** A coin must have this much real SOL in its curve before we touch it. */
const ENTER_REAL_SOL = LAMPORTS_PER_SOL;
/** Smallest buy that counts as a guardrail round trip: 0.01 SOL. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Take profit at this multiple of the fill price (2x). */
const TP_NUM = 2n;
const TP_DEN = 1n;
/** Stop loss at this share of the fill price (70%). */
const SL_NUM = 70n;
const SL_DEN = 100n;
/** Sell a held coin that has not traded for this many slots. */
const STALE_SLOTS = 20_000;
/** Never let a fill be refused for the price moving during the 2-slot latency. */
const MAX_SLIPPAGE_BPS = 10_000;
/** Price scale: price per token in lamports, multiplied by this. */
const SCALE = 1_000_000n;

/** Price of one token, scaled by SCALE, from a curve's virtual reserves. */
function scaledPrice(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * SCALE) / virtualToken;
}

interface CoinTrack {
  /** Decided (bought or skipped): never reconsider this coin. */
  decided: boolean;
  /** Scaled price per token paid on the fill (fees included); 0n until filled. */
  entryPx: bigint;
  /** A sell for this coin is in flight; do not send another. */
  sellPending: boolean;
}

const tracks = new Map<string, CoinTrack>();
let buysSent = 0;
let sellsSent = 0;

function track(mint: string): CoinTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = { decided: false, entryPx: 0n, sellPending: false };
    tracks.set(mint, t);
  }
  return t;
}

/** Fold a batch's fills into our per-coin tracking. */
function applyFills(batch: Batch, state: BotState): void {
  for (const f of batch.fills as Fill[]) {
    if (f.client_id.startsWith('_')) {
      // A harness close (complete / flatten / writeoff): the position is gone.
      tracks.delete(f.mint);
      continue;
    }
    const t = tracks.get(f.mint);
    if (t === undefined) continue;
    if (f.side === 'buy') {
      if (f.status === 'filled') {
        const tokens = BigInt(f.token_amount);
        const quote = BigInt(f.quote_lamports);
        t.entryPx = tokens > 0n ? (quote * SCALE) / tokens : 0n;
      } else {
        // Rejected or failed: the coin is done for us; never retry it.
        t.entryPx = 0n;
      }
    } else if (f.side === 'sell') {
      if (f.status === 'filled') {
        // Position closed, but the coin stays decided: never buy it again.
        t.entryPx = 0n;
        t.sellPending = false;
      } else {
        // Rejected or failed: the position is still ours, try again next batch.
        t.sellPending = false;
      }
    }
  }
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    applyFills(batch, state);
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();

    // Exits first: take profit, stop loss, or stale — whichever comes first.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tracks.get(mint);
      if (t === undefined || t.sellPending) continue;
      if (t.entryPx <= 0n) continue; // Buy still in flight: nothing to exit.
      const price = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0n) continue;
      const takeProfit = price * TP_DEN >= t.entryPx * TP_NUM;
      const stopLoss = price * SL_DEN <= t.entryPx * SL_NUM;
      const stale = state.slot - curve.reserves_slot >= STALE_SLOTS;
      if (takeProfit || stopLoss || stale) {
        if (orders.length >= cap) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        t.sellPending = true;
        sellsSent += 1;
      }
    }

    // Entries: coins whose real reserve first reaches the bar.
    let free = state.freeCashLamports();
    for (const [mint, curve] of state.curves) {
      if (orders.length >= cap) break;
      if (curve.complete) continue;
      const t = track(mint);
      if (t.decided) continue;
      if (curve.real_quote_reserves < ENTER_REAL_SOL) continue;
      // First sighting at or above the bar: decide now, whatever happens.
      t.decided = true;
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
      const sizeCap = state.maxBuyLamports(mint);
      const amount = sizeCap < STAKE_LAMPORTS ? sizeCap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      free -= amount + txFee;
      buysSent += 1;
    }

    return orders;
  },

  onDone(state: BotState): void {
    console.error(
      `done: cash=${state.cash} buys=${buysSent} sells=${sellsSent} tracked=${tracks.size}`,
    );
  },
});
