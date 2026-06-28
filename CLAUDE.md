# CLAUDE.md — Mission & Operating Instructions

> **This doc is process-only.** All numbers — the copy-strategy leaderboard, per-strategy
> n/net/drop3, "currently best" strategy — live in `copy-trades.json` on the `bot-status`
> branch and in the copy journals under `docs/`, not here. The doc tells you *how* to run the
> loop; the data tells you *what* to do this cycle.

## MISSION

Build a profitable **copy-trading** bot on post-graduation PumpFun tokens — mirror the entries of
profitable smart wallets, fast enough and cheaply enough to accumulate SOL after real execution
costs.

The open research question:

> Which copy-strategy configuration (which wallets to follow, entry gating, exit rules, sizing)
> **accumulates SOL** under realistic execution (5s entry delay, round-trip cost + slippage), on
> n ≥ 100 trades, with the edge surviving the removal of its top 3 winners and clearing the
> monthly run-rate bar?

The bot is free to hypothesize, test, and adopt new copy strategies. Beat the bar (below), survive
the outlier check, and never claim victory on small n, on the idealized mirror, or on
outlier-driven means.

The human operator is the code-review and deploy loop — they don't write code, screenshot
dashboards, or query the database. Claude self-serves all data via the `bot-status` branch.

> **The graduation-arbitrage research line is retired.** The old T+30 "buy the graduation, filter on
> public chart features" thesis was exhausted (~150 strategies / 32k paper trades, net −935 SOL —
> see `docs/research-archive/`). Its code (the `StrategyManager` book, the filter/exit-sim/price-path
> panels, the research dashboards) was removed. Do **not** revive it without explicit operator
> direction. Graduation *detection* stays alive — it seeds copy-trade wallet discovery and defines
> the copyable token universe.

---

## WHERE STATE LIVES (READ THIS FIRST)

| Question | Source on `bot-status` (or `docs/`) |
|---|---|
| How is every copy strategy doing? (the scoreboard) | `copy-trades.json` → `promotion.rows`, `by_strategy`, `paired_vs_baseline`, `lead_performance` |
| Which wallets are scored / promotable? | `wallet-leaderboard.json` |
| Does smart-money token *selection* carry edge? | `smart-money.json` |
| Copy-follower detection latency + recent lead events | `copy-probe.json` |
| Live-money execution health (land rate, slippage, Jito spend) | `live-execution.json`, `live-training.json` |
| What did yesterday's review decide? Day/week trends? | `docs/copy-trade-journal.md` (newest-first) |
| What's been tried and why? (lineage) | `docs/copy-strategy-lab.md` (lab ledger) |
| Is the bot healthy / detecting graduations? | `diagnose.json`, `snapshot.json` |
| Parked graduation-arb research findings | `docs/research-archive/` |

The pattern: every cycle, read `copy-trades.json` + the two `docs/` journals first, form a
hypothesis from the data, then act. CLAUDE.md only tells you the rules of the game.

---

## PROMOTION BAR (copy-specific)

A copy strategy is **PROMOTABLE** only when ALL of these clear (computed for you in
`copy-trades.json → promotion`):

| Gate | Meaning |
|---|---|
| `realistic_execution: true` | Judged on the `-lag` twin (5s entry delay), never the idealized 1:1 mirror |
| `n_trades ≥ 100` | Enough sample |
| `total_net_sol_drop_top3 > 0` | Edge survives removing its best 3 trades (not a lottery ticket) |
| `exit_stress > 0` | Holds up under the exit-stress penalty |
| `monthly_run_rate_sol ≥ 3.75` | ≈ $300/mo — covers AI/infra cost |

**The idealized mirror is an UPPER BOUND only.** A strategy with no `entryDelaySec` fills at the
optimistic ~1.1s snapshot; its score caps at 80 and it is never a live candidate. Always judge real
edge on the `-lag` twin.

---

## COPY STRATEGIES ARE CODE-DEFINED

