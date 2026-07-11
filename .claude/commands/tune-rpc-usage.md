---
description: Retune the copy subsystem's Helius credit-usage DEFAULTS to hit a desired credits/day target — reads current usage, maps drivers to code knobs, edits defaults, builds, and opens a PR.
argument-hint: "[target/day, e.g. 100k — default 100000]"
---

# /tune-rpc-usage — hit a Helius credits/day target by changing code defaults

Repeatable retune of the copy subsystem's Helius spend to a **desired credits/day target**
(`$ARGUMENTS`, default **100000**). It reads where credits are going, maps each driver to the
**code default** that controls it, changes those defaults to land on the target, verifies the build,
and opens a PR. The operator merges → `main` auto-deploys → the new rate takes effect.

> **Why edit code defaults, not Railway env vars?** The operator's Railway env is cleared, so the
> knobs below fall back to their **in-code defaults**. That makes the default the real lever — a
> retune is a code edit + PR, not an env change. Every knob stays env-overridable, so the operator
> can still hot-adjust any single value from Railway without a redeploy-from-code (just a restart).

> **Two spend surfaces, WS dominates.** Helius bills on (1) **LaserStream / Enhanced WebSocket** —
> per *delivered message*, historically ~⅔ of the bill — and (2) **RPC** — per *call*. The panel
> `copy-trades.json → rpc_usage` joins both. WS scales with **subscription firehoses** (winner
> pre-filter watch, follower watchlist size); RPC scales with **scoring volume** and **poll rate**.
> Cutting copy *strategies* frees ~0 (their polls dedupe by vault) — the real levers are the ones
> in the table below. See CLAUDE.md → RPC POSTURE.

---

## Step 0 — Parse the target

`TARGET = $ARGUMENTS` as credits/day (accept `100k`, `100000`, `3.75/mo`→ not here — this is /day).
Default **100000**. Monthly ≈ `TARGET × 30`. Note whether the intent is **cut down** (current >
target) or **use headroom** (current << target → propose loosening knobs, see Step 5b).

## Step 1 — Read current usage (two sources, reconcile them)

**A) Live panel (fast, resets on each deploy)** — fetch `rpc_usage` from bot-status:

```bash
curl -sL "https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/refs/heads/bot-status/copy-trades.json" \
  | python3 -c "import sys,json;u=json.load(sys.stdin)['rpc_usage'];print('est/day:',f\"{u['est_credits_per_day']:,}\");print('uptime_h:',round(u['uptime_sec']/3600,1),'warming_up:',u['warming_up']);[print(f\"  {t['source']:24}{t['transport']:4}{t['per_day']:>9,}/day {t['share_pct']:>5}%\") for t in u['top_drivers']]"
```

- **`est_credits_per_day`** is the number to drive to ≤ TARGET.
- **Warmup artifacts — do NOT be fooled:**
  - If `warming_up: true` **or** `uptime_sec` < `COPYTRADE_INTERVAL_MS`, **`wallet_pnl` is
    mis-extrapolated.** At low uptime the single boot-time scoring burst ÷ tiny window **over**-states
    wallet_pnl (we saw 191k/day at 0.9h uptime that settled to ~11k by 11.7h). Wait for
    `warming_up: false` before trusting the total, or mentally replace wallet_pnl with
    `burst_calls / (COPYTRADE_INTERVAL_MS in days)`.
  - The panel **over-counts `detection_grad_ws`** relative to the console (the `onLogs`
    migrations-only sub delivers cheaper/fewer billable messages than the per-message weight assumes).
    Treat detection as roughly its console share, not the panel's headline.

**B) Console CSV (ground truth, but cumulative)** — if the operator pasted a Helius
"usage top drivers / current credit cycle" CSV (columns `Breakdown, Credits, Share %` with
`LaserStream WebSocket / RPC / DAS` rows):

- It is **cumulative cycle-to-date** (only grows). A single CSV tells you the *mix*, not the daily
  rate. **Real daily rate = (TOT_now − TOT_prev) ÷ elapsed_days** across two snapshots.
