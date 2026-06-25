# solana-graduation-arb-research

Copy-trading bot for post-graduation PumpFun tokens: it detects graduations, discovers and scores
profitable smart wallets, and shadow- (and opt-in live-) copies their entries, hill-climbing toward
a strategy that accumulates SOL after realistic execution costs.

The repo began as a graduation-arbitrage research tool (buy the graduation, filter on public chart
features). That line was exhausted and removed; its findings are preserved in
[`docs/research-archive/`](docs/research-archive/). See [`CLAUDE.md`](CLAUDE.md) for the mission and
operating loop.

## Quick start

```bash
npm install
npm run build          # tsc -> dist/
npm start              # node dist/index.js
npm run dev            # ts-node src/index.ts
```

Configuration lives in `.env` (see `.env.example`). Graduation price-path collection is OFF by
default (copy trading doesn't need it); set `GRADUATION_PRICE_PATH_ENABLED=true` to revive it.