Unlike the retired T+30 book, the copy roster lives in **`COPY_STRATEGIES` in
`src/copytrade/copy-trader.ts`**, not in any JSON. Killing or adding a copy strategy is a **code
edit → push to the dev branch → redeploy**, not a `strategy-commands.json` command (that apparatus
was removed). The routine skills therefore only **propose** roster changes; execution is a separate,
operator-approved code edit. Phrase every recommendation in proposal voice ("recommend killing X",
"propose adding Y") — never past tense.

---

## THE ITERATION LOOP

Two routine skills drive the loop; both are self-serve and write to `docs/`:

- **`/copy-daily-report`** (daily) — reads `copy-trades.json`, compares to yesterday, decides
  keep/kill/promote/add per strategy against the bar, records day-over-day + week-over-week trends,
  and appends a dated entry to `docs/copy-trade-journal.md`.
- **`/copy-strategy-lab`** (weekly) — reads the data + trends + lab ledger, updates the incumbent
  best strategy, resolves matured experiments, and spawns ONE new hypothesis (mostly a variant of
  the current best, occasionally a new dimension) to hill-climb toward a promotable strategy.
  Records lineage in `docs/copy-strategy-lab.md`.

Each cycle: fetch live state → pick the next hypothesis from the data → make the code edit OR
journal the proposal → push to the dev branch → bot redeploys and collects data → repeat. Assume
bugs exist until `diagnose.json` says healthy.

---

## ARCHITECTURE (the copy subsystem, `src/copytrade/`)

- **`worker.ts`** (`CopytradeWorker`) — background wallet discovery + scoring. Seeds candidates from
  graduation data (firstbuyer / dev / creator wallets, competition signals), scores a small
  RPC-budgeted batch on a slow interval via the shared `globalRpcLimiter`. Default-ON
  (`COPYTRADE_DISABLED=true` to stop). Research only — never trades.
- **`follower-probe.ts`** (`CopyFollowerProbe`) — subscribes to the smart watchlist via Helius
  `transactionSubscribe` (its own WS). Parses lead swaps and fires `copyTrader.onLeadBuy/onLeadSell`.
- **`copy-trader.ts`** (`CopyTrader`) — the shadow engine + live-micro interface. Gates entries
  (regime, macro, lead rank, consensus, conviction, daily-loss cap), opens positions, polls to exit
  per the strategy config. `COPY_STRATEGIES` lives here. Default-ON shadow (`COPY_TRADER_DISABLED`).
- **`copy-live-executor.ts`** (`CopyLiveExecutor`) — real-swap wrapper for `live_micro` strategies.
  Opt-in via `COPY_LIVE_ENABLED=true` + funded wallet. Routes through the shared `trading/executor`.
- **`copy-regime.ts` / `macro-regime.ts`** — the two 1–10 entry-gate scores (copy-book tailwind /
  crypto-macro tailwind). `macro-regime` reads `market_daily` (populated by `MarketDataFetcher`).
- **`smart-money.ts`**, **`leaderboard.ts`**, **`ranker.ts`**, **`wallet-pnl.ts`**,
  **`discovery.ts`**, **`parse-swap.ts`**, **`predictors.ts`**, **`queries.ts`** — discovery,
  scoring, ranking, and analysis helpers.

The shared low-level execution core stays in `src/trading/` (`executor`, `wallet`, `jito`,
`pumpswap-swap`, `safety`, `buy-retry`, `sell-retry`, `config`, `pool-resolver`, `token-2022`).

---

## RPC POSTURE

