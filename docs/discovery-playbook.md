# Discovery Playbook — how to test a new "find wallets to copy" thesis

The copy bot's biggest open lever is **wallet discovery**: which pipeline surfaces the leads we
copy. This playbook makes testing a new discovery thesis a **one-row change plus a harvester**,
with standardized measurement — no bespoke wiring, no bespoke reporting.

Framework code: `src/copytrade/discovery-sources.ts`. Live results: `copy-trades.json →
discovery_scorecard` (and the "Discovery scorecard" card on `/copy-trades`).

---

## The contract (why every thesis is measured the same way)

Every discovery source gets the **identical standardized probe** so sources are comparable:

- **Probe strategy** `copy-src-<id>`: realistic execution (5s entry delay + 10% drift skip),
  TP100/SL30, **no lead-quality gate** — a hotlead/consensus gate would confound *source quality*
  with *lead selection*. The probe answers exactly one question: "do the wallets THIS pipeline
  finds make money when copied, as a population?"
- **Quarantine**: a wallet fires only the strategies matching its `wallet_candidates.source` tag,
  so each source's P&L series is isolated (a wallet is in exactly one source).
- **Watchlist (2026-07-04, load-bearing)**: the follower probe subscribes the source smart sets
  too (`refreshSourceSets` union in `follower-probe.ts`). A wallet that is routed but not
  subscribed can never fire a lead event — this exact gap kept every `copy-src-*` probe at n=0
  for 4 days after the 07-03 gate relaxation (25 smart+copyable wallets, 0 watched). If a probe
  sits at n=0 with a non-empty funnel, check watchlist membership FIRST. Source-only wallets are
  tier-tagged `src_<id>` in `copy_probe_events`, and the consensus/crowd counts
  (`countRecentSmartBuyers/Sellers`) exclude those tiers so widening the watchlist never perturbs
  existing strategies' series. Each set is capped best-first (`COPYSRC_WATCH_CAP`, default 25;
  winner-sniper: `WINNER_SNIPER_WATCH_CAP`) because Helius bills WS per delivered message.
- **Control** `copy-tp100-sl30-lag`: the same ruleset on OG (graduation-seeded) wallets.
  ⚠ This strategy has a standing KILL proposal in the daily journal for its own P&L — it must
  survive as the scorecard control (or the scorecard needs a replacement control first).
