# solana-graduation-arb-research

## Project Specification

### 1. Overview

**Name:** solana-graduation-arb-research
**Purpose:** Measure and validate graduation transition zone arbitrage opportunities on Solana
**Type:** Research only — no trading, just data collection and analysis
**Goal:** Determine if graduation mispricing is a viable, consistent opportunity for our infrastructure level (Helius RPC, TypeScript, ~200ms latency)

### 2. Thesis

When a pump.fun token graduates (bonding curve fills), it migrates to PumpSwap/Raydium. During this transition there is a structural price dislocation:

- The bonding curve has a known final price
- A new DEX pool is created with ~$12K initial liquidity
- Jupiter routing takes time to discover and optimize the new pool
- Early trades on the new pool face wider spreads

This creates a brief window where the same token may trade at different prices across venues. This project measures whether that window is large enough and long enough to be profitably captured at our infrastructure level.

### 3. Architecture

- **Language:** TypeScript/Node.js (consistent with existing bots)
- **Database:** SQLite with better-sqlite3 (consistent with existing bots)
- **RPC:** Helius (already have subscription)
- **Deployment:** Railway (already have account)
- **Dashboard:** Express + static HTML

System flow:

```
WebSocket (pump.fun program) → Graduation Listener → Event Queue
  → Pool Tracker (new DEX pool state)
  → Price Collector (multi-source snapshots)
  → Competition Detector (other bot activity)
  → Opportunity Scorer → SQLite
  → Dashboard (read-only analysis)
```

### 4. Data Collection

#### 4.1 Event Detection

- Monitor pump.fun program for `CompleteEvent` (graduation trigger)
- Track migration event (`CompletePumpAmmMigrationEvent`)
- Record timestamp of each event with slot-level precision
- Program IDs:
  - pump.fun: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
  - PumpSwap: `PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP`

#### 4.2 Pre-Graduation State

- Last bonding curve price before graduation
- SOL reserves in bonding curve at completion
- Real token reserves at completion
- Virtual reserves at completion
- Token supply info

#### 4.3 Post-Graduation State

- New pool creation on PumpSwap/Raydium
- Opening price on the new pool
- Initial liquidity deposited
- First 50 trades on the new pool (direction, size, price, wallet, slot)

#### 4.4 Price Divergence Tracking

For each graduation, capture prices at these intervals after graduation:

- T+0s (graduation moment)
- T+1s
- T+2s
- T+5s
- T+10s
- T+30s
- T+60s
- T+120s
- T+300s (5 minutes)

At each interval, record:

- Last known bonding curve price
- Current DEX pool price
- Jupiter quoted price (via API)
- Spread between each pair

#### 4.5 Opportunity Classification

For each graduation event, compute:

- Max spread observed
- Duration of spread > 0.5%
- Duration of spread > 1.0%
- Duration of spread > 2.0%
- Estimated profit after gas + Jito tips + slippage
- Whether opportunity was "fillable" (available liquidity vs trade size)
- Spread collapse speed (time from max spread to < 0.5%)
- Competition signal (number of transactions hitting pool in first 10 seconds)

### 5. Database Schema

#### Table 1: graduations

```sql
CREATE TABLE graduations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  slot INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  bonding_curve_address TEXT,
  final_price_sol REAL,
  final_sol_reserves REAL,
  final_token_reserves REAL,
  virtual_sol_reserves REAL,
  virtual_token_reserves REAL,
  new_pool_address TEXT,
  new_pool_dex TEXT,
  migration_signature TEXT,
  migration_slot INTEGER,
  migration_timestamp INTEGER,
  observation_complete INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_graduations_mint ON graduations(mint);
CREATE INDEX idx_graduations_timestamp ON graduations(timestamp);
```

#### Table 2: pool_observations

```sql
CREATE TABLE pool_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graduation_id INTEGER NOT NULL REFERENCES graduations(id),
  timestamp INTEGER NOT NULL,
  seconds_since_graduation REAL NOT NULL,
  pool_price_sol REAL,
  pool_sol_reserves REAL,
  pool_token_reserves REAL,
  pool_liquidity_usd REAL,
  jupiter_price_sol REAL,
  tx_count_since_graduation INTEGER,
  buy_count INTEGER,
  sell_count INTEGER
);
CREATE INDEX idx_pool_obs_grad ON pool_observations(graduation_id);
```

#### Table 3: price_comparisons

```sql
CREATE TABLE price_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graduation_id INTEGER NOT NULL REFERENCES graduations(id),
  timestamp INTEGER NOT NULL,
  seconds_since_graduation REAL NOT NULL,
  bonding_curve_price REAL,
  dex_pool_price REAL,
  jupiter_price REAL,
  bc_to_dex_spread_pct REAL,
  bc_to_jupiter_spread_pct REAL,
  dex_to_jupiter_spread_pct REAL
);
CREATE INDEX idx_price_comp_grad ON price_comparisons(graduation_id);
```

#### Table 4: opportunities

```sql
CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graduation_id INTEGER NOT NULL REFERENCES graduations(id),
  max_spread_pct REAL,
  max_spread_timestamp INTEGER,
  seconds_to_max_spread REAL,
  duration_above_05_pct REAL,
  duration_above_1_pct REAL,
  duration_above_2_pct REAL,
  spread_collapse_seconds REAL,
  estimated_profit_sol REAL,
  estimated_gas_sol REAL,
  estimated_jito_tip_sol REAL,
  estimated_slippage_pct REAL,
  net_profit_sol REAL,
  is_fillable INTEGER,
  available_liquidity_sol REAL,
  competition_tx_count_10s INTEGER,
  viability_score REAL,
  classification TEXT
);
CREATE INDEX idx_opp_grad ON opportunities(graduation_id);
```