The single biggest historical RPC sink — the per-graduation T+30..T+600 price-path snapshots — is
**OFF by default** now (copy doesn't use it). Graduation *detection* and the cheap wallet-discovery
enrichment (early buyers @ T+10, firstbuyer + buy-pressure @ T+35, dev/creator wallets) stay ON
because copy discovery seeds from them. To revive full price-path research collection set
`GRADUATION_PRICE_PATH_ENABLED=true`; to drop wallet enrichment too set
`GRADUATION_COLLECTION_DISABLED=true` (detect-only). Copy work and detection share
`globalRpcLimiter` (copy has its own priority tier).

---

## OPERATIONAL CONSTANTS (rare changes)

- **Copy entry**: at the lead's detected buy, on the graduated PumpSwap pool, gated by the strategy
  config. Realistic strategies add `entryDelaySec` (5s) to model detection + fill latency.
- **Price source**: PumpSwap pool vault reads (never bonding curve).
- **Position polling**: `COPY_POLL_MS` (25s) with velocity-gated hot-poll (`COPY_HOT_POLL_MS`, 2s).
- **Round-trip cost**: `SIM_DEFAULT_COST_PCT` (`src/api/sim-constants.ts`) — shared with wallet
  scoring so "what we'd net copying" is consistent.
- **Live sizing**: `MICRO_TRADE_SIZE_SOL` (0.05) + `WALLET_SOL_BUFFER`, daily circuit-breaker
  `DAILY_MAX_LOSS_SOL`. Live is opt-in (`COPY_LIVE_ENABLED`).
- **Monthly target**: ~3.75 SOL net per month per live strategy (~$300/mo infra).

---

## SELF-SERVICE DATA ACCESS

**Rule:** Claude self-serves all bot data via the `bot-status` branch on GitHub. The operator does
NOT screenshot dashboards, query the DB, or pull Railway logs.

- **Method 1 (preferred):** `mcp__github__get_file_contents` with `owner=50thycal`,
  `repo=solana-graduation-arb-research`, `ref=refs/heads/bot-status`, `path=<file>.json`.
- **Method 2 (fallback):** `curl -sL https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/refs/heads/bot-status/<file>.json` (use curl, not WebFetch — WebFetch summarizes large files).

`copy-trades.json` is large — fetch with curl + parse the slice you need with `python3`.

Files published every ~2 min: `diagnose.json`, `snapshot.json`, `copy-trades.json`,
`wallet-leaderboard.json`, `smart-money.json`, `copy-probe.json`, `live-training.json`,
`live-execution.json`, plus the self-serve infra files `logs.json` and `bot-errors.json` (below).

**Do NOT WebFetch the Railway deployment URL — it returns 403.**

### Quick logs & errors (snapshot, on the 2-min sync)
- `logs.json` — tail of the **in-process** log buffer (all levels) + a retained warn/error slice.
- `bot-errors.json` — `last_error` + the 20 most recent `bot_errors` rows.

These are convenient but in-process only: they **cannot** capture native crashes, OOM `SIGKILL`s,
or stderr (the process dies first). For those, use the Railway Logs workflow below.

### On-demand Railway logs + DB queries — self-serve via the `ops` branch
The real diagnostic path, and **fully self-serve (no operator click)**. Claude can READ GitHub
Actions runs but **cannot dispatch** `workflow_dispatch` workflows — the Claude GitHub App has no
`actions:write` scope by design, so `mcp__github__actions_run_trigger` (and a raw dispatch curl)
return 403. Instead, **push a request to the `ops` branch** and the run fires automatically:

1. Overwrite **`ops/request.json`** on the **`ops`** branch and push it. **Do NOT put `[skip ci]` in
   the commit message** — it suppresses the trigger. Shapes:
   - `{"type": "logs", "limit": 200, "filter": "", "deployment_id": ""}`
   - `{"type": "db", "sql": "SELECT ...", "max_rows": 200}`
2. The push fires the **`Ops Runner`** workflow (`.github/workflows/ops-runner.yml`, which lives
   ONLY on `ops` — it never touches `main` or redeploys Railway) and **commits the result to
   `ops/result.txt`**.
3. Read it back over plain git, ~60s later:
   `git fetch origin ops && git show origin/ops:ops/result.txt`

Under the hood (both reuse the read-only guards in their scripts):
- **Logs** → `scripts/railway_logs.py` pulls the **actual platform logs** (crashes, restarts, exit
  codes, stderr) via Railway's GraphQL API — what the in-process `logs.json` cannot capture.
- **DB** → `scripts/db_query.py` POSTs to the bot's authenticated `POST /api/db-query`, which runs
  the statement in an **isolated child process** on a read-only SQLite connection (writes rejected).

The same two jobs also exist as **manually-triggerable** workflows on `main` (`Railway Logs`,
`DB Query (read-only)`) for a human "Run workflow" click. Full setup + secrets in
**`docs/REMOTE_ACCESS.md`** (`RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
`RAILWAY_SERVICE_ID`, `DB_QUERY_URL`, `DB_QUERY_TOKEN` as Actions secrets + `DB_QUERY_TOKEN` on the
service).

> The legacy `db-query.json` → `db-query-results.json` channel (queries over the `bot-status`
> branch) is **retired** — it coupled ad-hoc queries to the trading-critical sync loop. Use the
> `DB Query` workflow instead. The legacy `GET /api/*` views remain on the service (403 from Claude
> sessions; reachable from the workflows).

---

## YOUR ROLE AS CODING AGENT

Responsible for: writing/updating bot code (copy strategies, the copy subsystem, the kept dashboard
pages); keeping `copy-trades.json` + the `docs/` journals the source of truth; diagnosing bugs from
JSON alone; keeping the bot focused on the copy thesis; declaring an outcome
(PROMOTABLE / INVALID / WATCH / BLOCKED) when the data is sufficient.

NOT responsible for: running the bot (operator does that); enabling live execution without operator
sign-off.

Never declare victory on n < 100, on the idealized mirror, or on outlier-driven means.

---

## PULL REQUEST WORKFLOW (operator preference)

**As soon as a change is complete and builds (`npm run build` green), proactively open a GitHub PR
into `main` — do NOT wait to be asked.** The operator's deploy is gated on the PR existing (see
Deployment Flow below), so a finished change with no PR is just blocking the deploy. Opening the PR
is part of "done," not a follow-up step.

Use the GitHub MCP (`mcp__github__create_pull_request`) — `gh` is not available here. **One open PR
per branch** (new pushes update the existing PR; check `list_pull_requests` first). Don't open a PR
when there are no unmerged commits. Give it a clear title + body.

---

## DEPLOYMENT FLOW (how changes go live — read this before saying "you need to merge")

Railway auto-deploys this service **from the `main` branch** ("Branch connected to production" =
`main`, "Auto deploys when pushed to GitHub" = ON). The operator's loop is:

1. Claude does the work on the feature branch and opens **one** PR into `main`.
2. **The operator reviews and merges the PR.** This is their deliberate gate — *Claude never merges.*
3. **The merge to `main` IS the deploy trigger.** There is no separate deploy step; pushing `main`
   auto-builds and ships.
4. The operator watches the deploy and verifies the bot is healthy.

**Implication for Claude — do NOT nag about merging:** Once you've pushed the branch and opened/
updated the PR, your job is done. Hand off once ("PR is up, ready for you to merge — merging
auto-deploys `main`") and stop. A *running deploy means the PR is already merged*, so never tell the
operator "you still need to merge" after they've deployed. If you genuinely must report merge state,
**re-fetch first** (`git fetch origin main` + `git merge-base --is-ancestor <branch> origin/main`) so
the claim is fresh, never from earlier-in-conversation memory.

---

## BUG TRIAGE

When `diagnose.json` is not healthy, fix detection first (Level 1: is the bot running and detecting
graduations? WS connected, candidates flowing). The deeper price/label levels (2–4) are N/A in the
default enrichment-only mode. Then check the copy path: is `copy-probe.json` showing recent lead
events? Are positions opening + closing in `copy-trades.json`? Is `live-execution.json` land rate
healthy (rent failures = wallet-balance symptom, not a retry bug — see `docs/research-archive/`)?