- The cumulative total lags reality after a retune — a cycle that already banked millions at the old
  rate won't visibly bend for days. **Judge the retune by the daily delta + the live panel, never the
  running total.** A near-flat WS delta after cutting a WS firehose = success.

Report: current est/day (both sources), the **top 3–5 drivers**, and how far over/under TARGET.

## Step 2 — The lever table (driver → code default)

Each row: the driver as it appears in `rpc_usage.top_drivers`, the file + constant that sets its
default, the current default, its env override, and its tier. **Cut from the top (discovery/research)
before touching the core copy path; NEVER cut detection.**

| Driver (source) | Transport | Tier | File · constant | Current default | Env override |
|---|---|---|---|---|---|
| `discovery_prefilter_ws` | WS | **Discovery — cut 1st** | `winner-prefilter.ts` · `start()` gate + `PREFILTER_CFG.maxWallets` | **OFF** (opt-in `PREFILTER_DISABLED=false`); cap 60 | `PREFILTER_DISABLED`, `PREFILTER_MAX_WALLETS` |
| `winner_buyers`, `winner_label` | RPC | **Discovery — cut 1st** | `winner-sniper.ts` · `start()` gate | **OFF** (opt-in `WINNER_SNIPER_DISABLED=false`) | `WINNER_SNIPER_DISABLED` |
| `wallet_pnl` | RPC | **Scoring — research** | `worker.ts` · `DEFAULTS.intervalMs / scoreBatchLimit / deepBatchLimit / refreshBatchLimit` | 24h / 20 / 0 / 15 | `COPYTRADE_INTERVAL_MS`, `COPYTRADE_SCORE_BATCH`, `COPYTRADE_DEEP_BATCH`, `COPYTRADE_REFRESH_BATCH`, `COPYTRADE_MAX_SIGS` |
| `copy_poll` + `exec` | RPC | **Copy path — throttle** | `copy-trader.ts` · `POLL_INTERVAL_MS`; `HOT_POLL_MS` | 240000 ms; **0 (hot-poll off)** | `COPY_POLL_MS`, `COPY_HOT_POLL_MS` |
| (open-position count) | RPC | **Copy path — throttle** | `copy-trader.ts` · `MAX_CONCURRENT_PER_STRATEGY` | 40 | `COPY_MAX_CONCURRENT` |
| `copy_follower_ws` | WS | **Copy path — trim carefully** | `follower-probe.ts` · `WATCHLIST_MAX` / `WATCHLIST_SOURCE_RESERVE` | 40 / 5 | `COPY_WATCHLIST_MAX`, `COPY_WATCHLIST_SOURCE_RESERVE` |
| `probe_blocktime` | RPC | **Telemetry — safe to zero** | `follower-probe.ts` · `LAGFILL_SAMPLE` | **0 (off)** | `COPY_LAGFILL_SAMPLE` |
| `detection_grad_ws`, `grad_listener`, `competition` | WS+RPC | **Detection — NEVER cut** | graduation listener / enrichment | on | `GRADUATION_COLLECTION_DISABLED` (detect-only, last resort) |
| `metadata`, `holder_enrich` | RPC | Enrichment — tiny | metadata fetcher | on | `COPYTRADE_META_DISABLED` |

**How each knob scales spend (for sizing the change):**
- **WS firehoses** (`discovery_prefilter_ws`, `copy_follower_ws`) scale ~linearly with the number of
  watched wallets — but message rate is bursty/activity-dependent, so real reduction often *beats*
  linear. `discovery_prefilter_ws` was ~51% of the whole bill; turning it off is the single biggest
  lever by far.
- **`wallet_pnl`** ≈ `scoreBatchLimit × ~maxSigs` calls per pass × passes/day (`86400s ÷ intervalMs`),
  plus cheap incremental refreshes. Longer interval + smaller batch cut it multiplicatively. Deep
  rescans (`deepBatchLimit`, 1500 sigs each) are the priciest per-wallet — zero them first.
