# Copy-Trading Edge Map & Graveyard

Read in Phase 1. The counterpart to Kalshi's market-edge-map. Purpose: reason honestly about where copy-trading edge lives, and — just as importantly — what's already been ruled out, so a thesis doesn't re-litigate a settled question. The graveyard here is large and hard-won; respect it.

## The one fact that shapes everything

**Copy-trading smart wallets is the only approach in this repo's history with large-n, drop3-robust positive P&L.** Shadow copy-trading since ~2026-06-05: overall n≈3,128, +31.9 SOL, drop_top3 +12.0 at 0.5 SOL size. Public-feature strategies on the same tokens are a −935 SOL graveyard. So the edge is **information asymmetry** — the lead wallet knows something (or is faster) and you mirror it before the crowd prices it in — *not* anything computable from public chart features after the fact.

This has a direct consequence: the edge is a **race against decay**. The lead's advantage is largest at their entry and bleeds away fast (the `-lag` twin exists because 5 seconds already matters). Everything in copy-trading is "capture as much of a decaying, real edge as execution allows."

## The four levers (a copy-strategy is a config across these)

A challenger perturbs the incumbent's **strongest** lever by one param (lab discipline). In rough order of leverage:

1. **Which wallets to follow (discovery + scoring)** — *the highest-leverage lever.* A better base is what turns a losing control into a promotable strategy (the hot-lead gate converted OG's −0.028/trade into the incumbent's +0.019/trade). New/better wallet *sources* and stricter scoring move edge more than exit tweaks. This is where to push first.
2. **Entry gating** — filters on *which* of a followed wallet's entries to copy. The one gate proven to hold is the **recency hot-lead gate**: "our last-N copies of this lead netted ≥ X" (live config {N=10, k=3, X=0.5}). Raising the net-floor X monotonically buys drop3 robustness — the live hill-climb. Cumulative/all-time copy-net does *not* work (graveyard below).
3. **Exit rules** — TP/SL/trailing/time. The robust chassis is **TP100 / SL30**. Exit engineering is low-leverage and *cannot rescue a negative-entry signal* (graveyard). Tighter stops than SL30 have been poison.
4. **Sizing** — position size / concentration caps. Mostly a risk lever, not an alpha lever; judged against the monthly-run-rate bar and drop3.

## Where to look (priors for generation)

- **Better wallet sources** (lever 1) — HIGH prior. The winner-sniper funnel is the current frontier: credit only wallets that were *profitable* on a token, hold them in a forward pre-filter (out-of-sample by construction), and only pass-bar wallets reach the scorer. A source that reliably surfaces genuinely-skilled early buyers is the biggest available win.
- **Stricter recency gating** (lever 2) — MEDIUM–HIGH prior. The net-floor hill-climb is live and works until it caps; raising X buys robustness but shrinks n and concentrates leads, so each step must re-clear drop3 at n≥100.
- **Exit/sizing tweaks** — LOW prior. Don't lead with these; they don't flip losing entries and the arena keeps refusing net-positive/drop3-negative exit lotteries.

## The graveyard (do NOT regenerate without a specific material difference)

### 1. Graduation-arb / public T+30 chart features — DEAD (−935 SOL)
~150 strategies / 32,477 paper trades on T+30 post-graduation entries filtered by public features (velocity, monotonicity, holders, concentration, snipers, creator rep, path shape, regime, time-of-day, BTC/F&G): **net −935.8 SOL, avg −5.9%/trade, zero cleared the bar.** Filters *reshape* the loss, they don't reverse it (universe median `pct_t300` ≈ −11.7%). **Exit-engineering never flipped a negative entry positive.** The whole line is retired; do not revive without explicit operator direction. Lesson: public post-hoc features don't contain durable edge → use information-asymmetry (copy smart wallets).

### 2. Survivorship-poisoned backfill features — a TRAP, not an edge
`holders≥250 (backfill)` showed +24.25% (n=396) and "ROBUST" and was recommended for deployment 5+ times. Pure survivorship: backfill re-resolves holder count *after* the outcome, so surviving-250-holders today = didn't-rug. **Walk-forward train/test cannot detect this** — both halves share the contaminated feature. Same class as the `liq_t300` look-ahead bug. **Rule: never deploy a filter whose field is resolved after entry time.** Treat the `(backfill)` / `confirmed_recovery` rows in any best-combos list as artifacts. (This rule is enforced as a Phase-2 gate in SKILL.md.)

### 3. Cumulative copy-net as a lead screen — REFUTED (both directions)
Selecting leads by all-time copy-net (V2 positive-selection) was refuted out-of-sample. The surviving half — a *veto* on proven-bad leads (`xbad`: skip leads whose all-time baseline copy net is negative) — was then refuted forward too: by n=45 it was net-negative on both axes vs the strict base it layered on. **Cumulative copy-net neither selects nor vetoes forward copy profit.** Only the *recency* hot-lead gate holds. This closes the copy-net lead-screen line.

### 4. Net-positive / drop3-negative "lottery" strategies — CORRECTLY REFUSED
`hold30m` had the biggest raw net in the book (+24–28 SOL) but drop3 negative and *worsening every loop* (top-3 wallets ≈ 32% of net). The arena refuses these by design. A big net with negative drop3 is 1–3 outliers, not an edge — do not promote, and prune when matured.

### 5. No locked/idealized wins
The idealized 1:1 mirror is an upper bound (score cap 80), never a live edge. Any strategy whose only positive number is its mirror has no capturable edge.

## Decision heuristic (Phase 1)

Rank a candidate lever by:
1. **Is it lever 1 or 2** (wallet quality / recency gate)? Those move edge. Exit/sizing rarely do.
2. **Does it avoid the graveyard** — not public-feature, not cumulative-copy-net, not survivorship-resolved, not an exit lottery?
3. **Is the edge information-asymmetry** that survives the `-lag` twin, not a post-hoc feature?
4. **Can it reach n≥100** on the copyable universe, with drop3 holding as it matures?

If it's an exit tweak on the same wallets, or leans on a post-entry-resolved field, or is really cumulative-copy-net in a new hat — it's already answered. Push on wallet-source quality instead; that's the open frontier.
