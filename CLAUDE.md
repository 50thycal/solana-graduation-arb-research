# CLAUDE.md — Mission & Operating Instructions

## MISSION

We are running a focused research sprint to validate or invalidate this thesis:

> "Post-graduation PumpFun token momentum can be scalped profitably using a TP+SL strategy on the vel 5-20 sol/min cohort, achieving >+1% avg return per trade after all costs."

The original "buy and hold to T+300" thesis was invalidated at n=630. The scalp thesis (enter at T+30, 10% SL / 30-50% TP) is the only surviving positive-EV strategy. We are now collecting data to reach n=200 on the vel 5-20 cohort (currently n=80) to confirm or kill it.

The human operator is the feedback loop. They are NOT writing code. Their job is to read the dashboard, screenshot it, and feed it back to you. Your job is to iterate the code until the thesis is proven or disproven. Move fast.

---

## RESEARCH FINDINGS (as of n=630)

### Confirmed Dead (do not revisit)
- **Raw buy-and-hold T+30 to T+300**: -6.2% avg return. Dead.
- **SL-only strategies (no TP)**: All negative EV. The asymmetry kills you — winners give +19%, losers take -59%.
- **SOL raised filters**: All tokens graduate at ~85 SOL. No discriminating power.
- **Holder count filters**: No signal. All ~38% win rate regardless of threshold.
- **Top5 wallet concentration**: Actively negative — higher concentration = worse performance.
- **Momentum continuation** (T+300 > T+30): Only 47%. Not a signal.

### Confirmed Signals
- **BC velocity 5-20 sol/min**: 63% raw win rate (n=76). Best single filter.
- **BC velocity 10-20 sol/min**: 52.4% win rate. The sweet spot within the sweet spot.
- **T+30 entry gate (+5% to +100%)**: Required for positive selection. Below +5% = dead tokens.
- **TP+SL combos**: The only way to turn the velocity signal into positive EV. TP locks in gains before reversion. Best combos:
  - vel 5-20 @ 10% SL / 50% TP: +1.4% avg return (n=80)
  - vel 5-20 @ 10% SL / 30% TP: +0.8% avg return (n=80)
  - vel 5-20 @ 10% SL / 75% TP: +1.0% avg return (n=80)
- **BC age >10min + vel <20**: +0.8% avg return at 10% SL (n=103). Secondary signal.

### Under Investigation
- **Liquidity >100 SOL**: 66.7% win rate but only n=45. Promising but unproven.
- **Regime stability**: Overall win rate std dev 7.7% (stable), but vel 5-20 at 13.9% (moderate). Edge may be time-dependent.
- **Tail risk**: 18.2% of vel 5-20 trades lose >50%. The 10% SL is what prevents catastrophic losses.

---

## THE ITERATION LOOP (REPEAT EVERY CYCLE)

Each cycle follows this exact pattern:

1. **Push a code update**
2. **Bot runs and collects data**
3. **Dashboard displays current results**
4. **Human screenshots dashboard and feeds back to you**
5. **You diagnose: data issue, code bug, or real signal?**
6. **You push next fix or next feature. Repeat.**

Never skip straight to "the thesis is working" without checking the data quality first. Assume bugs exist until proven otherwise.

---

## YOUR ROLE AS CODING AGENT

You are responsible for:

1. Writing and updating the bot code
2. Maintaining a LIVE dashboard the human can read at a glance
3. Diagnosing bugs from dashboard output alone
4. Keeping the bot focused on the thesis — do not drift
5. Declaring a conclusion when the data is sufficient

You are NOT responsible for:
- Running the bot (human does that)
- Deciding when to stop (you will declare when data is sufficient)
- Trading execution (research only for now)

---

## DASHBOARD REQUIREMENTS (CRITICAL)

The dashboard is the primary communication channel between the bot and the AI. Build it well. Update it every iteration.

The dashboard MUST always show:

### HEADER
- Bot status: RUNNING / ERROR / STALLED
- Uptime
- Graduations detected (total)
- Graduations with complete price data (T+300s captured)

### THESIS SCORECARD
- Total labeled: PUMP / DUMP / STABLE counts
- Raw win rate % (PUMP / total labeled)
- Best TP+SL combo EV + filtered win rate %
- Vel 5-20 sample count and progress toward n=200

### LAST 10 GRADUATIONS TABLE
Columns: GradID | Open Price | T+60s | T+300s | % Change | Label | Holders | Top5% | DevWallet% | BC Age (min) | BC Velocity

### DATA QUALITY FLAGS
- Price source: PumpSwap pool? YES / NO (flag if NO)
- Any null fields in last 10 rows? List them
- Timestamp drift detected? YES / NO
- Last graduation detected: X seconds ago (flag if >5 min)

### CURRENT CODE VERSION + LAST CHANGE SUMMARY
- What changed in this version
- What bug it was fixing
- What to watch for in next dashboard read

---

## BUG TRIAGE PROTOCOL

When the human feeds back a dashboard screenshot, diagnose in order:

- **LEVEL 1** — Is the bot even running and detecting graduations?
  - If no graduations in 10+ min: connection/subscription bug
- **LEVEL 2** — Is price data being captured correctly?
  - Check price source flag. Check for nulls. PumpSwap pool price ONLY. Not BC price.
- **LEVEL 3** — Are timestamps correct?
  - T+300s should be relative to graduation detection, not wall clock
- **LEVEL 4** — Is the label logic correct?
  - PUMP = >+10% at T+300s from open
  - DUMP = <-10% at T+300s from open
- **LEVEL 5** — Is the signal real or noise?
  - Only ask this question after Levels 1-4 are confirmed clean

Fix bugs in order. Do not skip levels.

---

## THESIS CONCLUSION RULES

Declare a conclusion when ONE of these is true:

### THESIS VALID
- 200+ samples on vel 5-20 cohort
- TP+SL avg return >+0.5% after all costs (gap penalties, round-trip slippage)
- Regime analysis shows STABLE or MODERATE (std dev <15%)
- No Level 1-4 bugs present
- Output: "THESIS VALID — here is the exact strategy spec for execution"

### THESIS INVALID
- 200+ samples on vel 5-20 cohort
- TP+SL avg return <+0.5% OR negative after all costs
- OR regime analysis shows CLUSTERED (std dev >15% — edge is not stable)
- No Level 1-4 bugs present
- Output: "THESIS INVALID — here is what the data showed. Scalp edge does not survive at scale."

### INCONCLUSIVE
- Data quality issues persist after 3+ fix cycles on same bug
- Graduation detection too sparse to collect data
- Output: "BLOCKED — here is the specific technical blocker, here are the options to resolve it"

Do not run indefinitely without declaring. If you have 200+ clean samples and a clear answer, say it.

---

## CURRENT THESIS PARAMETERS

| Parameter | Value |
|---|---|
| Entry timing | T+30 post-graduation on PumpSwap pool |
| Entry gate | T+30 price between +5% and +100% from open |
| Velocity filter | BC velocity 5-20 sol/min |
| Stop-loss | 10% from entry (with 20% adverse gap penalty modeled) |
| Take-profit | 30-50% from entry (with 10% adverse gap penalty modeled) |
| Round-trip costs | Per-token measured slippage, fallback 3% |
| Target avg return | >+0.5% per trade after all costs |
| Sample target | 200 clean samples on vel 5-20 cohort |
| Price source | PumpSwap pool ONLY (not bonding curve) |
| Execution | Research only — no live trades |
| Monthly revenue target | ~$490/month at 0.5 SOL position size (covers AI/infra costs) |

### Active signals being tracked:
- BC velocity 5-20 sol/min (primary)
- BC age >10 min (secondary)
- Liquidity >100 SOL at T+30 (under investigation, low n)
- Regime stability across time windows (monitoring)
