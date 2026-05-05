# Live Trading Readiness Checklist

Standard operating procedure for promoting a strategy from `shadow` → `live_micro` → `live_full`. The bot's live execution path is built; this document is the human/agent checklist for flipping it on safely.

**Bar to clear before any live fill:** `/api/diagnose` verdict = `HEALTHY` AND `level5_live_ready.pass = true` AND the candidate strategy has at least n=20 shadow trades with positive median net return.

Per CLAUDE.md the bot's self-imposed promotion bar is "shadow at n ≥ 100 by both mean AND median". Going live before that is acceptable in `live_micro` only — the 0.05 SOL position size limits worst-case loss while you collect the live data needed to clear the n=100 bar.

---

## 1. Pre-flight (one-time, before first live fill)

### Environment variables (Railway)

- [ ] `WALLET_PRIVATE_KEY` populated (64-byte JSON array `[1,2,...]` OR base58 string)
- [ ] `HELIUS_RPC_URL` populated and responsive
- [ ] `EXECUTION_MODE=shadow` as the GLOBAL default (per-strategy `executionMode` overrides this for live strategies)
- [ ] `TRADING_ENABLED=true`
- [ ] `TRADING_KILLSWITCH` unset or `=0`
- [ ] `DAILY_MAX_LOSS_SOL` set conservatively (default `1.0` SOL)
- [ ] `MICRO_TRADE_SIZE_SOL=0.05` (default verified)
- [ ] `RISK_HALT_LAST_N_TRADES` and `RISK_HALT_MAX_DRAWDOWN_SOL` set as global defaults (or override per-strategy via `strategy-commands.json`). Defaults: `10` trades, `-0.5` SOL.

### Repo / filesystem

- [ ] `.trading-kill` file does NOT exist on the deployment
- [ ] Database migrations applied — verify `strategy_configs` has `risk_halted_at` + `risk_halt_reason` columns (auto-applied on boot via `src/db/schema.ts`)

### Wallet

- [ ] Trading wallet funded with at least:

  ```
  required_sol >= (tradeSizeSol + WALLET_SOL_BUFFER + jitoTipSol) × maxConcurrentPositions
  ```

  For `live_micro` with one concurrent position: `0.05 + 0.02 + 0.0001 ≈ 0.07` SOL minimum, plus buffer for several days of fills + ATA rent. Recommend funding `0.5–1.0` SOL.

### Verify the live path compiles

- [ ] `npm run build` exits clean (only the pre-existing `moduleResolution=node10` deprecation warning is acceptable)
- [ ] `npm run verify-pumpswap` runs against current Helius RPC and returns expected pool state

### Diagnose verdict

- [ ] Read `diagnose.json` from `bot-status` branch. Required:
  - `verdict = "HEALTHY"`
  - `level5_live_ready.pass = true`
  - `level5_live_ready.evidence.killswitch_tripped = false`
  - `level5_live_ready.evidence.circuit_breaker_tripped = false`
  - `level5_live_ready.evidence.wallet_env_set = true`
  - `level5_live_ready.evidence.risk_halted_strategies = []`

---

## 2. Killswitch + breaker drill (do BEFORE real fills)

These confirm the safety net works. Run all three on a sacrificial test strategy in `paper` mode first, then in `shadow`, before going to `live_micro`.

### 2a. Killswitch

- [ ] On Railway, `touch .trading-kill` in the deployment's working directory
- [ ] Within 10s, logs show `safety tick: killswitch tripped` and any open live positions are force-closed
- [ ] `diagnose.json` next sync shows `level5_live_ready.evidence.killswitch_tripped = true` and verdict = `LEVEL5_FAIL`
- [ ] `rm .trading-kill`, confirm next sync returns to `HEALTHY`

### 2b. Daily circuit breaker

- [ ] Temporarily set `DAILY_MAX_LOSS_SOL=0.001` env var
- [ ] Simulate a small live loss (or just observe — if any live trade has closed below `-0.001` SOL net, the breaker should trip)
- [ ] Confirm `diagnose.json` shows `circuit_breaker_tripped = true`
- [ ] Restore `DAILY_MAX_LOSS_SOL=1.0`

### 2c. Per-strategy risk-halt breaker

