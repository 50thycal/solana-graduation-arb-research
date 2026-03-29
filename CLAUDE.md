# CLAUDE.md — Mission & Operating Instructions

## MISSION

We are running a focused research sprint to validate or invalidate this thesis as fast as possible:

> "Post-graduation PumpFun token momentum is tradeable and can achieve >51% win rate with the right filters."

The human operator is the feedback loop. They are NOT writing code. Their job is to read the dashboard, screenshot it, and feed it back to you. Your job is to iterate the code until the thesis is proven or disproven. Move fast.

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
- Best filter found so far + filtered win rate %
- Trades needed to reach 30-sample threshold: X remaining

### LAST 10 GRADUATIONS TABLE
Columns: GradID | Open Price | T+60s | T+300s | % Change | Label | Holders | Top5% | DevWallet% | BC Age (min) | BC Vol Last 10m

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
- 30+ clean labeled graduations
- Raw win rate >60% OR filtered win rate >51% with clear filter rule
- No Level 1-4 bugs present
- Output: "THESIS VALID — here is the filter ruleset and trade criteria"

### THESIS INVALID
- 30+ clean labeled graduations
- Win rate <50% even after exhausting filter combinations
- No Level 1-4 bugs present
- Output: "THESIS INVALID — here is what the data showed, here is what we tried, time to move to next strategy"

### INCONCLUSIVE
- Data quality issues persist after 3+ fix cycles on same bug
- Graduation detection too sparse to collect data
- Output: "BLOCKED — here is the specific technical blocker, here are the options to resolve it"

Do not run indefinitely without declaring. If you have 30+ clean samples and a clear answer, say it.

---

## CURRENT THESIS PARAMETERS

| Parameter | Value |
|---|---|
| Tracking window | T+0 to T+300s post-graduation on PumpSwap pool |
| Win threshold | >+10% price increase at T+300s = PUMP |
| Target win rate | >51% after filters |
| Sample target | 30 clean labeled graduations minimum |
| Price source | PumpSwap pool ONLY (not bonding curve) |
| Execution | Research only — no live trades |

### Known signals to test as filters:
- Top 5 wallet concentration at graduation
- Dev wallet % held at graduation
- Time spent on bonding curve (age)
- Volume on bonding curve in final 10 min
- Total SOL raised at graduation
- Unique holder count at graduation