#### Table 5: paper_trades

```sql
CREATE TABLE paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graduation_id INTEGER NOT NULL REFERENCES graduations(id),
  entry_timestamp INTEGER,
  entry_price_sol REAL,
  entry_seconds_after_graduation REAL,
  exit_timestamp INTEGER,
  exit_price_sol REAL,
  exit_seconds_after_graduation REAL,
  trade_size_sol REAL,
  gross_profit_sol REAL,
  estimated_fees_sol REAL,
  net_profit_sol REAL,
  net_profit_pct REAL,
  exit_reason TEXT
);
```

#### Table 6: competition_signals

```sql
CREATE TABLE competition_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graduation_id INTEGER NOT NULL REFERENCES graduations(id),
  timestamp INTEGER NOT NULL,
  seconds_since_graduation REAL,
  tx_signature TEXT,
  wallet_address TEXT,
  action TEXT,
  amount_sol REAL,
  is_likely_bot INTEGER
);
```

### 6. Analysis Dashboard

Web dashboard at configurable port showing:

**Panel 1: Graduation Frequency**
- Graduations per hour/day chart
- Running total
- Average time between graduations

**Panel 2: Spread Analysis**
- Average spread by seconds-after-graduation (line chart)
- Spread distribution histogram
- Max spread per graduation scatter plot

**Panel 3: Opportunity Viability**
- % of graduations with spread > 1% lasting > 1s
- % of graduations with positive net profit after fees
- Average net profit per viable opportunity

**Panel 4: Competition Density**
- Average bot transactions in first 10 seconds
- Competition trend over time
- Correlation between competition and spread duration

**Panel 5: Go/No-Go Indicator**
- p(capture) at 200ms latency
- p(capture) at 100ms latency
- p(capture) at 50ms latency
- Clear indicator: viable (green) / marginal (yellow) / not viable (red)

**Panel 6: Paper Trade P&L**
- Cumulative simulated P&L
- Win rate
- Average win vs average loss

### 7. Key Questions to Answer

After 48-72 hours of data collection:

1. **Frequency:** How often do graduations happen? (per hour)
2. **Spread size:** What's the typical price spread at graduation?
3. **Duration:** How long does the spread last before converging?
4. **Viability:** Is the spread large enough to cover gas + Jito tips + slippage?
5. **Competition:** How many bots are hitting the same window?
6. **Feasibility:** At ~200ms latency, what's our probability of capture?

### 8. Configuration

```env
# RPC
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Program IDs
PUMP_FUN_PROGRAM_ID=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
PUMPSWAP_PROGRAM_ID=PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP

# Collection Settings
OBSERVATION_DURATION_SECONDS=300
SNAPSHOT_INTERVAL_MS=1000
MAX_CONCURRENT_OBSERVATIONS=5

# Dashboard
DASHBOARD_PORT=3000
DASHBOARD_ENABLED=true

# Infrastructure
HEALTH_PORT=8080
DATA_DIR=./data
LOG_LEVEL=info
```

### 9. Project Structure

```
solana-graduation-arb-research/
├── src/
│   ├── index.ts
│   ├── monitor/
│   │   ├── graduation-listener.ts
│   │   └── pool-tracker.ts
│   ├── collector/
│   │   ├── price-collector.ts
│   │   └── competition-detector.ts
│   ├── analysis/
│   │   ├── opportunity-scorer.ts
│   │   ├── viability-calculator.ts
│   │   └── paper-trader.ts
│   ├── db/
│   │   ├── schema.ts
│   │   └── queries.ts
│   └── dashboard/
│       ├── server.ts
│       └── public/
├── package.json
├── tsconfig.json
├── Dockerfile
├── .env.example
├── SPEC.md
└── README.md
```

### 10. Deployment

- Dockerfile following same pattern as existing bots
- Railway with persistent volume for SQLite
- Health check on port 8080
- Dashboard on port 3000

### 11. Timeline

- **Phase 1 (Week 1):** Event detection + basic data collection — graduation listener, SQLite schema, health endpoint
- **Phase 2 (Week 2):** Price tracking + opportunity scoring — multi-source price snapshots, spread calculation, competition detection
- **Phase 3 (Week 3):** Dashboard + analysis — visualization, paper trading simulation, viability calculator
- **Phase 4 (Ongoing):** Data collection, review results, decide go/no-go

### 12. Success Criteria

The go/no-go decision is based on:

- **Go:** p(capture) >= 0.20 at our latency AND average net profit per opportunity > 0.001 SOL AND opportunities occur > 5x per hour
- **No-go:** p(capture) < 0.20 OR spreads consistently < gas costs OR competition collapses spreads in < 100ms

### 13. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Graduation events change format | Monitor pump.fun program updates, version detection |
| PumpSwap program ID changes | Configurable via env var |
| Helius rate limits during high graduation volume | Max concurrent observations cap |
| SQLite write contention | WAL mode, batched writes |
| Market conditions shift | Continuous data collection, weekly review |

### 14. Out of Scope

- Actual trade execution (this is research only)
- Cross-chain arbitrage
- Raydium-to-Orca arb (separate future project)
- Historical backfill (start from deployment date forward)