- **`copy_poll` + `exec`** scale with `open_positions × (1 ÷ POLL_INTERVAL_MS)`. Both ride the same
  poll, so slowing `COPY_POLL_MS` cuts them together; `HOT_POLL_MS>0` adds 2s bursts on near-trigger
  movers (only worth it with live trading on).

## Step 3 — Build the plan to hit TARGET

1. Start a per-driver budget from the current (warmup-corrected) `top_drivers`.
2. **Reserve the detection floor** (`detection_grad_ws` + `grad_listener` + `competition`) — it's
   fixed and non-negotiable (core mission).
3. Fill the remaining `TARGET − detection_floor` biggest-first, cutting **discovery → scoring →
   copy-poll → watchlist** in that order, only as deep as needed. Compute the projected est/day for
   each proposed default and stop once projected total ≤ TARGET (leave ~10–20% margin for
   activity/redeploy variance — each redeploy triggers one extra scoring burst).
4. Write the plan as a table: driver · old default → new default · projected /day. State the
   **tradeoffs** honestly (e.g. slower poll = coarser shadow-exit detection; smaller watchlist =
   narrower lead coverage; discovery off = wallet pipeline paused — all acceptable as *research*,
   and the promotion bar judges on the `-lag` twin regardless).

## Step 4 — Apply as code defaults

Edit the defaults in the files from Step 2 (change the literal fallback in each `process.env.X || 'N'`
or the `DEFAULTS`/`*_CFG` object; keep the env var as the override). Leave a dated one-line comment on
each change explaining the retune + the reasoning, matching the existing comment style in those files.
Refresh the `reference_cycle_from_console` note in `src/utils/usage-tracker.ts` with the latest CSV
mix + the new target so the panel documents current ground truth. Then:

```bash
npm run build   # must exit 0 (if node_modules lacks typescript, `npm install` first — CI uses pinned ^5.5)
```

Commit to the dev branch, push, and open **one** PR into `main` (check `list_pull_requests` first;
update the existing PR if one is open). Title: `copytrade: retune defaults to <=Xk Helius credits/day`.
Body: the Step-1 current state, the Step-3 plan table, tradeoffs, and the Step-5 verification plan.
**Do not merge** — the operator's merge is the deploy trigger.

## Step 5a — Verify after deploy (cut case)

Once merged + redeployed and uptime > `COPYTRADE_INTERVAL_MS` (so no wallet_pnl warmup artifact):
- Panel `rpc_usage.est_credits_per_day` should settle ≤ TARGET; confirm the cut drivers dropped/vanished.
- On the next operator CSV, the **daily delta** `(TOT_now − TOT_prev) ÷ days` should be ≤ TARGET, with
  the WS delta near-flat if a WS firehose was cut. (Cumulative total stays high for days — ignore it.)

## Step 5b — Use headroom (loosen case)

If current est/day is well **under** TARGET, don't cut — propose **buying back fidelity/coverage** up
to TARGET, cheapest-value-first: lower `COPY_POLL_MS` (sharper shadow exits) → raise
`COPY_WATCHLIST_MAX` (wider leads) → speed up scoring (`COPYTRADE_INTERVAL_MS` down / batch up) →
re-enable discovery **carefully** (`WINNER_SNIPER_DISABLED=false` + `PREFILTER_DISABLED=false` with a
**small** `PREFILTER_MAX_WALLETS` — that WS watch was the original firehose). Recompute the projected
total after each and stop before TARGET. The operator can apply these as Railway env overrides (restart,
no code change) or as new defaults via the same PR flow.

---

**Reference — the 2026-07-09 retune** (1.26M → ~17.5k/day real, target 100k): prefilter OFF (−650k),
winner-sniper OFF (−21k), scoring 4h/75/3/30 → 24h/20/0/15 (−160k), watchlist 140→40 (−58k WS),
poll 25s→240s + hot-poll off (−300k), lagfill off. The WS firehose kill (prefilter) did most of it.