- [ ] Push a sacrificial strategy via `strategy-commands.json` upsert with:
  ```json
  {
    "executionMode": "live_micro",
    "riskHaltLastNTrades": 1,
    "riskHaltMaxDrawdownSol": -0.001
  }
  ```
- [ ] After one losing live fill, within 10s the strategy is auto-disabled
- [ ] `strategies.json` shows `enabled: false`, `risk_halted_at: <ts>`, `risk_halt_reason: "risk_halt: rolling P&L ..."`
- [ ] `diagnose.json` `level5_live_ready.evidence.risk_halted_strategies` contains the strategy
- [ ] `snapshot.json` `risk_halts` array contains the strategy
- [ ] Push toggle `enabled: true` — within 2 min next sync, halt fields cleared and strategy resumes

---

## 3. First live fill protocol

### Pick the strategy

Highest-confidence shadow cohort by median net return, n ≥ 20. As of 2026-05-01 that's `v9shadow-vel5-10` (n=9, median +7.99%) — wait until n ≥ 20 OR pick the next-best at higher n.

### Push the live config

`strategy-commands.json` on the main branch:

```json
{
  "commands": [
    {
      "action": "upsert",
      "id": "v10-live-micro-vel5-10",
      "label": "Live μ vel<10",
      "enabled": true,
      "params": {
        "executionMode": "live_micro",
        "tradeSizeSol": 0.05,
        "maxConcurrentPositions": 1,
        "entryGateMinPctT30": 5,
        "entryGateMaxPctT30": 100,
        "takeProfitPct": 30,
        "stopLossPct": 10,
        "maxHoldSeconds": 300,
        "slGapPenaltyPct": 30,
        "tpGapPenaltyPct": 10,
        "filters": [
          {"field": "bc_velocity_sol_per_min", "operator": ">=", "value": 5,  "label": "vel>=5"},
          {"field": "bc_velocity_sol_per_min", "operator": "<",  "value": 10, "label": "vel<10"}
        ],
        "positionMonitorMode": "five_second",
        "trailingSlActivationPct": 0,
        "trailingSlDistancePct": 5,
        "slActivationDelaySec": 0,
        "trailingTpEnabled": false,
        "trailingTpDropPct": 5,
        "tightenSlAtPctTime": 0,
        "tightenSlTargetPct": 7,
        "tightenSlAtPctTime2": 0,
        "tightenSlTargetPct2": 5,
        "breakevenStopPct": 0,
        "riskHaltLastNTrades": 5,
        "riskHaltMaxDrawdownSol": -0.15,
        "maxSlippageBps": 500
      }
    }
  ]
}
```

`riskHaltLastNTrades: 5, riskHaltMaxDrawdownSol: -0.15` means: halt after 5 consecutive trades whose total net P&L is worse than -0.15 SOL (i.e. ~3 SOL of cumulative bad fills relative to entry). Tighter than the default (10/−0.5) because we're in early-rollout watching mode.

### Verify the first fill

- [ ] Within ~2 min, next sync of `trades.json` should show the new strategy
- [ ] First entry: `execution_mode = "live_micro"`, `entry_price_sol > 0`, `tx_signature` populated, `jito_tip_sol > 0`
- [ ] On Solscan: tx landed (`Success`), wallet received tokens
- [ ] On exit: `exit_tx_signature` populated, wallet has SOL back, `net_return_pct` reasonable

---

## 4. First-24h monitoring

### Every 30 min

- [ ] `diagnose.json` → `verdict = "HEALTHY"`, `level5_live_ready.pass = true`
- [ ] `snapshot.json` → `risk_halts = []` (or the deliberate test halts)
- [ ] No new entries in `bot-errors` (live-only API — ask operator if needed)

### After every 5 live fills

- [ ] Compare each live trade's `net_return_pct` to the same strategy's shadow median. Divergence > 5pp on average over 5 fills suggests the slippage model is off — investigate before continuing.
- [ ] Cross-check `strategy-percentiles.json` — the live strategy's median should be within ~1 std dev of the shadow median.

### Watch for

- RPC failures (Helius timeouts, 429s)
- Jito bundle failures (not landing within ~15 slots)
- ATA-rent errors (insufficient SOL for new token account creation)
- Risk-halt breaker trips (review `risk_halt_reason` before re-enabling)

---

## 5. Promotion: live_micro → live_full

Only after all of:

- [ ] n ≥ 50 live_micro fills on the strategy
- [ ] Mean AND median net return both positive
- [ ] No risk-halt trips in the last 50 fills
- [ ] Live mean/median within 2 std dev of shadow mean/median (slippage model validated)
- [ ] Daily circuit breaker has never tripped

Push an upsert with `executionMode: "live_full"` and `tradeSizeSol` set to your real position size. Loosen `riskHaltLastNTrades` and `riskHaltMaxDrawdownSol` proportionally — at 0.5 SOL position size, expect ~10× the breaker threshold.

---

## 6. Rollback procedure

If anything looks wrong, in priority order:

### Fastest: global killswitch

```
ssh railway && touch .trading-kill
```

Trips within 10s, force-closes all live positions, blocks all new entries. Paper/shadow data collection continues.

### Next: disable specific strategy

Push `strategy-commands.json`:

```json
{ "commands": [{ "action": "toggle", "id": "v10-live-micro-vel5-10", "enabled": false }] }
```

Takes effect within ~2 min. Other strategies keep running.

### Next: revert all live strategies to shadow

Push upsert commands resetting every live strategy to `executionMode: "shadow"`. Takes effect within ~2 min.

### Last resort: bot stop

If shells access fails, stop the Railway service. Open positions will NOT auto-close — sells must be done manually from a wallet UI.

---

## 7. Known gaps (acceptable for live_micro, address before live_full)

- **No transaction simulation/dry-run before bundle submission.** Shadow mode is the dry run — there's no `eth_call`-style preflight against the actual signed tx.
- **Slippage ceiling is global, not per-strategy.** `maxSlippageBps` defaults to 500 (5%). Per-strategy override is supported but not used by default.
- **Daily loss cap is global, not per-strategy.** `DAILY_MAX_LOSS_SOL` applies across all live strategies' P&L sum. The new per-strategy rolling-drawdown breaker covers the per-strategy case at a finer granularity.
- **No mode-step gate.** A single upsert can take a strategy from `shadow` → `live_full` without going through `live_micro`. Operationally enforce the step-up by reviewing every upsert that sets `executionMode` to a live mode.
- **Position monitor is 5s polling.** Fast pumps can register over-collection (see graduation 18481 +700% trade — known limitation; mainly a shadow-stats issue, doesn't affect live execution math).

---

## 8. The risk-halt breaker (added 2026-05-05)

### What it does
Per-strategy auto-disable when `SUM(net_profit_sol)` over the last N closed live trades drops below a configured drawdown floor. Live trades only — `live_micro` and `live_full`. Paper/shadow excluded.

### Tunables (per-strategy)
- `riskHaltLastNTrades` — window size. Default 10. Set to `0` to disable.
- `riskHaltMaxDrawdownSol` — drawdown floor. Default `-0.5`. Must be ≤ 0.

### Trip semantics
- Window must be fully populated (≥ N closed live trades) before the breaker can trip — prevents false trips on early fills.
- When tripped: `enabled` set to 0, `risk_halted_at` timestamped, `risk_halt_reason` populated, any open live positions force-closed.
- Checked on every entry attempt (immediate) AND every 10s by `safetyTick` (defense-in-depth — catches strategies with no recent entry attempts).

### Where to see it
- `snapshot.json → risk_halts: [{id, label, halted_at, reason}]`
- `strategies.json → strategies[i].risk_halted_at, risk_halt_reason`
- `diagnose.json → level5_live_ready.evidence.risk_halted_strategies`

### How to clear it
Push `strategy-commands.json`:

```json
{ "commands": [{ "action": "toggle", "id": "<strategy-id>", "enabled": true }] }
```

`toggleStrategy(id, true)` AND `upsertStrategy` with `enabled=true` both clear `risk_halted_at` and `risk_halt_reason`. The rolling window is recomputed from `trades_v2` each tick, so the prior tripping window naturally ages out as fresh trades replace it.

### Implementation files
- `src/trading/safety.ts` — `checkStrategyRiskHalt`
- `src/trading/strategy-manager.ts` — `safetyTick` (10s), `toggleStrategy`, `upsertStrategy`
- `src/db/queries.ts` — `getStrategyRollingLivePnl`, `setStrategyRiskHalt`, `clearStrategyRiskHalt`
- `src/db/schema.ts` — `strategy_configs.risk_halted_at`, `risk_halt_reason`
