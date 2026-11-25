# Pump.fun Bot Sprint — Traction Rider

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/e0426685-cloud/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/e0426685-cloud/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
competition on make.fun. It trades paper SOL on a replay of pump.fun bonding-curve
events and is ranked on net PnL. No real trades, no on-chain spend.

## Strategy

Most new pump.fun coins bleed out; a small few run far. This bot waits for proof of
traction instead of guessing at launch:

- **Enter once, on traction.** A coin becomes a candidate only when its real SOL
  reserve first reaches 5 SOL — real buyers have already put money in. It then buys
  a fixed 0.05 SOL stake (capped by the harness's 1%-of-real-reserve order cap),
  at most 5 positions open at once, one entry per coin.
- **Ride the run with a trailing stop.** After entry it tracks the highest price the
  coin has printed since the fill and sells everything when the price falls 15%
  below that peak. Winners are left to run; losers are cut at roughly −15% from
  their peak instead of being held to zero.
- **Never chase, never average down.** A coin that is skipped (slots full, or its
  reserve never reaches 5 SOL) is never revisited. No shorts, no leverage.

All decisions use only the replay events delivered in each batch. Prices are
compared with integer math, and the bot reads no clock, environment, or randomness,
so two runs produce byte-identical action logs.

## Files

- `main.ts` — the bot (Node 22, stdlib only, runs as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim, vendored unchanged.

## Local grading

With the competition kit unpacked at `<kit>`:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Dev-window result (kit's published 24 h dev data, process driver): see the commit
history for the graded numbers. Guardrails to meet: at least 20 distinct coins
with round trips of ≥ 0.01 SOL each, and max drawdown ≤ 50%.

## License

MIT — see [LICENSE](LICENSE).
