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
- **Control** `copy-tp100-sl30-lag`: the same ruleset on OG (graduation-seeded) wallets.
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
| — | live_tape (Idea 1) | COLLECTING | funnel slow — zero smart+copyable so far |
| — | external / Solana Tracker (Idea 3) | COLLECTING | funnel slow; crowding prior |
| — | winner_sniper (operator thesis, S2+S3) | COLLECTING | added 2026-07-02: minute-cadence path labels (20×60s, WIN = peak ≥ +50% AND ≥3 checks above) × 0-30s buyer credit × precision × 36h-half-life decay (`winner-sniper.ts`); ~3-5k RPC/day |