- **Verdict** (auto-computed, at n≥100 per side): the probe must beat the control on **both**
  net/trade **and** drop3/trade → `BEATS_OG`, else `FAILS`. Before that: `COLLECTING`, or
  `NO_WALLETS` if the funnel never produced a smart+copyable wallet (a funnel problem, not a
  P&L problem — fix the harvester or the gate, don't wait).

Idealized (1.1s) probes are banned — killed 2026-07-02. A source that only works at snapshot
latency can never feed a promotable strategy, so measuring it idealized just wastes a slot.

## To add a new discovery thesis (3 steps)

1. **Write the harvester.** Any module that surfaces candidate wallets and inserts them:
   `INSERT OR IGNORE INTO wallet_candidates (address, first_seen, source) VALUES (?, ?, '<id>')`
   with a **new, distinct `source` tag**. Wire its refresh wherever fits (worker tick, probe
   event, its own interval — see `live-tape-harvester.ts` / the external seed in `worker.ts`
   for patterns). The shared scorer picks candidates up automatically; no scoring code.
2. **Register the source.** Add one row to `DISCOVERY_SOURCES` in
   `src/copytrade/discovery-sources.ts` (`id` = the source tag, plus label/hypothesis/date).
   This auto-creates the probe strategy, the quarantine routing, and the scorecard row.
3. **Push → deploy → watch `discovery_scorecard`.** Funnel first (candidates → scored →
   smart_copyable): if wallets aren't reaching `smart_copyable`, diagnose the funnel before
   reading P&L. Verdict resolves itself at n≥100.

To **kill** a thesis: delete its registry row (probe disappears from the roster; closed rows
stay in the DB → `retired_summary`) and stop the harvester. Record the outcome in
`docs/copy-strategy-lab.md`.

## Discipline

- **One probe per source, no variants** until a source `BEATS_OG`. Only then does it earn a
  hotlead/strict-style gated strategy on its wallets (that's a *lab* experiment, tracked in the
  lab ledger like any other).
- The scorecard is population-level. Per-wallet quality *within* a proven source is the lab's
  job (hotlead gates, the proven-bad veto), not the scorecard's.
- Funnel-empty ≠ thesis-dead: `NO_WALLETS` for weeks usually means the gate (money-edge +
  copyability) filters everything the pipeline finds — that IS a result worth journaling.

## Resolved so far (keep this list current)

| date | source / method | verdict | takeaway |
|---|---|---|---|
| 2026-07-02 | cotrade (winner-graph cohort split) | FAILS | n=108, net −4.5, drop3 −6.5 vs OG-smart control −0.9/−3.0 — clustering with winners doesn't select better copy leads |
| 2026-07-02 | copy-net positive selection (V2, not a source but a selector) | REFUTED OOS | in-sample +27 was circular; OOS its unique picks lost. Survives only as the proven-bad **veto** |
| — | live_tape (Idea 1) | COLLECTING | funnel healthy (13 smart+copyable of 409 scored, ~3%); probe sat n=0 until the 07-04 watchlist fix. Harvester itself is OPT-IN and currently off (`LIVE_TAPE_ENABLED` unset since ~07-01) — deliberate while the 1,100-wallet scoring backlog drains; the probe test runs on the already-scored set |
| — | external / Solana Tracker (Idea 3) | COLLECTING | funnel done (172/172 scored, 12 smart+copyable); probe sat n=0 until the 07-04 watchlist fix. Crowding prior stands; several of the 12 are days-dormant, so expect slow n |
| — | winner_sniper (operator thesis, S2+S3) | COLLECTING | added 2026-07-02: minute-cadence path labels (20×60s, WIN = peak ≥ +50% AND ≥3 checks above) × **full-window** buyer credit (0-30s ∪ sampled pool-vault swaps — any wallet in the ~20min, not just snipers), 36h-half-life decay (`winner-sniper.ts`); ~8-10k RPC/day. 07-04 (operator-directed): rebuilt as the **3-stage funnel** above — profit-credited hits → forward pre-filter across all of PumpSwap (`winner-prefilter.ts`) → scorer decides tradability. Expect NO_WALLETS to persist for a few days: wallets must now prove profit twice before the probe may trade them. Watch-item: 47/73 labels are winners (64% base rate) in this regime, so `minPrecision` 0.25 is currently non-selective — the pre-filter is the real anti-spray gate; recalibrate the label bar once probe P&L exists |

**Discovery-source gate (relaxed 2026-07-03):** source watchlists use PROFITABLE (`drop3 > 0`, no 3.75/mo bar — the monthly target is the AGGREGATE goal across all copied wallets) + hold ≥ 30s + the ~95% win-rate bot filter + PumpSwap-share. Env: `COPYSRC_MIN_DROP3`, `COPYSRC_MIN_HOLD_SEC`. The global core-book gate (`getSmartSetAddresses`) is UNCHANGED.

**Signal-set override (2026-07-04):** a registry row may set `signalSet: (db) => string[]` to define
its smart set by the source's OWN funnel instead of the plain source-tag SQL above. Signal sets are
built independently of `wallet_candidates.source` (the 07-04 audit found 14 of 21 multi-hit snipers
were invisible to their own source because `competition_signal` had already claimed their candidate
row — the OG seed reads the same 0-30s pool) and subtract the OG universe (follow_list ∪ global
smart set ∪ copy-net) plus earlier sources' sets — a signal set can never steal a wallet another
book is already trading.

**The winner-sniper 3-stage funnel (operator-directed, 2026-07-04):** the audit also showed a plain
own-PnL gate was off-thesis (every scored multi-hit sniper was lifetime own-PnL-negative — the
6/6-precision top sniper sat at drop3 −5.4 — yet the probe exits on its own TP100/SL30, so the
lead's exits shouldn't gate an entry-timing signal). The replacement is a funnel where each cheap
stage buys admission to the next, expensive one ("I can't listen to every swap"):

1. **Profit-credit** (`winner-sniper.ts`): a `winner_hit` is credited only when the window buyer was
   MTM-PROFITABLE on that token at the final observed path price (`WINNER_PROFIT_EPS_SOL`).
   Bag-holding a winner no longer counts. Tally bar (hits ≥ 2, precision, decayed score) earns a
   pre-filter slot — nothing more.
2. **Forward pre-filter** (`winner-prefilter.ts`): bar-clearing wallets are WATCHED (own
   `transactionSubscribe`, zero RPC, hard-capped at `PREFILTER_MAX_WALLETS`=200) across ANY PumpSwap
   token going forward. PASS = ≥ `PREFILTER_MIN_OTHER_WINS` (2) profitable CLOSED positions on
   non-trigger mints AND net ≥ `PREFILTER_MIN_NET_SOL` (0.25) within `PREFILTER_TTL_HOURS` (120);
   early-fail at −`PREFILTER_MAX_LOSS_SOL` (1.0). Out-of-sample by construction — flows only
   accumulate after enrollment.
3. **Scoring decides tradability**: passing promotes the wallet into `wallet_candidates`
   (source=`winner_sniper`, top scoring priority) → FIFO scorer → the relaxed source gate; the
   tradable set (`signalSet`) is pre-filter-passed ∩ scored-gate, capped at `COPYSRC_WATCH_CAP`.
