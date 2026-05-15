/**
 * HTML rendering utilities for thesis and filter-analysis endpoints.
 * Produces clean, readable HTML with cards and tables while preserving
 * the raw JSON for copy-paste to AI assistants.
 */

import Database from 'better-sqlite3';

const NAV_LINKS = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/thesis', label: 'Thesis' },
  { path: '/filter-analysis', label: 'Filters' },
  { path: '/filter-analysis-v2', label: 'Filters V2' },
  { path: '/filter-analysis-v3', label: 'Filters V3' },
  { path: '/wallet-rep-analysis', label: 'Wallet Rep' },
  { path: '/peak-analysis', label: 'Peak Analysis' },
  { path: '/exit-sim', label: 'Exit Sim' },
  { path: '/exit-sim-matrix', label: 'Exit Matrix' },
  { path: '/price-path', label: 'Price Path' },
  { path: '/tokens?label=PUMP&min_sol=80', label: 'Tokens' },
  { path: '/pipeline', label: 'Pipeline' },
  { path: '/trading', label: 'Trading' },
  { path: '/report', label: 'Report' },
  { path: '/health', label: 'Health' },
  { path: '/data', label: 'Raw Data' },
  { path: '/raydium-check', label: 'DEX Check' },
];

const STYLES = `
  body{margin:0;background:#111;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace;font-size:13px}
  nav{position:sticky;top:0;z-index:10;background:#1a1a2e;padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #333}
  nav a{color:#94a3b8;text-decoration:none;padding:5px 12px;border-radius:4px;font-size:12px;cursor:pointer;transition:background .15s}
  nav a:hover{background:#334155;color:#e2e8f0}
  nav .nav-active{background:#2563eb;color:#fff;pointer-events:none}
  nav .title{color:#60a5fa;font-weight:bold;font-size:13px;margin-right:8px}
  .container{max-width:1200px;margin:0 auto;padding:16px}
  .toolbar{display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
  .toolbar button{background:#2563eb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px}
  .toolbar button:active{background:#1d4ed8}
  .toolbar button.secondary{background:#334155}
  .toolbar .copied{color:#4ade80;font-size:12px;display:none}
  .toolbar .timestamp{color:#64748b;font-size:11px;margin-left:auto}
  .card{background:#1e1e2e;border:1px solid #333;border-radius:8px;padding:16px;margin-bottom:12px}
  .card h2{margin:0 0 4px;color:#60a5fa;font-size:15px;font-weight:600}
  .card .desc{color:#94a3b8;font-size:11px;margin-bottom:12px;line-height:1.4}
  .card h3{margin:12px 0 8px;color:#a5b4fc;font-size:13px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:12px}
  .stat{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #1a1a2e}
  .stat .label{color:#94a3b8;font-size:12px}.stat .value{font-weight:600;font-size:12px}
  .green{color:#4ade80}.red{color:#ef4444}.yellow{color:#facc15}.blue{color:#60a5fa}
  table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}
  th{text-align:left;padding:6px 8px;background:#262640;color:#94a3b8;font-weight:600;border-bottom:1px solid #333;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid #222}
  tr:hover td{background:#1a1a30}
  .ev-pos{color:#4ade80;font-weight:600}.ev-neg{color:#ef4444;font-weight:600}
  .n-insuf{color:#4b5563;font-style:italic;font-size:11px}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .badge-pump{background:#166534;color:#4ade80}.badge-dump{background:#7f1d1d;color:#ef4444}
  .badge-stable{background:#422006;color:#facc15}
  .json-toggle{background:#262640;border:1px solid #333;border-radius:6px;margin-top:16px;overflow:hidden}
  .json-toggle summary{padding:10px 14px;cursor:pointer;color:#94a3b8;font-size:12px;user-select:none}
  .json-toggle summary:hover{background:#334155}
  .json-toggle pre{margin:0;padding:12px;white-space:pre-wrap;word-break:break-all;font-size:11px;max-height:600px;overflow-y:auto;background:#111}
  .section-sep{border:none;border-top:1px solid #333;margin:20px 0}
  /* V2 filter page row flags */
  tr.row-low-n td{opacity:.45}
  tr.row-low-n td .lowN{color:#f59e0b;font-size:10px;margin-left:6px;font-style:italic}
  tr.row-strong-n td{background:#162033}
  tr.row-baseline td{background:#1f2a44;font-weight:600;border-top:2px solid #3b82f6;border-bottom:2px solid #3b82f6}
  tr.row-group-header td{background:#0f0f1a;color:#60a5fa;font-weight:600;font-size:11px;padding:8px;letter-spacing:.5px;text-transform:uppercase}
  th.sortable{cursor:pointer;user-select:none}
  th.sortable:hover{background:#334155}
  th.sortable .arrow{font-size:10px;color:#64748b;margin-left:4px}
  /* Panel 4 controls */
  .p4-controls{margin:12px 0;padding:10px 14px;background:#262640;border-radius:6px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  .p4-controls label{color:#94a3b8;font-size:12px}
  .p4-controls select{background:#0f0f1a;color:#e2e8f0;border:1px solid #334155;padding:4px 8px;margin-left:4px;border-radius:4px;font-size:12px;cursor:pointer}
  .p4-controls select:hover{border-color:#60a5fa}
  .p4-controls .desc{margin-bottom:0;margin-left:auto}
  /* Panel 1 / Panel 4 / Panel 6 horizon tabs */
  .p4-tabs{display:flex;gap:4px;margin:12px 0 8px}
  .p1-tab,.p4-tab,.p6-tab{background:#1f2a44;color:#94a3b8;border:1px solid #334155;padding:6px 14px;border-radius:4px 4px 0 0;font-size:12px;cursor:pointer;font-family:inherit}
  .p1-tab:hover,.p4-tab:hover,.p6-tab:hover{background:#262640;color:#e2e8f0}
  .p1-tab.active,.p4-tab.active,.p6-tab.active{background:#3b82f6;color:#fff;border-color:#3b82f6;font-weight:600}
  .p1-horizon-panel,.p4-horizon-panel,.p6-horizon-panel{display:none}
  .p1-horizon-panel.active,.p4-horizon-panel.active,.p6-horizon-panel.active{display:block}
`;

function nav(currentPath: string): string {
  return NAV_LINKS.map(l =>
    l.path === currentPath
      ? `<a class="nav-active">${l.label}</a>`
      : `<a href="${l.path}">${l.label}</a>`
  ).join('');
}

const N_MIN = 50;

function nInsufficient(): string {
  return `<span class="n-insuf">n&lt;${N_MIN}</span>`;
}

function wr(val: number | null, threshold = 50): string {
  if (val === null) return '<span class="yellow">—</span>';
  const cls = val >= threshold ? 'green' : val >= 40 ? 'yellow' : 'red';
  return `<span class="${cls}">${val}%</span>`;
}

function wrN(val: number | null, n: number, threshold = 50): string {
  if (n < N_MIN) return nInsufficient();
  return wr(val, threshold);
}

function evN(evPositive: boolean, avgReturn: number, n: number): string {
  if (n < N_MIN) return nInsufficient();
  const retStr = `${avgReturn > 0 ? '+' : ''}${avgReturn}%`;
  return `<span class="${evPositive ? 'ev-pos' : 'ev-neg'}">${retStr}</span>`;
}

function evBadgeN(evPositive: boolean, n: number): string {
  if (n < N_MIN) return nInsufficient();
  return evPositive ? '<span class="green">YES</span>' : '<span class="red">NO</span>';
}

function pct(val: number | null | undefined): string {
  if (val === null || val === undefined) return '—';
  const cls = val > 0 ? 'green' : val < 0 ? 'red' : '';
  return `<span class="${cls}">${val > 0 ? '+' : ''}${typeof val === 'number' ? val.toFixed(1) : val}%</span>`;
}

function labelBadge(label: string | null): string {
  if (!label) return '<span class="yellow">—</span>';
  const cls = label === 'PUMP' ? 'badge-pump' : label === 'DUMP' ? 'badge-dump' : 'badge-stable';
  return `<span class="badge ${cls}">${label}</span>`;
}

function shell(title: string, currentPath: string, body: string, jsonData: object): string {
  const json = JSON.stringify(jsonData, null, 2);
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${STYLES}</style></head><body>
<nav><span class="title">Graduation Arb Research</span>${nav(currentPath)}</nav>
<div class="container">
  <div class="toolbar">
    <button onclick="copyJson()">Copy JSON</button>
    <button class="secondary" onclick="location.reload()">Refresh</button>
    <span class="copied" id="copied">Copied!</span>
    <span class="timestamp">${new Date().toISOString()}</span>
  </div>
  ${body}
  <details class="json-toggle">
    <summary>Raw JSON (click to expand — use Copy JSON button above)</summary>
    <pre id="json">${escaped}</pre>
  </details>
</div>
<script>
function copyJson(){
  navigator.clipboard.writeText(document.getElementById('json').textContent)
    .then(()=>{var c=document.getElementById('copied');c.style.display='inline';setTimeout(()=>c.style.display='none',1500)});
}
</script>
</body></html>`;
}

// ── THESIS PAGE ──────────────────────────────────────────────────────

export function renderThesisHtml(data: any): string {
  const d = data;
  const statusColor = d.bot_status === 'RUNNING' ? 'green' : 'red';

  // Header cards
  const header = `
  <div class="grid">
    <div class="card">
      <h2>Bot Status</h2>
      <div class="stat"><span class="label">Status</span><span class="value ${statusColor}">${d.bot_status}</span></div>
      <div class="stat"><span class="label">Uptime</span><span class="value">${d.uptime}</span></div>
      <div class="stat"><span class="label">Last Graduation</span><span class="value">${d.last_graduation_seconds_ago}s ago</span></div>
      <div class="stat"><span class="label">Total Graduations</span><span class="value">${d.total_graduations}</span></div>
      <div class="stat"><span class="label">With T+300 Data</span><span class="value">${d.with_complete_t300}</span></div>
    </div>
    <div class="card">
      <h2>Detection Pipeline</h2>
      <div class="desc">How raw log events become verified graduations. False positives are bundler/MEV txs filtered out.</div>
      ${d.detection_pipeline ? `
      <div class="stat"><span class="label">Candidates</span><span class="value">${d.detection_pipeline.candidates_detected}</span></div>
      <div class="stat"><span class="label">Verified</span><span class="value green">${d.detection_pipeline.verified_graduations}</span></div>
      <div class="stat"><span class="label">False Positives</span><span class="value red">${d.detection_pipeline.false_positives} (${d.detection_pipeline.false_positive_rate_pct}%)</span></div>
      <div class="stat"><span class="label">Vault Extractions</span><span class="value">${d.detection_pipeline.vault_extractions} / ${d.detection_pipeline.verified_graduations}</span></div>
      ` : '<div class="desc">No pipeline data available</div>'}
    </div>
  </div>`;

  // Current baseline banner
  const baseline = `
  <div class="card" style="border-color:#16a34a;background:rgba(22,163,74,0.06)">
    <h2>Current Baseline — Promoted 2026-04-12</h2>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Filter</span><span class="value green">vel&lt;20 + top5&lt;10%</span></div>
        <div class="stat"><span class="label">Sim Avg Return</span><span class="value green">+6.44%</span></div>
        <div class="stat"><span class="label">Win Rate</span><span class="value green">72.1%</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">n (samples)</span><span class="value">111</span></div>
        <div class="stat"><span class="label">Regime</span><span class="value green">STABLE</span></div>
        <div class="stat"><span class="label">Promotion bar</span><span class="value yellow">beat +6.74% on n≥100 + STABLE regime</span></div>
      </div>
    </div>
    <div class="desc" style="margin-top:8px">Next candidates: vel 10-20 + top5&lt;10% (n=51, sim +8.08%) · vel 10-20 + buy_ratio&gt;0.6 (n=33, sim +8.90%) · holders≥18 + top5&lt;10% (n=127, sim +5.68%). Check /filter-analysis-v2 Panel 11 for regime stability.</div>
  </div>`;

  // Scorecard
  const sc = d.scorecard;
  const scorecard = `
  <div class="card">
    <h2>Thesis Scorecard</h2>
    <div class="desc">Core thesis: "Post-graduation PumpFun token momentum is tradeable." PUMP = >+10% at T+300, DUMP = <-10%. Win rate = PUMP / total labeled. Best Filter ranked by sim return (10%SL/50%TP + costs), same model as /api/best-combos.</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Total Labeled</span><span class="value">${sc.total_labeled}</span></div>
        <div class="stat"><span class="label">PUMP</span><span class="value green">${sc.PUMP}</span></div>
        <div class="stat"><span class="label">DUMP</span><span class="value red">${sc.DUMP}</span></div>
        <div class="stat"><span class="label">STABLE</span><span class="value yellow">${sc.STABLE}</span></div>
        <div class="stat"><span class="label">Raw Win Rate</span><span class="value">${wr(sc.raw_win_rate_pct)}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Best Filter (opt)</span><span class="value blue">${sc.best_filter?.name || '—'}</span></div>
        <div class="stat"><span class="label">Opt Avg Return</span><span class="value ${(sc.best_filter?.opt_avg_ret ?? 0) > (sc.rolling_baseline_opt_avg_ret ?? 0) + 0.3 ? 'green' : (sc.best_filter?.opt_avg_ret ?? 0) > (sc.rolling_baseline_opt_avg_ret ?? 0) ? 'yellow' : 'red'}">${sc.best_filter?.opt_avg_ret != null ? (sc.best_filter.opt_avg_ret > 0 ? '+' : '') + sc.best_filter.opt_avg_ret + '%' : '—'}</span></div>
        <div class="stat"><span class="label">Opt TP / SL</span><span class="value">${sc.best_filter?.opt_tp != null ? `${sc.best_filter.opt_tp}% / ${sc.best_filter.opt_sl}%` : '—'}</span></div>
        <div class="stat"><span class="label">Win Rate</span><span class="value">${wr(sc.best_filter?.opt_win_rate)}</span></div>
        <div class="stat"><span class="label">Sample Size (n)</span><span class="value">${sc.best_filter?.sample_size || '—'}</span></div>
        <div class="stat"><span class="label">Rolling Baseline</span><span class="value">${sc.rolling_baseline_opt_avg_ret != null ? (sc.rolling_baseline_opt_avg_ret > 0 ? '+' : '') + sc.rolling_baseline_opt_avg_ret + '%' : '—'}</span></div>
        <div class="stat"><span class="label">Unlabeled</span><span class="value">${sc.unlabeled}</span></div>
      </div>
    </div>
  </div>`;

  // Verdict
  const verdict = `
  <div class="card" style="border-color:#2563eb">
    <h2>Thesis Verdict</h2>
    <div style="font-size:14px;padding:8px 0;color:#e2e8f0">${d.thesis_verdict}</div>
  </div>`;

  // Baseline signal card
  const t30 = d.t30_momentum_signal;
  const t30Signal = `
  <div class="card">
    <h2>Baseline Signal: vel&lt;20 + top5&lt;10% + T+30 Gate</h2>
    <div class="desc">${t30.note}</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Filter</span><span class="value">${t30.filter}</span></div>
        <div class="stat"><span class="label">Win Rate</span><span class="value">${wr(t30.win_rate_from_t0_pct ?? t30.win_rate_pct)}</span></div>
        <div class="stat"><span class="label">T+30 Profitable Rate</span><span class="value ${(t30.t30_profitable_rate_pct ?? 0) > 51 ? 'green' : 'yellow'}">${wr(t30.t30_profitable_rate_pct)}</span></div>
        <div class="stat"><span class="label">T+30 Avg Return</span><span class="value">${pct(t30.t30_avg_return_pct)}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Sample (n)</span><span class="value">${t30.n}</span></div>
        <div class="stat"><span class="label">PUMP / DUMP</span><span class="value"><span class="green">${t30.pump_label_count ?? t30.pump ?? '—'}</span> / <span class="red">${t30.dump_label_count ?? t30.dump ?? '—'}</span></span></div>
        <div class="stat"><span class="label">Avg T+300</span><span class="value">${pct(t30.avg_t300_pct)}</span></div>
      </div>
    </div>
  </div>`;

  // Price trajectory by label
  const labels = d.labels_detail || [];
  const trajectoryRows = labels.map((l: any) => `
    <tr>
      <td>${labelBadge(l.label)}</td><td>${l.count}</td>
      <td>${pct(l.avg_pct_t30)}</td><td>${pct(l.avg_pct_t60)}</td>
      <td>${pct(l.avg_pct_t120)}</td><td>${pct(l.avg_pct_t300)}</td><td>${pct(l.avg_pct_t600)}</td>
    </tr>`).join('');

  const trajectory = `
  <div class="card">
    <h2>Price Trajectory by Label</h2>
    <div class="desc">Average % change from open price at each checkpoint. Shows how PUMPs vs DUMPs behave over time.</div>
    <table>
      <tr><th>Label</th><th>n</th><th>T+30</th><th>T+60</th><th>T+120</th><th>T+300</th><th>T+600</th></tr>
      ${trajectoryRows}
    </table>
  </div>`;

  // Last 10
  const last10Rows = (d.last_10 || []).map((t: any) => `
    <tr>
      <td>${t.mint}</td><td>${labelBadge(t.label)}</td>
      <td>${t.sol_raised?.toFixed(0) ?? '—'}</td><td>${t.holders}</td>
      <td>${t.top5_pct?.toFixed(1) ?? '—'}%</td>
      <td>${pct(t.t60)}</td><td>${pct(t.t300)}</td>
      <td>${t.buyers ?? '—'}</td>
      <td>${t.buy_ratio != null ? (t.buy_ratio * 100).toFixed(0) + '%' : '—'}</td>
      <td>${t.whale_pct != null ? (t.whale_pct * 100).toFixed(0) + '%' : '—'}</td>
      <td>${t.trades ?? '—'}</td>
      <td>${t.has_pool ? '<span class="green">Yes</span>' : '<span class="red">No</span>'}</td>
    </tr>`).join('');

  const last10 = `
  <div class="card">
    <h2>Last 10 Graduations</h2>
    <div class="desc">Most recent graduations with their metrics and outcomes. Buy pressure metrics: Buyers = unique wallets buying in 0-30s, BuyR = buy ratio, Whale = largest buy as % of total buy vol, Trades = total txs.</div>
    <table>
      <tr><th>Mint</th><th>Label</th><th>SOL</th><th>Holders</th><th>Top5%</th><th>T+60</th><th>T+300</th><th>Buyers</th><th>BuyR</th><th>Whale</th><th>Trades</th><th>Pool</th></tr>
      ${last10Rows}
    </table>
  </div>`;

  // Data quality
  const dq = d.data_quality;
  const quality = `
  <div class="card">
    <h2>Data Quality</h2>
    <div class="desc">Flags for data integrity issues that could affect analysis accuracy.</div>
    <div class="stat"><span class="label">Price Source PumpSwap</span><span class="value ${dq.price_source_pumpswap ? 'green' : 'red'}">${dq.price_source_pumpswap ? 'YES' : 'NO'}</span></div>
    <div class="stat"><span class="label">Null Fields</span><span class="value">${typeof dq.null_fields_in_last_10 === 'string' ? `<span class="green">${dq.null_fields_in_last_10}</span>` : `<span class="yellow">${dq.null_fields_in_last_10.length} fields</span>`}</span></div>
    <div class="stat"><span class="label">Stale Data</span><span class="value ${dq.last_grad_stale ? 'yellow' : 'green'}">${dq.last_grad_stale ? 'YES' : 'NO'}</span></div>
    <div class="stat"><span class="label">WS Connected</span><span class="value ${dq.listener_connected ? 'green' : 'red'}">${dq.listener_connected ? 'YES' : 'NO'}</span></div>
    <div class="stat"><span class="label">Full 5s Grid Coverage</span><span class="value ${(dq.full_5s_grid_pct ?? 0) >= 50 ? 'green' : 'yellow'}">${dq.full_5s_grid_count ?? 0} / ${dq.complete_observations_count ?? 0}${dq.full_5s_grid_pct != null ? ` (${dq.full_5s_grid_pct}%)` : ''}</span></div>
    <div class="desc" style="font-size:11px;margin-top:4px">Complete observations (pct_t300 present) with every pct_tN from t5..t300 populated.</div>
  </div>`;

  const pd = d.path_data_summary;
  const pathSummary = pd ? `
  <div class="card" style="border-color:#334155">
    <h2>Price Path Analysis</h2>
    <div class="desc">5-second granular snapshots (T+0→T+60) for shape analysis. <a href="/price-path" style="color:#60a5fa">View full analysis →</a></div>
    <div class="stat"><span class="label">Tokens with complete 5s data</span><span class="value blue">${pd.complete_5s_count}</span></div>
    <div class="stat"><span class="label">Best entry time (10%SL/50%TP)</span><span class="value">${pd.best_entry_time ?? '—'}</span></div>
    <div class="stat"><span class="label">Best entry avg return</span><span class="value">${pd.best_entry_avg_return != null ? pct(pd.best_entry_avg_return) : '—'}</span></div>
  </div>` : '';

  const body = header + verdict + baseline + scorecard + t30Signal + trajectory + last10 + quality + pathSummary;
  return shell('Thesis — Graduation Arb Research', '/thesis', body, data);
}

// ── FILTER ANALYSIS PAGE ──────────────────────────────────────────────

function filterTable(title: string, desc: string, rows: any[], showAvgT300 = true): string {
  if (!rows || rows.length === 0) return '';
  const t300Header = showAvgT300 ? '<th>Avg T+300</th>' : '';
  const tableRows = rows.map((r: any) => {
    const n = r.n ?? r.total ?? 0;
    const t300Cell = showAvgT300 ? `<td>${pct(r.avg_t300_pct)}</td>` : '';
    return `<tr>
      <td>${r.filter || r.strategy || r.bucket || '—'}</td>
      <td>${n || '—'}</td><td class="green">${r.pump ?? '—'}</td><td class="red">${r.dump ?? '—'}</td>
      <td>${wrN(r.win_rate_pct, n)}</td>${t300Cell}
    </tr>`;
  }).join('');
  return `
  <div class="card">
    <h2>${title}</h2>
    <div class="desc">${desc}</div>
    <table>
      <tr><th>Filter</th><th>n</th><th>PUMP</th><th>DUMP</th><th>Win Rate</th>${t300Header}</tr>
      ${tableRows}
    </table>
  </div>`;
}

function slTable(title: string, desc: string, rows: any[]): string {
  if (!rows || rows.length === 0) return '';
  const tableRows = rows.map((r: any) => `
    <tr>
      <td>${r.strategy || r.t30_filter || '—'}</td>
      <td>${r.stop_loss_pct}%</td><td>${r.n}</td>
      <td>${r.stopped_pct}%</td><td>${r.profitable_rate_pct}%</td>
      <td>${evN(r.ev_positive, r.avg_return_pct, r.n)}</td>
      <td>${evBadgeN(r.ev_positive, r.n)}</td>
    </tr>`).join('');
  return `
  <div class="card">
    <h2>${title}</h2>
    <div class="desc">${desc}</div>
    <table>
      <tr><th>Strategy</th><th>SL%</th><th>n</th><th>Stopped%</th><th>Profit%</th><th>Avg Return</th><th>EV+</th></tr>
      ${tableRows}
    </table>
  </div>`;
}

function slTpTable(title: string, desc: string, rows: any[]): string {
  if (!rows || rows.length === 0) return '';
  const tableRows = rows.map((r: any) => `
    <tr>
      <td>${r.strategy || '—'}</td>
      <td>${r.stop_loss_pct}%</td><td>${r.take_profit_pct}%</td><td>${r.n}</td>
      <td>${r.stopped_pct}%</td><td class="green">${r.tp_hit_pct}%</td>
      <td>${r.profitable_rate_pct}%</td>
      <td>${evN(r.ev_positive, r.avg_return_pct, r.n)}</td>
      <td>${evBadgeN(r.ev_positive, r.n)}</td>
    </tr>`).join('');
  return `
  <div class="card">
    <h2>${title}</h2>
    <div class="desc">${desc}</div>
    <table>
      <tr><th>Strategy</th><th>SL%</th><th>TP%</th><th>n</th><th>Stopped%</th><th>TP Hit%</th><th>Profit%</th><th>Avg Return</th><th>EV+</th></tr>
      ${tableRows}
    </table>
  </div>`;
}

function pathShapeFiltersSection(psf: any): string {
  if (!psf) return '';
  const monoN = psf.mono_total_n ?? 0;
  const nWarn = monoN < 50
    ? `<div style="color:#ef4444;font-weight:600;margin-bottom:8px">⚠ n=${monoN} — insufficient data (need ≥50 for meaningful signal)</div>`
    : monoN < 150
    ? `<div style="color:#facc15;font-weight:600;margin-bottom:8px">⚠ n=${monoN} — TP+SL results noisy until n≥150</div>`
    : '';

  const filterRows = (psf.filter_stats || []).map((f: any) => {
    const wrVal = f.win_rate_pct;
    const wrCls = wrVal === null ? 'yellow' : wrVal >= 55 ? 'green' : wrVal >= 45 ? 'yellow' : 'red';
    const nFlag = f.n < 50 ? ' <span class="n-insuf">(n&lt;50)</span>' : '';
    return `<tr>
      <td>${f.filter}</td>
      <td>${f.n}${nFlag}</td>
      <td>${f.pump ?? '—'}</td>
      <td>${f.dump ?? '—'}</td>
      <td><span class="${wrCls}">${wrVal !== null ? wrVal + '%' : '—'}</span></td>
    </tr>`;
  }).join('');

  const tpSlBlock = (title: string, rows: any[]) => {
    if (!rows || rows.length === 0) return '';
    const trs = rows.map((r: any) => `
      <tr>
        <td>${r.strategy}</td>
        <td>${r.stop_loss_pct}%</td><td>${r.take_profit_pct}%</td><td>${r.n}</td>
        <td>${r.stopped_pct}%</td><td class="green">${r.tp_hit_pct}%</td>
        <td>${r.profitable_rate_pct}%</td>
        <td>${evN(r.ev_positive, r.avg_return_pct, r.n)}</td>
        <td>${evBadgeN(r.ev_positive, r.n)}</td>
      </tr>`).join('');
    return `<h3>${title}</h3>
    <table>
      <tr><th>Strategy</th><th>SL%</th><th>TP%</th><th>n</th><th>Stopped%</th><th>TP Hit%</th><th>Profit%</th><th>Avg Return</th><th>EV+</th></tr>
      ${trs}
    </table>`;
  };

  return `
  <div class="card">
    <h2>Path Shape Filters — Monotonicity (0–30s)</h2>
    <div class="desc">${psf.note}</div>
    ${nWarn}
    <table>
      <tr><th>Filter</th><th>n</th><th>PUMP</th><th>DUMP</th><th>Win Rate</th></tr>
      ${filterRows || '<tr><td colspan="5" class="n-insuf">No monotonicity data yet</td></tr>'}
    </table>
    ${tpSlBlock('TP+SL Combos — mono &gt; 0.5 (all tokens)', psf.tp_sl_combos_mono_05)}
    ${tpSlBlock('TP+SL Combos — mono &gt; 0.5 + vel 5-20', psf.tp_sl_combos_mono_05_vel)}
  </div>`;
}

function signalFrequencySection(sf: any): string {
  if (!sf || sf.samples === 0 || !sf.graduations_per_hour) return '';
  const filterRows = (sf.signals_per_day_by_filter || []).map((f: any) => `
    <tr>
      <td>${f.filter}</td><td>${f.hits}</td>
      <td>${f.hit_rate_pct}%</td>
      <td class="blue">${f.est_signals_per_day}</td>
    </tr>`).join('');
  return `
  <div class="card">
    <h2>Signal Frequency</h2>
    <div class="desc">${sf.note}</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Data Span</span><span class="value">${sf.data_span_hours}h</span></div>
        <div class="stat"><span class="label">Graduations / Hour</span><span class="value blue">${sf.graduations_per_hour}</span></div>
        <div class="stat"><span class="label">Est. Graduations / Day</span><span class="value">${sf.graduations_per_day_est}</span></div>
        <div class="stat"><span class="label">Velocity Data Available</span><span class="value ${sf.velocity_data_available_pct >= 80 ? 'green' : 'yellow'}">${sf.velocity_data_available_pct}%</span></div>
      </div>
    </div>
    <h3>Est. Signals Per Day by Filter</h3>
    <table>
      <tr><th>Filter</th><th>Matches (historical)</th><th>Hit Rate</th><th>Est. Signals/Day</th></tr>
      ${filterRows}
    </table>
  </div>`;
}

function returnDistributionSection(rd: any): string {
  if (!rd || rd.samples != null) return '';  // skip if insufficient data message
  if (!rd.all_t30_5_100 && !rd.vel_5_20) return '';

  const percRow = (d: any) => {
    if (!d) return '';
    return `
      <tr>
        <td><b>${d.cohort}</b></td><td>${d.n}</td>
        <td>${pct(d.avg_return_pct)}</td>
        <td class="red">${d.p10}%</td>
        <td class="red">${d.p25}%</td>
        <td>${pct(d.median)}</td>
        <td class="green">${d.p75}%</td>
        <td class="green">${d.p90}%</td>
        <td class="red">${d.min}%</td>
        <td class="green">${d.max}%</td>
        <td class="red">${d.pct_worse_than_neg50}%</td>
        <td class="green">${d.pct_better_than_pos30}%</td>
      </tr>`;
  };

  const labelRows = rd.by_label
    ? [rd.by_label.pump, rd.by_label.dump, rd.by_label.stable].filter(Boolean).map(percRow).join('')
    : '';

  return `
  <hr class="section-sep">
  <div class="card">
    <h2>Return Distribution (Percentiles)</h2>
    <div class="desc">${rd.note || 'Percentile returns from T+30 entry to T+300 exit, cost-adjusted.'}</div>
    <h3>Key Cohorts</h3>
    <table>
      <tr><th>Cohort</th><th>n</th><th>Avg</th><th>p10</th><th>p25</th><th>Median</th><th>p75</th><th>p90</th><th>Min</th><th>Max</th><th>&lt;-50%</th><th>&gt;+30%</th></tr>
      ${percRow(rd.all_t30_5_100)}
      ${percRow(rd.vel_5_20)}
    </table>
    <h3>By Label</h3>
    <table>
      <tr><th>Cohort</th><th>n</th><th>Avg</th><th>p10</th><th>p25</th><th>Median</th><th>p75</th><th>p90</th><th>Min</th><th>Max</th><th>&lt;-50%</th><th>&gt;+30%</th></tr>
      ${labelRows}
    </table>
  </div>`;
}

function regimeAnalysisSection(ra: any): string {
  if (!ra || ra.samples != null) return '';  // skip if insufficient data
  if (!ra.time_buckets?.length) return '';

  const verdictClass = ra.stability_verdict?.includes('STABLE') ? 'green'
    : ra.stability_verdict?.includes('MODERATE') ? 'yellow' : 'red';

  const bucketRows = ra.time_buckets.map((b: any) => `
    <tr>
      <td style="white-space:nowrap;font-size:11px">${b.window}</td>
      <td>${b.n_total}</td>
      <td class="green">${b.pump}</td>
      <td class="red">${b.dump}</td>
      <td>${wr(b.raw_win_rate_pct)}</td>
      <td>${b.vel_5_20_n}</td>
      <td>${b.vel_5_20_win_rate_pct != null ? wr(b.vel_5_20_win_rate_pct) : '—'}</td>
      <td>${b.vel_5_20_avg_return_pct != null ? pct(b.vel_5_20_avg_return_pct) : '—'}</td>
    </tr>`).join('');

  return `
  <hr class="section-sep">
  <div class="card">
    <h2>Regime Analysis (n=${ra.total_samples})</h2>
    <div class="desc">${ra.note || ''}</div>
    <div class="grid">
      <div class="stat"><span class="label">Overall Win Rate Std Dev</span><span class="value">${ra.overall_win_rate_std_dev}%</span></div>
      <div class="stat"><span class="label">Vel 5-20 Win Rate Std Dev</span><span class="value">${ra.vel_5_20_win_rate_std_dev != null ? ra.vel_5_20_win_rate_std_dev + '%' : '—'}</span></div>
      <div class="stat"><span class="label">Stability Verdict</span><span class="value ${verdictClass}">${ra.stability_verdict}</span></div>
    </div>
    <h3>Performance by Time Window</h3>
    <table>
      <tr><th>Window</th><th>n</th><th>PUMP</th><th>DUMP</th><th>Win Rate</th><th>Vel 5-20 n</th><th>Vel 5-20 WR</th><th>Vel 5-20 Avg Ret</th></tr>
      ${bucketRows}
    </table>
  </div>`;
}

export function renderFilterHtml(data: any): string {
  const d = data;

  // Removed: sol_raised_filters, holder_filters, top5_filters, sol_raised_distribution,
  // SL-only sections (basic, velocity_combos, stacked_combos), momentum_continuation.
  // All confirmed dead at n=630+. Data still in DB.

  const sections = [
    filterTable('T+30 Entry Filters',
      'Core momentum gate: only enter tokens showing positive momentum at T+30. This is the primary entry signal.',
      d.t30_entry_filters),

    filterTable('Velocity & Liquidity Combo Filters',
      'bc_velocity = how fast the bonding curve filled (SOL/min). Sweet spot is 5-20 sol/min. These combos stack velocity with liquidity, bc_age, and holder signals.',
      (d.combination_filters || []).filter((r: any) =>
        (r.filter.includes('velocity') || r.filter.includes('liquidity'))
        && !r.filter.includes('buyer') && !r.filter.includes('buy_ratio') && !r.filter.includes('whale')
      )),

    filterTable('BC Age Combo Filters',
      'bc_age-based combos (no velocity). Older tokens may have more organic holder bases.',
      (d.combination_filters || []).filter((r: any) =>
        r.filter.includes('bc_age') && !r.filter.includes('velocity') && !r.filter.includes('liquidity') && !r.filter.includes('buyer') && !r.filter.includes('buy_ratio') && !r.filter.includes('whale') && !r.filter.includes('trades')
      )),

    filterTable('Buy Pressure Quality Filters',
      'Buy pressure metrics from 0-30s post-graduation: buyers = unique wallets buying, buy_ratio = buys/(buys+sells), whale_pct = largest single buy as % of total buy volume, trades = total tx count. Distributed buying (many buyers, low whale) may predict more sustainable pumps.',
      (d.combination_filters || []).filter((r: any) =>
        r.filter.includes('buyer') || r.filter.includes('buy_ratio') || r.filter.includes('whale') || r.filter.includes('trades>=')
      )),

    filterTable('BC Age Filters',
      'bc_age = time the token spent on the bonding curve before graduating.',
      d.bc_age_filters),
  ];

  // Distributions
  const distSections = [
    filterTable('BC Velocity Distribution',
      'Win rate by bonding curve fill speed. The 5-20 sol/min range consistently outperforms. Very slow (<5) and very fast (50+) both underperform.',
      d.bc_velocity_distribution, false),

    filterTable('BC Age Distribution',
      'Win rate by how long the token was on the bonding curve. <1h tends to perform best.',
      d.bc_age_distribution, false),
  ];

  // Stop-loss — only TP+SL combos (SL-only confirmed negative EV)
  const slSections = [
    slTpTable('Take-Profit + Stop-Loss Combos',
      'The only positive-EV strategies. SL: 30% adverse gap (recalibrated 2026-04-15). TP: 10% adverse gap. SL checked first (conservative). Round-trip slippage on all exits.',
      d.stop_loss_simulation?.tp_sl_combos),
  ];

  // Drawdown
  const dd = d.drawdown_analysis;
  let drawdownSection = '';
  if (dd && dd.samples > 0) {
    const byLabelRows = (dd.by_label || []).map((l: any) => `
      <tr>
        <td>${labelBadge(l.label)}</td><td>${l.n}</td>
        <td>${pct(l.avg_max_peak_pct)}</td><td>${pct(l.avg_max_drawdown_pct)}</td>
        <td>${l.avg_peak_sec}s</td><td>${l.avg_drawdown_sec}s</td>
      </tr>`).join('');

    const optSLRows = (dd.optimal_stop_loss || []).map((r: any) => `
      <tr>
        <td>${r.stop_level_pct}%</td>
        <td class="green">${r.pumps_survived_pct}%</td><td>(${r.pumps_stopped}/${r.pumps_total})</td>
        <td class="red">${r.dumps_caught_pct}%</td><td>(${r.dumps_stopped}/${r.dumps_total})</td>
      </tr>`).join('');

    drawdownSection = `
    <div class="card">
      <h2>Drawdown Analysis (n=${dd.samples})</h2>
      <div class="desc">${dd.note}</div>
      <h3>Peak & Drawdown by Label</h3>
      <table>
        <tr><th>Label</th><th>n</th><th>Avg Peak</th><th>Avg Drawdown</th><th>Peak At</th><th>Drawdown At</th></tr>
        ${byLabelRows}
      </table>
      <h3>Optimal Stop-Loss (from peak)</h3>
      <div class="desc">At each stop level: what % of PUMPs survive vs what % of DUMPs get caught. Measured from absolute peak, not entry price.</div>
      <table>
        <tr><th>Stop Level</th><th>PUMPs Survived</th><th></th><th>DUMPs Caught</th><th></th></tr>
        ${optSLRows}
      </table>
    </div>`;
  }

  // Trading readiness
  const tr = d.trading_readiness;
  let tradingSection = '';
  if (tr && tr.samples > 0) {
    const trRows = (tr.by_label || []).map((l: any) => `
      <tr>
        <td>${labelBadge(l.label)}</td><td>${l.n}</td>
        <td>${l.avg_volatility_0_30}%</td><td>${l.avg_liquidity_sol_t30} SOL</td>
        <td>${l.avg_slippage_05sol}%</td><td>${l.avg_round_trip_slippage_pct != null ? l.avg_round_trip_slippage_pct + '%' : '—'}</td><td>${l.avg_bc_velocity ?? '—'} sol/min</td>
      </tr>`).join('');

    const volRows = (tr.win_rate_by_volatility || []).map((r: any) => `
      <tr><td>${r.bucket}</td><td>${r.n}</td><td class="green">${r.pump}</td><td class="red">${r.dump}</td><td>${wr(r.win_rate_pct)}</td></tr>
    `).join('');

    tradingSection = `
    <div class="card">
      <h2>Trading Readiness (n=${tr.samples})</h2>
      <div class="desc">${tr.note}</div>
      <h3>Metrics by Label at T+30</h3>
      <table>
        <tr><th>Label</th><th>n</th><th>Volatility</th><th>Liquidity</th><th>Slippage (0.5 SOL)</th><th>Round-Trip Slippage</th><th>BC Velocity</th></tr>
        ${trRows}
      </table>
      <h3>Win Rate by Volatility</h3>
      <div class="desc">Does early price volatility predict outcomes?</div>
      <table>
        <tr><th>Bucket</th><th>n</th><th>PUMP</th><th>DUMP</th><th>Win Rate</th></tr>
        ${volRows}
      </table>
    </div>`;
  }

  // T+30 entry economics
  const econ = d.t30_entry_economics;
  let econSection = '';
  if (econ?.thresholds?.length > 0) {
    const econRows = econ.thresholds.map((t: any) => {
      const c = t.all_cohort;
      return `<tr>
        <td>${t.threshold}</td><td>${c.n}</td>
        <td>${c.n < N_MIN ? nInsufficient() : pct(c.avg_return_from_t30_pct)}</td>
        <td>${c.n < N_MIN ? nInsufficient() : c.profitable_rate_pct + '%'}</td>
        <td>${pct(c.avg_t300_gain_pct)}</td>
      </tr>`;
    }).join('');

    econSection = `
    <div class="card">
      <h2>T+30 Entry Economics</h2>
      <div class="desc">${econ.note}</div>
      <table>
        <tr><th>Threshold</th><th>n</th><th>Avg Return from T+30</th><th>Profitable %</th><th>Avg T+300 Gain</th></tr>
        ${econRows}
      </table>
    </div>`;
  }

  const body = sections.join('') + '<hr class="section-sep">' +
    distSections.join('') + '<hr class="section-sep">' +
    slSections.join('') + '<hr class="section-sep">' +
    pathShapeFiltersSection(d.path_shape_filters) + '<hr class="section-sep">' +
    signalFrequencySection(d.signal_frequency) + '<hr class="section-sep">' +
    drawdownSection + tradingSection + econSection +
    returnDistributionSection(d.return_distribution) +
    regimeAnalysisSection(d.regime_analysis);

  return shell('Filter Analysis — Graduation Arb Research', '/filter-analysis', body, data);
}

// ── PRICE PATH ANALYSIS PAGE ─────────────────────────────────────────────────

// SVG chart constants
const CHART_W = 820;
const CHART_H = 310;
const PAD_L = 58;
const PAD_R = 20;
const PAD_T = 22;
const PAD_B = 38;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;
const TIME_POINTS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

function xScale(sec: number): number {
  return PAD_L + (sec / 60) * PLOT_W;
}

function yScale(pct: number, yMin: number, yMax: number): number {
  const range = yMax - yMin || 1;
  return PAD_T + (1 - (pct - yMin) / range) * PLOT_H;
}

function svgGrid(yMin: number, yMax: number): string {
  const lines: string[] = [];
  // X grid + labels (every 10s)
  for (let s = 0; s <= 60; s += 10) {
    const x = xScale(s);
    lines.push(`<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + PLOT_H}" stroke="#2a2a3e" stroke-width="1"/>`);
    lines.push(`<text x="${x}" y="${PAD_T + PLOT_H + 14}" fill="#64748b" font-size="10" text-anchor="middle">T+${s}s</text>`);
  }
  // Y grid + labels (5 ticks)
  const step = (yMax - yMin) / 4;
  for (let i = 0; i <= 4; i++) {
    const v = yMin + i * step;
    const y = yScale(v, yMin, yMax);
    lines.push(`<line x1="${PAD_L}" y1="${y}" x2="${PAD_L + PLOT_W}" y2="${y}" stroke="#2a2a3e" stroke-width="1"/>`);
    lines.push(`<text x="${PAD_L - 5}" y="${y + 4}" fill="#64748b" font-size="10" text-anchor="end">${v > 0 ? '+' : ''}${v.toFixed(0)}%</text>`);
  }
  // Zero line
  if (yMin < 0 && yMax > 0) {
    const y0 = yScale(0, yMin, yMax);
    lines.push(`<line x1="${PAD_L}" y1="${y0}" x2="${PAD_L + PLOT_W}" y2="${y0}" stroke="#334155" stroke-width="1.5" stroke-dasharray="4,3"/>`);
  }
  return lines.join('');
}

function svgPolyline(pcts: (number | null)[], yMin: number, yMax: number, color: string, opacity: number, strokeWidth: number): string {
  const pts: string[] = [];
  for (let i = 0; i < TIME_POINTS.length; i++) {
    const v = pcts[i];
    if (v == null) continue;
    pts.push(`${xScale(TIME_POINTS[i]).toFixed(1)},${yScale(v, yMin, yMax).toFixed(1)}`);
  }
  if (pts.length < 2) return '';
  return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-linejoin="round"/>`;
}

function svgArea(pcts: (number | null)[], yMin: number, yMax: number, color: string): string {
  const y0 = yScale(0, yMin, yMax);
  const fwd: string[] = [];
  const valid: string[] = [];
  for (let i = 0; i < TIME_POINTS.length; i++) {
    const v = pcts[i];
    if (v == null) continue;
    const x = xScale(TIME_POINTS[i]).toFixed(1);
    const y = yScale(v, yMin, yMax).toFixed(1);
    fwd.push(`${x},${y}`);
    valid.push(x);
  }
  if (fwd.length < 2) return '';
  const y0str = y0.toFixed(1);
  const first = valid[0];
  const last = valid[valid.length - 1];
  return `<polygon points="${first},${y0str} ${fwd.join(' ')} ${last},${y0str}" fill="${color}" opacity="0.15"/>`;
}

function svgChart(title: string, lines: string[], grid: string): string {
  return `
  <div style="overflow-x:auto;margin-bottom:4px">
  <svg width="${CHART_W}" height="${CHART_H}" viewBox="0 0 ${CHART_W} ${CHART_H}" style="background:#13131f;border-radius:8px;display:block">
    ${grid}
    ${lines.join('\n    ')}
    <text x="${CHART_W / 2}" y="14" fill="#94a3b8" font-size="11" text-anchor="middle">${title}</text>
  </svg>
  </div>`;
}

function computeYRange(tokenPcts: Array<(number | null)[]>, padding = 10): [number, number] {
  let mn = 0, mx = 0;
  for (const row of tokenPcts) {
    for (const v of row) {
      if (v != null) { if (v < mn) mn = v; if (v > mx) mx = v; }
    }
  }
  // Clip extreme outliers to ±300%
  mn = Math.max(mn - padding, -200);
  mx = Math.min(mx + padding, 400);
  return [mn, mx];
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

function meanPcts(rows: any[]): (number | null)[] {
  return TIME_POINTS.map((_, i) => {
    const col = `pct_t${TIME_POINTS[i]}`;
    const vals = rows.map(r => r[col] as number | null).filter(v => v != null) as number[];
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
}

function stdDevPcts(rows: any[], means: (number | null)[]): (number | null)[] {
  return TIME_POINTS.map((_, i) => {
    const col = `pct_t${TIME_POINTS[i]}`;
    const m = means[i];
    if (m == null) return null;
    const vals = rows.map(r => r[col] as number | null).filter(v => v != null) as number[];
    if (vals.length < 2) return null;
    const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
    return Math.sqrt(variance);
  });
}

// TP+SL simulation (mirror of index.ts logic, entry at arbitrary pct column)
// SL now uses the price-multiplier model from trade-logger.ts:112 — observed price
// at the checkpoint is multiplied by (1 - SL_GAP) to model thin-pool slippage on the
// exit fill, then compared against entry. Matches live paper fills.
const SL_GAP = 0.30;
const TP_GAP = 0.10;
const FALLBACK_COST = 3.0;
const STOP_CPS = ['pct_t35','pct_t40','pct_t45','pct_t50','pct_t55','pct_t60','pct_t90','pct_t120','pct_t150','pct_t180','pct_t240'] as const;

function simulateEntryAtTime(
  rows: any[], entryCol: string, slPct: number, tpPct: number,
  minEntry: number, maxEntry: number
): { n: number; avg_return: number; win_rate: number } {
  let total = 0, count = 0;
  let wins = 0;
  for (const r of rows) {
    const entryPct: number | null = entryCol === 'pct_t0' ? 0 : r[entryCol];
    if (entryPct == null || entryPct < minEntry || entryPct > maxEntry) continue;
    // Levels relative to open
    const openMult = 1 + entryPct / 100;
    const slLevel = (openMult * (1 - slPct / 100) - 1) * 100;
    const tpLevel = (openMult * (1 + tpPct / 100) - 1) * 100;
    const cost = r.round_trip_slippage_pct ?? FALLBACK_COST;
    let exit: number | null = null;
    // Check checkpoints after entry for SL/TP
    const allCps = ['pct_t5','pct_t10','pct_t15','pct_t20','pct_t25','pct_t30',
                    'pct_t35','pct_t40','pct_t45','pct_t50','pct_t55','pct_t60',
                    'pct_t90','pct_t120','pct_t150','pct_t180','pct_t240'] as const;
    const entryIdx = allCps.indexOf(entryCol as any);
    for (let ci = entryIdx + 1; ci < allCps.length; ci++) {
      const cpv: number | null = r[allCps[ci]];
      if (cpv == null) continue;
      if (cpv <= slLevel) {
        // Price-multiplier: observed price * (1 - SL_GAP), return vs entry
        const exitRatio = (1 + cpv / 100) * (1 - SL_GAP);
        exit = (exitRatio / openMult - 1) * 100;
        break;
      }
      if (cpv >= tpLevel) { exit = tpPct * (1 - TP_GAP); break; }
    }
    if (exit == null) {
      exit = r.pct_t300 != null
        ? ((1 + r.pct_t300 / 100) / (1 + entryPct / 100) - 1) * 100
        : -100;
    }
    const net = exit - cost;
    total += net;
    count++;
    if (net > 0) wins++;
  }
  if (count === 0) return { n: 0, avg_return: 0, win_rate: 0 };
  return { n: count, avg_return: +(total / count).toFixed(2), win_rate: +(wins / count * 100).toFixed(1) };
}

// ── FILTER ANALYSIS V2 ───────────────────────────────────────────────────
// Panel 1: Single-feature filter comparison.
// Each row shows label distribution after applying ONE filter, normalized
// for null data (n_applicable). Includes a baseline "no filter" row at top.

type FilterV2Row = {
  filter: string;
  group: string;
  n: number;
  pump: number;
  dump: number;
  stable: number;
  win_rate_pct: number | null;
  pump_dump_ratio: number | null;
};

function pdRatioCell(ratio: number | null): string {
  if (ratio === null) return '<span class="yellow">—</span>';
  // Color logic: >2.0 strong asymmetry (green), >1.0 positive (lighter green),
  // 1.0 even (yellow), <1.0 negative (red)
  let cls = 'red';
  if (ratio >= 2.0) cls = 'green';
  else if (ratio >= 1.5) cls = 'green';
  else if (ratio >= 1.0) cls = 'yellow';
  return `<span class="${cls}">${ratio.toFixed(2)}</span>`;
}

function v2WinRateCell(val: number | null): string {
  if (val === null) return '<span class="yellow">—</span>';
  const cls = val >= 50 ? 'green' : val >= 40 ? 'yellow' : 'red';
  return `<span class="${cls}">${val}%</span>`;
}

function v2RowClass(n: number, lowN: number, strongN: number): string {
  if (n < lowN) return 'row-low-n';
  if (n >= strongN) return 'row-strong-n';
  return '';
}

function v2RowHtml(r: FilterV2Row, lowN: number, strongN: number, isBaseline = false): string {
  const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN, strongN);
  const nLabel = r.n < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  return `<tr class="${cls}">
    <td>${r.filter}${nLabel}</td>
    <td>${r.n}</td>
    <td class="green">${r.pump}</td>
    <td class="red">${r.dump}</td>
    <td class="yellow">${r.stable}</td>
    <td>${v2WinRateCell(r.win_rate_pct)}</td>
    <td>${pdRatioCell(r.pump_dump_ratio)}</td>
  </tr>`;
}

// ── Panel 2 helpers: T+30-anchored MAE/MFE/Final percentiles + Sharpe-ish ──

type FilterV2PctRow = {
  filter: string;
  group: string;
  n: number;
  mae_p10: number | null; mae_p25: number | null; mae_p50: number | null;
  mae_p75: number | null; mae_p90: number | null;
  mfe_p10: number | null; mfe_p25: number | null; mfe_p50: number | null;
  mfe_p75: number | null; mfe_p90: number | null;
  final_p10: number | null; final_p25: number | null; final_p50: number | null;
  final_p75: number | null; final_p90: number | null;
  final_mean: number | null;
  final_stddev: number | null;
  sharpe_ish: number | null;
};

// Format a percentage value with explicit sign (+12% / -22%)
function fmtPct(v: number | null): string {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

// MAE cell — values are ≤ 0. Less negative = better.
// Thresholds: > -15 green, -15..-30 yellow, < -30 red
function maeCell(v: number | null): string {
  if (v == null) return '<span class="yellow">—</span>';
  const cls = v > -15 ? 'green' : v > -30 ? 'yellow' : 'red';
  return `<span class="${cls}">${fmtPct(v)}</span>`;
}

// MFE cell — values are ≥ 0. More positive = better.
// Thresholds: > +30 green, +10..+30 yellow, < +10 red
function mfeCell(v: number | null): string {
  if (v == null) return '<span class="yellow">—</span>';
  const cls = v > 30 ? 'green' : v > 10 ? 'yellow' : 'red';
  return `<span class="${cls}">${fmtPct(v)}</span>`;
}

// Final return cell — symmetric. Thresholds: > +5 green, -5..+5 yellow, < -5 red
function finalCell(v: number | null): string {
  if (v == null) return '<span class="yellow">—</span>';
  const cls = v > 5 ? 'green' : v > -5 ? 'yellow' : 'red';
  return `<span class="${cls}">${fmtPct(v)}</span>`;
}

// Sharpe-ish cell — unitless ratio, higher = better.
// Thresholds: > 0.2 green, 0..0.2 yellow, < 0 red
function sharpeCell(v: number | null): string {
  if (v == null) return '<span class="yellow">—</span>';
  const cls = v > 0.2 ? 'green' : v > 0 ? 'yellow' : 'red';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(2)}</span>`;
}

function v2PctRowHtml(r: FilterV2PctRow, lowN: number, strongN: number, isBaseline = false): string {
  const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN, strongN);
  const nLabel = r.n < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  return `<tr class="${cls}">
    <td>${r.filter}${nLabel}</td>
    <td>${r.n}</td>
    <td>${maeCell(r.mae_p10)}</td>
    <td>${maeCell(r.mae_p50)}</td>
    <td>${mfeCell(r.mfe_p50)}</td>
    <td>${mfeCell(r.mfe_p90)}</td>
    <td>${finalCell(r.final_p10)}</td>
    <td>${finalCell(r.final_p50)}</td>
    <td>${finalCell(r.final_p90)}</td>
    <td>${sharpeCell(r.sharpe_ish)}</td>
  </tr>`;
}

// ── Panel 3 helpers: regime stability across time buckets ──

type FilterV2RegimeBucket = {
  n: number;
  win_rate_pct: number | null;
  avg_return_pct: number | null;
};
type FilterV2RegimeRow = {
  filter: string;
  group: string;
  n: number;
  buckets: FilterV2RegimeBucket[];
  wr_std_dev: number | null;
  stability: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT';
};

// Per-bucket win rate cell — same thresholds as v2WinRateCell but null-tolerant
function bucketWRCell(v: number | null): string {
  if (v == null) return '<span class="yellow">—</span>';
  const cls = v >= 50 ? 'green' : v >= 40 ? 'yellow' : 'red';
  return `<span class="${cls}">${v}%</span>`;
}

// Per-bucket avg return cell — same thresholds as finalCell
function bucketRetCell(v: number | null): string {
  if (v == null) return '<span class="yellow">—</span>';
  const cls = v > 5 ? 'green' : v > -5 ? 'yellow' : 'red';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
}

// Win-rate std dev cell — lower = more stable. Thresholds match Panel 3 stability label.
function wrStdDevCell(v: number | null): string {
  if (v == null) return '<span class="yellow">—</span>';
  const cls = v < 8 ? 'green' : v < 15 ? 'yellow' : 'red';
  return `<span class="${cls}">${v.toFixed(1)}</span>`;
}

// Stability label badge
function stabilityCell(label: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT'): string {
  if (label === 'STABLE') return '<span class="green">STABLE</span>';
  if (label === 'MODERATE') return '<span class="yellow">MODERATE</span>';
  if (label === 'CLUSTERED') return '<span class="red">CLUSTERED</span>';
  return '<span style="color:#64748b">INSUFFICIENT</span>';
}

function v2RegimeRowHtml(r: FilterV2RegimeRow, lowN: number, strongN: number, isBaseline = false): string {
  const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN, strongN);
  const nLabel = r.n < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  // Pad buckets array to PANEL_3_BUCKET_COUNT (4) so the row always has the same number of cells
  const buckets = r.buckets.slice(0, 4);
  while (buckets.length < 4) buckets.push({ n: 0, win_rate_pct: null, avg_return_pct: null });
  return `<tr class="${cls}">
    <td>${r.filter}${nLabel}</td>
    <td>${r.n}</td>
    <td>${bucketWRCell(buckets[0].win_rate_pct)}</td>
    <td>${bucketRetCell(buckets[0].avg_return_pct)}</td>
    <td>${bucketWRCell(buckets[1].win_rate_pct)}</td>
    <td>${bucketRetCell(buckets[1].avg_return_pct)}</td>
    <td>${bucketWRCell(buckets[2].win_rate_pct)}</td>
    <td>${bucketRetCell(buckets[2].avg_return_pct)}</td>
    <td>${bucketWRCell(buckets[3].win_rate_pct)}</td>
    <td>${bucketRetCell(buckets[3].avg_return_pct)}</td>
    <td>${wrStdDevCell(r.wr_std_dev)}</td>
    <td>${stabilityCell(r.stability)}</td>
  </tr>`;
}

// Panel 11 row type — extends base regime row with opt return from best-combos leaderboard
type FilterV2ComboRegimeRow = FilterV2RegimeRow & {
  opt_tp: number | null;
  opt_sl: number | null;
  opt_avg_ret: number | null;
  beats_baseline: boolean;
};

// Panel 11 row renderer — same as v2RegimeRowHtml but with Opt Ret + Beats? columns after n
function v2ComboRegimeRowHtml(r: FilterV2ComboRegimeRow, lowN: number, strongN: number, isBaseline = false): string {
  const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN, strongN);
  const nLabel = r.n < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  const buckets = r.buckets.slice(0, 4);
  while (buckets.length < 4) buckets.push({ n: 0, win_rate_pct: null, avg_return_pct: null });

  let simRetHtml: string;
  if (isBaseline || r.opt_avg_ret === null) {
    simRetHtml = '<span style="color:#64748b">—</span>';
  } else {
    const sc = r.opt_avg_ret > 5 ? 'green' : r.opt_avg_ret > 0 ? 'yellow' : 'red';
    const sign = r.opt_avg_ret > 0 ? '+' : '';
    const tpSl = (r.opt_tp != null && r.opt_sl != null)
      ? `<span style="color:#64748b;font-size:0.85em"> @ tp${r.opt_tp}/sl${r.opt_sl}</span>`
      : '';
    simRetHtml = `<span class="${sc}">${sign}${r.opt_avg_ret.toFixed(2)}%</span>${tpSl}`;
  }
  const beatsHtml = isBaseline
    ? '<span style="color:#64748b">—</span>'
    : r.beats_baseline
      ? '<span class="green" style="font-weight:600">YES</span>'
      : '<span style="color:#64748b">no</span>';

  return `<tr class="${cls}">
    <td>${r.filter}${nLabel}</td>
    <td>${r.n}</td>
    <td>${simRetHtml}</td>
    <td>${beatsHtml}</td>
    <td>${bucketWRCell(buckets[0].win_rate_pct)}</td>
    <td>${bucketRetCell(buckets[0].avg_return_pct)}</td>
    <td>${bucketWRCell(buckets[1].win_rate_pct)}</td>
    <td>${bucketRetCell(buckets[1].avg_return_pct)}</td>
    <td>${bucketWRCell(buckets[2].win_rate_pct)}</td>
    <td>${bucketRetCell(buckets[2].avg_return_pct)}</td>
    <td>${bucketWRCell(buckets[3].win_rate_pct)}</td>
    <td>${bucketRetCell(buckets[3].avg_return_pct)}</td>
    <td>${wrStdDevCell(r.wr_std_dev)}</td>
    <td>${stabilityCell(r.stability)}</td>
  </tr>`;
}

// ── Panel 4 helpers: dynamic TP/SL EV simulator ──

type FilterV2Panel4Combos = {
  avg_ret: number[];  // flat-indexed: tpIdx * sl_levels.length + slIdx
  med_ret: number[];
  win_rate: number[];
};
type FilterV2Panel4Optimal = { tp: number; sl: number; avg_ret: number; win_rate: number } | null;
type FilterV2Panel4Row = {
  filter: string;
  group: string;
  n: number;
  combos: FilterV2Panel4Combos;
  optimal: FilterV2Panel4Optimal;
};

// Static optimum cell — rendered server-side, never changes on dropdown
function p4OptCell(v: number | null, suffix: '%' | ''): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  return `${v}${suffix}`;
}
function p4OptAvgRetCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v > 0.5 ? 'green' : v > -0.5 ? 'yellow' : 'red';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
}
function p4OptWinRateCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v >= 50 ? 'green' : v >= 40 ? 'yellow' : 'red';
  return `<span class="${cls}">${v}%</span>`;
}

// Row builder — 4 "Sel *" cells render as placeholders; JS fills them on load and on dropdown change.
// data-row-idx ties the row to its position in the __PANEL_4.rows array.
function v2Panel4RowHtml(r: FilterV2Panel4Row, lowN: number, strongN: number, rowIdx: number, isBaseline = false): string {
  const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN, strongN);
  const nLabel = r.n < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  const opt = r.optimal;
  return `<tr class="${cls}" data-row-idx="${rowIdx}"${isBaseline ? ' data-baseline="1"' : ''}>
    <td>${r.filter}${nLabel}</td>
    <td>${r.n}</td>
    <td class="p4-sel-avg">—</td>
    <td class="p4-sel-med">—</td>
    <td class="p4-sel-win">—</td>
    <td class="p4-sel-diff">—</td>
    <td>${p4OptCell(opt ? opt.tp : null, '%')}</td>
    <td>${p4OptCell(opt ? opt.sl : null, '%')}</td>
    <td>${p4OptAvgRetCell(opt ? opt.avg_ret : null)}</td>
    <td>${p4OptWinRateCell(opt ? opt.win_rate : null)}</td>
  </tr>`;
}

// Minimal HTML escaper for user-visible text that may contain <, >, &, ", '
// Filter names like "vel < 5 sol/min" and "holders >= 5" would otherwise
// break the markup when interpolated directly.
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Execution mode badge styling — hoisted so it's reachable from the
 *  extracted Recent Trades / Recent Skips render fns and the inline
 *  renderTradingHtml panels alike. */
function execModeStyle(m: string): { color: string; label: string } {
  switch (m) {
    case 'shadow':     return { color: '#a78bfa', label: 'SHADOW' };
    case 'live_micro': return { color: '#f59e0b', label: 'LIVE μ' };
    case 'live_full':  return { color: '#ef4444', label: 'LIVE' };
    case 'paper':
    default:           return { color: '#64748b', label: 'PAPER' };
  }
}

/**
 * Mint cell with Birdeye link + clipboard copy. Tap the truncated text on
 * mobile to open Birdeye in a new tab; tap the small copy icon to copy the
 * full mint to the clipboard. Always renders with rel="noopener noreferrer"
 * on the external link.
 */
function mintCell(mint: string | null | undefined, prefixLen = 8): string {
  if (!mint) return '<span style="color:#64748b">-</span>';
  const m = escHtml(mint);
  const truncated = m.slice(0, prefixLen) + '…';
  return `<span class="mint-cell"><a href="https://birdeye.so/token/${m}?chain=solana" target="_blank" rel="noopener noreferrer">${truncated}</a><button type="button" class="mint-copy" data-mint="${m}" aria-label="Copy mint" title="Copy full mint">⎘</button></span>`;
}

// ── Panel 5 helpers: statistical significance (Wilson CI + bootstrap CI) ──

type FilterV2Panel5Row = {
  filter: string;
  group: string;
  n: number;
  win_rate_pct: number | null;
  win_ci_low: number | null;
  win_ci_high: number | null;
  p_value_vs_baseline: number | null;
  opt_tp: number | null;
  opt_sl: number | null;
  opt_avg_ret: number | null;
  boot_ret_low: number | null;
  boot_ret_high: number | null;
  verdict: 'SIGNIFICANT' | 'MARGINAL' | 'NOISE' | 'INSUFFICIENT';
};

// Wilson CI cell — formatted as [low, high]
function wilsonCiCell(low: number | null, high: number | null): string {
  if (low == null || high == null) return '<span style="color:#64748b">—</span>';
  return `[${low.toFixed(1)}%, ${high.toFixed(1)}%]`;
}

// P-value cell — green if <0.05, yellow if <0.10, red otherwise
function pValueCell(p: number | null): string {
  if (p == null) return '<span style="color:#64748b">—</span>';
  const cls = p < 0.05 ? 'green' : p < 0.10 ? 'yellow' : 'red';
  // Show very small p-values in scientific notation
  const txt = p < 0.0001 ? p.toExponential(1) : p.toFixed(4);
  return `<span class="${cls}">${txt}</span>`;
}

// Bootstrap CI cell — formatted as [low, high]; green if entirely > 0, red if entirely < 0
function bootCiCell(low: number | null, high: number | null): string {
  if (low == null || high == null) return '<span style="color:#64748b">—</span>';
  const cls = low > 0 ? 'green' : high < 0 ? 'red' : 'yellow';
  const signLow = low > 0 ? '+' : '';
  const signHigh = high > 0 ? '+' : '';
  return `<span class="${cls}">[${signLow}${low.toFixed(1)}%, ${signHigh}${high.toFixed(1)}%]</span>`;
}

// Verdict badge for Panel 5
function verdictCell5(v: FilterV2Panel5Row['verdict']): string {
  if (v === 'SIGNIFICANT') return '<span class="green">SIGNIFICANT</span>';
  if (v === 'MARGINAL') return '<span class="yellow">MARGINAL</span>';
  if (v === 'NOISE') return '<span class="red">NOISE</span>';
  return '<span style="color:#64748b">INSUFFICIENT</span>';
}

function v2Panel5RowHtml(r: FilterV2Panel5Row, lowN: number, strongN: number, isBaseline = false): string {
  const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN, strongN);
  const nLabel = r.n < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  const optTpSl = (r.opt_tp != null && r.opt_sl != null) ? `${r.opt_tp}/${r.opt_sl}` : '—';
  return `<tr class="${cls}">
    <td>${r.filter}${nLabel}</td>
    <td>${r.n}</td>
    <td>${v2WinRateCell(r.win_rate_pct)}</td>
    <td>${wilsonCiCell(r.win_ci_low, r.win_ci_high)}</td>
    <td>${pValueCell(r.p_value_vs_baseline)}</td>
    <td>${optTpSl}</td>
    <td>${p4OptAvgRetCell(r.opt_avg_ret)}</td>
    <td>${bootCiCell(r.boot_ret_low, r.boot_ret_high)}</td>
    <td>${verdictCell5(r.verdict)}</td>
  </tr>`;
}

// ── Panel 6 helpers: multi-filter intersection ──

type FilterV2Panel6Dynamic = {
  selected: string[];
  n: number;
  opt_tp: number | null;
  opt_sl: number | null;
  opt_avg_ret: number | null;
  opt_win_rate: number | null;
  lift_vs_best_single: number | null;
} | null;

type FilterV2Panel6PairRow = {
  filter_a: string;
  filter_b: string;
  n: number;
  opt_tp: number;
  opt_sl: number;
  opt_avg_ret: number;
  opt_win_rate: number;
  single_a_opt: number | null;
  single_b_opt: number | null;
  lift: number;
};

// Lift cell — positive green, zero/negative yellow, large negative red
function liftCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v > 0.5 ? 'green' : v > -0.5 ? 'yellow' : 'red';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
}

// ── Panel 7 helpers: walk-forward validation ──

type FilterV2Panel7Row = {
  filter: string;
  group: string;
  n_train: number;
  n_test: number;
  train_tp: number | null;
  train_sl: number | null;
  train_avg_ret: number | null;
  test_avg_ret: number | null;
  degradation: number | null;
  verdict: 'ROBUST' | 'DEGRADED' | 'OVERFIT' | 'INSUFFICIENT';
};

// Degradation cell — train − test delta. Lower is better (less overfit).
function degradationCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v < 2 ? 'green' : v <= 5 ? 'yellow' : 'red';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(1)}pp</span>`;
}

// Verdict badge for Panel 7
function verdictCell7(v: FilterV2Panel7Row['verdict']): string {
  if (v === 'ROBUST') return '<span class="green">ROBUST</span>';
  if (v === 'DEGRADED') return '<span class="yellow">DEGRADED</span>';
  if (v === 'OVERFIT') return '<span class="red">OVERFIT</span>';
  return '<span style="color:#64748b">INSUFFICIENT</span>';
}

function v2Panel7RowHtml(r: FilterV2Panel7Row, lowN: number, strongN: number, isBaseline = false): string {
  const totalN = r.n_train + r.n_test;
  const cls = isBaseline ? 'row-baseline' : v2RowClass(totalN, lowN, strongN);
  const nLabel = totalN < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  const trainTpSl = (r.train_tp != null && r.train_sl != null) ? `${r.train_tp}/${r.train_sl}` : '—';
  return `<tr class="${cls}">
    <td>${r.filter}${nLabel}</td>
    <td>${r.n_train}</td>
    <td>${r.n_test}</td>
    <td>${trainTpSl}</td>
    <td>${p4OptAvgRetCell(r.train_avg_ret)}</td>
    <td>${p4OptAvgRetCell(r.test_avg_ret)}</td>
    <td>${degradationCell(r.degradation)}</td>
    <td>${verdictCell7(r.verdict)}</td>
  </tr>`;
}

// ── Panel 8 helpers: loss tail & risk metrics ──

type FilterV2Panel8Row = {
  filter: string;
  group: string;
  n: number;
  opt_tp: number | null;
  opt_sl: number | null;
  pct_loss_10: number | null;
  pct_loss_25: number | null;
  pct_loss_50: number | null;
  var_95: number | null;
  cvar_95: number | null;
  worst_trade: number | null;
  max_consecutive_losses: number | null;
};

// % loss threshold cell. Lower = safer. Thresholds per column differ by severity.
function pctLossCell(v: number | null, severity: 'mild' | 'moderate' | 'severe'): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  // mild = <-10%: expect 20-40% baseline; severe = <-50%: expect <15% baseline
  const thresholds = severity === 'mild'
    ? { green: 15, yellow: 30 }
    : severity === 'moderate'
    ? { green: 8, yellow: 20 }
    : { green: 3, yellow: 10 };
  const cls = v < thresholds.green ? 'green' : v < thresholds.yellow ? 'yellow' : 'red';
  return `<span class="${cls}">${v.toFixed(1)}%</span>`;
}

// VaR / CVaR cell — values are negative; less negative = better
function varCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v > -15 ? 'green' : v > -30 ? 'yellow' : 'red';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
}

// Worst trade cell — much tighter thresholds; a -50% worst is already painful
function worstTradeCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v > -25 ? 'green' : v > -50 ? 'yellow' : 'red';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
}

// Max consecutive losses cell — fewer is better
function lossStreakCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v < 4 ? 'green' : v < 7 ? 'yellow' : 'red';
  return `<span class="${cls}">${v}</span>`;
}

function v2Panel8RowHtml(r: FilterV2Panel8Row, lowN: number, strongN: number, isBaseline = false): string {
  const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN, strongN);
  const nLabel = r.n < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  const optTpSl = (r.opt_tp != null && r.opt_sl != null) ? `${r.opt_tp}/${r.opt_sl}` : '—';
  return `<tr class="${cls}">
    <td>${r.filter}${nLabel}</td>
    <td>${r.n}</td>
    <td>${optTpSl}</td>
    <td>${pctLossCell(r.pct_loss_10, 'mild')}</td>
    <td>${pctLossCell(r.pct_loss_25, 'moderate')}</td>
    <td>${pctLossCell(r.pct_loss_50, 'severe')}</td>
    <td>${varCell(r.var_95)}</td>
    <td>${varCell(r.cvar_95)}</td>
    <td>${worstTradeCell(r.worst_trade)}</td>
    <td>${lossStreakCell(r.max_consecutive_losses)}</td>
  </tr>`;
}

// ── Panel 9 helpers: equity curve & drawdown simulation ──

type FilterV2Panel9Row = {
  filter: string;
  group: string;
  n: number;
  opt_tp: number | null;
  opt_sl: number | null;
  final_equity_mult: number | null;
  max_drawdown_pct: number | null;
  longest_losing_streak: number | null;
  sharpe: number | null;
  kelly_fraction: number | null;
  equity_curve: number[];
};

// Final equity multiplier cell: >1.2 green, 1.0-1.2 yellow, <1.0 red
function finalEquityCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v > 1.2 ? 'green' : v > 1.0 ? 'yellow' : 'red';
  return `<span class="${cls}">${v.toFixed(2)}×</span>`;
}

// Max drawdown cell: > -10% green, -10 to -20% yellow, < -20% red
function maxDdCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v > -10 ? 'green' : v > -20 ? 'yellow' : 'red';
  return `<span class="${cls}">${v.toFixed(1)}%</span>`;
}

// Per-trade Sharpe cell
function tradeSharpeCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v > 0.2 ? 'green' : v > 0 ? 'yellow' : 'red';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(2)}</span>`;
}

// Kelly fraction cell: 0-0.25 green (sensible), 0.25-0.5 yellow (risky), >0.5 red (too aggressive)
// NOTE: in practice you should bet 0.25-0.5 of Kelly, not full Kelly — this column is a signal,
// not a prescription.
function kellyCell(v: number | null): string {
  if (v == null) return '<span style="color:#64748b">—</span>';
  const cls = v === 0 ? 'red' : v <= 0.25 ? 'green' : v <= 0.5 ? 'yellow' : 'red';
  return `<span class="${cls}">${(v * 100).toFixed(0)}%</span>`;
}

// Sparkline SVG — compact equity curve rendered inline per row.
// Width ~130px, height ~24px. y-axis spans [min, max] of the curve;
// x-axis spans the downsampled point count. Adds a faint horizontal line
// at equity=1.0 so the viewer can see whether the curve crosses break-even.
function equitySparklineCell(curve: number[]): string {
  if (!curve || curve.length < 2) return '<span style="color:#64748b">—</span>';
  const W = 130;
  const H = 24;
  const PAD = 2;
  let min = curve[0];
  let max = curve[0];
  for (const v of curve) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Always include equity=1.0 in the range so break-even line is visible
  if (1.0 < min) min = 1.0;
  if (1.0 > max) max = 1.0;
  const range = max - min || 1;
  const xStep = (W - 2 * PAD) / (curve.length - 1);
  const points = curve.map((v, i) => {
    const x = PAD + i * xStep;
    const y = H - PAD - ((v - min) / range) * (H - 2 * PAD);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // Break-even line
  const breakEvenY = H - PAD - ((1.0 - min) / range) * (H - 2 * PAD);
  // Color: end > start green, end < start red
  const color = curve[curve.length - 1] > curve[0] ? '#4ade80' : '#ef4444';
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="vertical-align:middle">
    <line x1="${PAD}" y1="${breakEvenY.toFixed(1)}" x2="${W - PAD}" y2="${breakEvenY.toFixed(1)}" stroke="#475569" stroke-width="0.5" stroke-dasharray="2,2"/>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/>
  </svg>`;
}

function v2Panel9RowHtml(r: FilterV2Panel9Row, lowN: number, strongN: number, isBaseline = false): string {
  const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN, strongN);
  const nLabel = r.n < lowN && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
  const optTpSl = (r.opt_tp != null && r.opt_sl != null) ? `${r.opt_tp}/${r.opt_sl}` : '—';
  return `<tr class="${cls}">
    <td>${r.filter}${nLabel}</td>
    <td>${r.n}</td>
    <td>${optTpSl}</td>
    <td>${equitySparklineCell(r.equity_curve)}</td>
    <td>${finalEquityCell(r.final_equity_mult)}</td>
    <td>${maxDdCell(r.max_drawdown_pct)}</td>
    <td>${lossStreakCell(r.longest_losing_streak)}</td>
    <td>${tradeSharpeCell(r.sharpe)}</td>
    <td>${kellyCell(r.kelly_fraction)}</td>
  </tr>`;
}

export function renderFilterV2Html(data: any): string {
  const panel1 = data.panel1;
  const baseline: FilterV2Row = panel1.baseline;
  const filters: FilterV2Row[] = panel1.filters || [];
  const lowN = panel1.flags?.low_n_threshold ?? 20;
  const strongN = panel1.flags?.strong_n_threshold ?? 100;

  // Horizon variants for Panel 1 — same filters, different label column source.
  const panel1Horizons: Array<{
    key: 't300' | 't120' | 't60';
    label: string;
    baseline: FilterV2Row;
    filters: FilterV2Row[];
  }> = [
    { key: 't300', label: '5 min (T+300)', baseline, filters },
    ...(data.panel1_t120 ? [{ key: 't120' as const, label: '2 min (T+120)', baseline: data.panel1_t120.baseline as FilterV2Row, filters: (data.panel1_t120.filters || []) as FilterV2Row[] }] : []),
    ...(data.panel1_t60  ? [{ key: 't60'  as const, label: '1 min (T+60)',  baseline: data.panel1_t60.baseline  as FilterV2Row, filters: (data.panel1_t60.filters  || []) as FilterV2Row[] }] : []),
  ];

  const p1Tabs = panel1Horizons
    .map(h => `<button type="button" class="p1-tab${h.key === 't300' ? ' active' : ''}" data-horizon="${h.key}" onclick="setPanel1Horizon('${h.key}')">${h.label}</button>`)
    .join('');

  const panel1HorizonPanels = panel1Horizons.map(h => {
    const groups = new Map<string, FilterV2Row[]>();
    for (const f of h.filters) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group)!.push(f);
    }
    const baselineRow = v2RowHtml(h.baseline, lowN, strongN, true);
    const groupRows: string[] = [];
    for (const [groupName, rows] of groups) {
      groupRows.push(`<tr class="row-group-header"><td colspan="7">${groupName}</td></tr>`);
      for (const r of rows) groupRows.push(v2RowHtml(r, lowN, strongN, false));
    }
    const tableId = `panel1-table-${h.key}`;
    return `
    <div class="p1-horizon-panel${h.key === 't300' ? ' active' : ''}" data-horizon="${h.key}">
      <table id="${tableId}" class="panel1-table" data-horizon="${h.key}">
        <thead>
          <tr>
            <th class="sortable" onclick="sortPanel1Table('${tableId}',0,'str')">Filter <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="sortPanel1Table('${tableId}',1,'num')">n (applicable) <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="sortPanel1Table('${tableId}',2,'num')">PUMP <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="sortPanel1Table('${tableId}',3,'num')">DUMP <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="sortPanel1Table('${tableId}',4,'num')">STABLE <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="sortPanel1Table('${tableId}',5,'num')">Win % <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="sortPanel1Table('${tableId}',6,'num')">PUMP:DUMP <span class="arrow">⇅</span></th>
          </tr>
        </thead>
        <tbody>
          ${baselineRow}
          ${groupRows.join('\n          ')}
        </tbody>
      </table>
    </div>`;
  }).join('');

  const legend = `
  <div class="desc" style="margin-top:10px">
    <strong>Legend:</strong>
    <span style="margin-left:8px">Baseline row highlighted blue</span> ·
    <span style="color:#f59e0b">low n &lt; ${lowN} (greyed)</span> ·
    <span style="color:#60a5fa">strong n ≥ ${strongN} (highlighted)</span>
    <br>
    <strong>PUMP:DUMP color scale:</strong>
    <span class="red" style="margin-left:6px">&lt; 1.0 (more losers)</span> ·
    <span class="yellow">1.0 - 1.5 (even/slight edge)</span> ·
    <span class="green">≥ 1.5 (strong edge)</span>
    <br>
    <strong>Horizons:</strong> all three tabs use the same >=+10% PUMP / <=-10% DUMP thresholds — only the checkpoint differs (pct_t60 / pct_t120 / pct_t300). A filter whose win rate decays T+60 → T+300 is showing mean reversion; one that grows is capturing a slow trend.
  </div>`;

  const panel1Html = `
  <div class="card">
    <h2>Panel 1 — ${panel1.title}</h2>
    <div class="desc">${panel1.description}</div>
    <div class="p4-tabs">${p1Tabs}</div>
    ${panel1HorizonPanels}
    ${legend}
  </div>`;

  // ── Panel 2 (T+30-anchored MAE/MFE/Final percentiles) ──
  let panel2Html = '';
  if (data.panel2) {
    const panel2 = data.panel2;
    const baseline2: FilterV2PctRow = panel2.baseline;
    const filters2: FilterV2PctRow[] = panel2.filters || [];
    const lowN2 = panel2.flags?.low_n_threshold ?? 20;
    const strongN2 = panel2.flags?.strong_n_threshold ?? 100;

    const groups2 = new Map<string, FilterV2PctRow[]>();
    for (const f of filters2) {
      if (!groups2.has(f.group)) groups2.set(f.group, []);
      groups2.get(f.group)!.push(f);
    }

    const baselineRow2 = v2PctRowHtml(baseline2, lowN2, strongN2, true);
    const groupRows2: string[] = [];
    for (const [groupName, rows] of groups2) {
      groupRows2.push(`<tr class="row-group-header"><td colspan="10">${groupName}</td></tr>`);
      for (const r of rows) groupRows2.push(v2PctRowHtml(r, lowN2, strongN2, false));
    }

    const table2Html = `
    <table id="panel2-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel2(0,'str')">Filter <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(1,'num')">n <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(2,'num')">MAE p10 <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(3,'num')">MAE p50 <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(4,'num')">MFE p50 <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(5,'num')">MFE p90 <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(6,'num')">Return p10 <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(7,'num')">Return p50 <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(8,'num')">Return p90 <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel2(9,'num')">Sharpe-ish <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${baselineRow2}
        ${groupRows2.join('\n        ')}
      </tbody>
    </table>`;

    const legend2 = `
    <div class="desc" style="margin-top:10px">
      <strong>Anchor:</strong> All percentiles are computed from <code>price_t30</code> (entry price), not graduation open.
      <strong>Window:</strong> T+30 → T+300.
      <br>
      <strong>MAE</strong> (≤ 0): worst dip from entry. <strong>MFE</strong> (≥ 0): best peak from entry. <strong>Return</strong>: final (price_t300/price_t30 − 1).
      <br>
      <strong>Sharpe-ish</strong> = mean(final) / stddev(final). Single number capturing "profitable AND consistent." Sort by this column descending to surface tradeable cohorts.
      <br>
      <strong>Color scales:</strong>
      <span class="green" style="margin-left:6px">MAE &gt; -15%</span>
      <span class="yellow">-15% to -30%</span>
      <span class="red">&lt; -30%</span> ·
      <span class="green">MFE &gt; +30%</span>
      <span class="yellow">+10% to +30%</span>
      <span class="red">&lt; +10%</span> ·
      <span class="green">Sharpe &gt; 0.2</span>
      <span class="yellow">0 to 0.2</span>
      <span class="red">&lt; 0</span>
    </div>`;

    panel2Html = `
    <div class="card">
      <h2>Panel 2 — ${panel2.title}</h2>
      <div class="desc">${panel2.description}</div>
      ${table2Html}
      ${legend2}
    </div>`;
  }

  // ── Panel 3 (Regime Stability — time-bucketed WR + return) ──
  let panel3Html = '';
  if (data.panel3) {
    const panel3 = data.panel3;
    const baseline3: FilterV2RegimeRow = panel3.baseline;
    const filters3: FilterV2RegimeRow[] = panel3.filters || [];
    const lowN3 = panel3.flags?.low_n_threshold ?? 20;
    const strongN3 = panel3.flags?.strong_n_threshold ?? 100;
    const bucketWindows: { bucket: number; start_iso: string; end_iso: string }[] = panel3.bucket_windows || [];

    const groups3 = new Map<string, FilterV2RegimeRow[]>();
    for (const f of filters3) {
      if (!groups3.has(f.group)) groups3.set(f.group, []);
      groups3.get(f.group)!.push(f);
    }

    const baselineRow3 = v2RegimeRowHtml(baseline3, lowN3, strongN3, true);
    const groupRows3: string[] = [];
    for (const [groupName, rows] of groups3) {
      groupRows3.push(`<tr class="row-group-header"><td colspan="12">${groupName}</td></tr>`);
      for (const r of rows) groupRows3.push(v2RegimeRowHtml(r, lowN3, strongN3, false));
    }

    // Bucket window legend (above the table)
    const shortDate = (iso: string) => {
      try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; }
    };
    const windowLegend = bucketWindows.length === 0
      ? '<div class="desc" style="margin-top:6px"><em>No bucket windows available.</em></div>'
      : `<div class="desc" style="margin-top:6px">
          <strong>Bucket windows:</strong>
          ${bucketWindows.map(b => `<span style="margin-right:10px">B${b.bucket}: ${shortDate(b.start_iso)} → ${shortDate(b.end_iso)}</span>`).join(' · ')}
        </div>`;

    const table3Html = `
    <table id="panel3-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel3(0,'str')">Filter <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(1,'num')">n <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(2,'num')">B1 WR <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(3,'num')">B1 Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(4,'num')">B2 WR <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(5,'num')">B2 Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(6,'num')">B3 WR <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(7,'num')">B3 Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(8,'num')">B4 WR <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(9,'num')">B4 Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(10,'num')">WR StdDev <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel3(11,'str')">Stability <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${baselineRow3}
        ${groupRows3.join('\n        ')}
      </tbody>
    </table>`;

    const legend3 = `
    <div class="desc" style="margin-top:10px">
      <strong>Bucketing:</strong> Global time quartiles. The full eligible cohort (label + price_t30 + price_t300 present) is sorted by <code>created_at</code> and split into 4 equal-sized chunks. Every filter row uses the same B1–B4 windows so cells are directly comparable across rows.
      <br>
      <strong>Per-bucket return formula:</strong> <code>((1 + pct_t300/100) / (1 + pct_t30/100) − 1) × 100 − cost_pct</code> where <code>cost_pct</code> is per-token measured slippage (3% fallback). Same formula as the existing regime_analysis.
      <br>
      <strong>WR StdDev:</strong> Population std dev of the four bucket win rates (only buckets with n ≥ 5 contribute). Lower = edge persists across regimes.
      <br>
      <strong>Stability label:</strong>
      <span class="green" style="margin-left:6px">STABLE (&lt; 8)</span>
      <span class="yellow">MODERATE (8–15)</span>
      <span class="red">CLUSTERED (≥ 15)</span>
      <span style="color:#64748b">INSUFFICIENT (fewer than 2 buckets had n ≥ 5)</span>
      <br>
      <strong>Per-bucket WR colors:</strong>
      <span class="green" style="margin-left:6px">≥ 50%</span>
      <span class="yellow">40–49%</span>
      <span class="red">&lt; 40%</span> ·
      <strong>Per-bucket Ret colors:</strong>
      <span class="green" style="margin-left:6px">&gt; +5%</span>
      <span class="yellow">−5% to +5%</span>
      <span class="red">&lt; −5%</span>
      <br>
      Cells render as <code>—</code> when n &lt; 5 in that bucket; that bucket is excluded from the WR StdDev compute.
      <br>
      <em>Sort by WR StdDev ascending to surface the most regime-stable filters.</em>
    </div>`;

    panel3Html = `
    <div class="card">
      <h2>Panel 3 — ${panel3.title}</h2>
      <div class="desc">${panel3.description}</div>
      ${windowLegend}
      ${table3Html}
      ${legend3}
    </div>`;
  }

  // ── Panel 4 (Dynamic TP/SL EV Simulator) ──
  let panel4Html = '';
  let panel4DataScript = '';
  if (data.panel4) {
    const panel4 = data.panel4;
    const baseline4: FilterV2Panel4Row = panel4.baseline;
    const filters4: FilterV2Panel4Row[] = panel4.filters || [];
    const lowN4 = panel4.flags?.low_n_threshold ?? 20;
    const strongN4 = panel4.flags?.strong_n_threshold ?? 100;
    const tpLevels: number[] = panel4.grid.tp_levels;
    const slLevels: number[] = panel4.grid.sl_levels;
    const defaultTp: number = panel4.grid.default_tp;
    const defaultSl: number = panel4.grid.default_sl;

    const tpOptions = tpLevels.map(v => `<option value="${v}"${v === defaultTp ? ' selected' : ''}>${v}%</option>`).join('');
    const slOptions = slLevels.map(v => `<option value="${v}"${v === defaultSl ? ' selected' : ''}>${v}%</option>`).join('');

    const controls = `
    <div class="p4-controls">
      <label>TP %: <select id="p4-tp" onchange="onPanel4Change()">${tpOptions}</select></label>
      <label>SL %: <select id="p4-sl" onchange="onPanel4Change()">${slOptions}</select></label>
      <span class="desc">SL gap ${(panel4.constants.sl_gap_penalty_pct).toFixed(0)}% · TP gap ${(panel4.constants.tp_gap_penalty_pct).toFixed(0)}% · cost: per-token round_trip_slippage_pct (${panel4.constants.cost_pct_fallback}% fallback)</span>
    </div>`;

    // Horizon variants: 5 min (default, T+300), 2 min (T+120), 1 min (T+60).
    // Each horizon gets its own table so the Opt* columns reflect that horizon's
    // per-filter optimum. The TP/SL selector updates Sel* cells in every table
    // so switching tabs keeps client state consistent.
    const horizonDefs: Array<{
      key: 't300' | 't120' | 't60';
      label: string;
      data: { baseline: FilterV2Panel4Row; filters: FilterV2Panel4Row[]; constants: typeof panel4.constants } | null;
    }> = [
      { key: 't300', label: '5 min (T+300)', data: { baseline: baseline4, filters: filters4, constants: panel4.constants } },
      { key: 't120', label: '2 min (T+120)', data: data.panel4_t120 ? { baseline: data.panel4_t120.baseline, filters: data.panel4_t120.filters, constants: data.panel4_t120.constants } : null },
      { key: 't60',  label: '1 min (T+60)',  data: data.panel4_t60  ? { baseline: data.panel4_t60.baseline,  filters: data.panel4_t60.filters,  constants: data.panel4_t60.constants  } : null },
    ];

    const tabsHtml = horizonDefs
      .filter(h => h.data != null)
      .map(h => `<button type="button" class="p4-tab${h.key === 't300' ? ' active' : ''}" data-horizon="${h.key}" onclick="setPanel4Horizon('${h.key}')">${h.label}</button>`)
      .join('');

    // Build one table per horizon. Row index is scoped per-horizon and ties
    // the DOM row to its entry in window.__PANEL_4_BY_HORIZON[horizon].rows.
    const horizonPayloads: Record<string, { tp_levels: number[]; sl_levels: number[]; default_tp: number; default_sl: number; rows: Array<{ combos: FilterV2Panel4Combos }> }> = {};
    const horizonPanelsHtml = horizonDefs.map(h => {
      if (!h.data) return '';
      const { baseline, filters, constants } = h.data;
      const groups = new Map<string, FilterV2Panel4Row[]>();
      for (const f of filters) {
        if (!groups.has(f.group)) groups.set(f.group, []);
        groups.get(f.group)!.push(f);
      }
      const baselineRow = v2Panel4RowHtml(baseline, lowN4, strongN4, 0, true);
      const groupRows: string[] = [];
      let rIdx = 1;
      for (const [groupName, rows] of groups) {
        groupRows.push(`<tr class="row-group-header"><td colspan="10">${groupName}</td></tr>`);
        for (const r of rows) {
          groupRows.push(v2Panel4RowHtml(r, lowN4, strongN4, rIdx, false));
          rIdx++;
        }
      }
      horizonPayloads[h.key] = {
        tp_levels: tpLevels,
        sl_levels: slLevels,
        default_tp: defaultTp,
        default_sl: defaultSl,
        rows: [
          { combos: baseline.combos },
          ...filters.map(f => ({ combos: f.combos })),
        ],
      };
      const tableId = `panel4-table-${h.key}`;
      const fallThrough = constants.fall_through_column;
      const checkpointsList = Array.isArray(constants.checkpoints)
        ? constants.checkpoints.join(', ')
        : String(constants.checkpoints);
      return `
      <div class="p4-horizon-panel${h.key === 't300' ? ' active' : ''}" data-horizon="${h.key}">
        <div class="desc" style="margin-bottom:8px;color:#94a3b8">
          <strong>Fall-through:</strong> <code>${fallThrough}</code> · <strong>Exits scanned:</strong> ${checkpointsList}
        </div>
        <table id="${tableId}" class="panel4-table" data-horizon="${h.key}">
          <thead>
            <tr>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',0,'str')">Filter <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',1,'num')">n <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',2,'num')">Sel Avg Ret <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',3,'num')">Sel Med Ret <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',4,'num')">Sel Win % <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',5,'num')">Sel vs Base <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',6,'num')">Opt TP <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',7,'num')">Opt SL <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',8,'num')">Opt Avg Ret <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel4Table('${tableId}',9,'num')">Opt Win % <span class="arrow">⇅</span></th>
            </tr>
          </thead>
          <tbody>
            ${baselineRow}
            ${groupRows.join('\n            ')}
          </tbody>
        </table>
      </div>`;
    }).join('');

    const legend4 = `
    <div class="desc" style="margin-top:10px">
      <strong>Entry:</strong> T+30 (PumpSwap pool price). <strong>Horizons:</strong> tabs switch the fall-through checkpoint (T+60 / T+120 / T+300) and truncate the exit scan to that point. SL is checked first at each checkpoint, then TP.
      <br>
      <strong>Gap penalties:</strong> SL fills at −${(panel4.constants.sl_gap_penalty_pct).toFixed(0)}% adverse (e.g., 10% SL → −12% realised); TP fills at −${(panel4.constants.tp_gap_penalty_pct).toFixed(0)}% of TP (e.g., 30% TP → +27% realised). <strong>Cost:</strong> per-token <code>round_trip_slippage_pct</code> with ${panel4.constants.cost_pct_fallback}% fallback subtracted from every exit.
      <br>
      <strong>Optimum rule:</strong> per-filter max avg return across the grid, gated by filter n ≥ ${panel4.constants.min_n_for_optimum} AND combo tp_hit_count ≥ ${panel4.constants.min_tp_hits_for_optimum}. <code>—</code> in Opt* columns means the filter cohort is too small or no grid combo ever triggered a take-profit.
      <br>
      <strong>Sel vs Base:</strong> <code>filter_avg_ret − baseline_avg_ret</code> at the currently-selected TP/SL. Computed client-side on every dropdown change. Baseline row always shows <code>+0.0%</code>.
      <br>
      <strong>Color scales:</strong>
      <span class="green" style="margin-left:6px">Avg/Med &gt; +0.5%</span>
      <span class="yellow">−0.5% to +0.5%</span>
      <span class="red">&lt; −0.5%</span> ·
      <span class="green">Win ≥ 50%</span>
      <span class="yellow">40–49%</span>
      <span class="red">&lt; 40%</span>
      <br>
      <strong>URL:</strong> current TP/SL selection and active horizon are mirrored to the URL hash (<code>#p4=tp30,sl10,h=t300</code>) so reloads and shared links preserve the view.
    </div>`;

    panel4Html = `
    <div class="card">
      <h2>Panel 4 — ${panel4.title}</h2>
      <div class="desc">${panel4.description}</div>
      <div class="p4-tabs">${tabsHtml}</div>
      ${controls}
      ${horizonPanelsHtml}
      ${legend4}
    </div>`;

    panel4DataScript = `
  <script>
    window.__PANEL_4_BY_HORIZON = ${JSON.stringify(horizonPayloads)};
    // Back-compat alias for any code that still reads __PANEL_4.
    window.__PANEL_4 = window.__PANEL_4_BY_HORIZON.t300;
  </script>`;
  }

  // ── Panel 5 (Statistical Significance — Wilson CI + bootstrap CI) ──
  let panel5Html = '';
  if (data.panel5) {
    const panel5 = data.panel5;
    const baseline5: FilterV2Panel5Row = panel5.baseline;
    const filters5: FilterV2Panel5Row[] = panel5.filters || [];
    const lowN5 = panel5.flags?.low_n_threshold ?? 30;
    const strongN5 = panel5.flags?.strong_n_threshold ?? 100;

    const groups5 = new Map<string, FilterV2Panel5Row[]>();
    for (const f of filters5) {
      if (!groups5.has(f.group)) groups5.set(f.group, []);
      groups5.get(f.group)!.push(f);
    }

    const baselineRow5 = v2Panel5RowHtml(baseline5, lowN5, strongN5, true);
    const groupRows5: string[] = [];
    for (const [groupName, rows] of groups5) {
      groupRows5.push(`<tr class="row-group-header"><td colspan="9">${groupName}</td></tr>`);
      for (const r of rows) groupRows5.push(v2Panel5RowHtml(r, lowN5, strongN5, false));
    }

    const table5Html = `
    <table id="panel5-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel5(0,'str')">Filter <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel5(1,'num')">n <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel5(2,'num')">Win % <span class="arrow">⇅</span></th>
          <th>Win % 95% CI</th>
          <th class="sortable" onclick="sortPanel5(4,'num')">p vs base <span class="arrow">⇅</span></th>
          <th>Opt TP/SL</th>
          <th class="sortable" onclick="sortPanel5(6,'num')">Opt Avg Ret <span class="arrow">⇅</span></th>
          <th>Avg Ret 95% CI (boot)</th>
          <th class="sortable" onclick="sortPanel5(8,'str')">Verdict <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${baselineRow5}
        ${groupRows5.join('\n        ')}
      </tbody>
    </table>`;

    const legend5 = `
    <div class="desc" style="margin-top:10px">
      <strong>Win % 95% CI:</strong> Wilson score interval — closed-form, stable at small n. If the CI is wide, the raw win rate is noisy.
      <br>
      <strong>p vs base:</strong> two-proportion z-test vs the ALL-labeled baseline win rate. <span class="green">&lt; 0.05</span> = significantly different, <span class="yellow">&lt; 0.10</span> = marginally, <span class="red">≥ 0.10</span> = indistinguishable.
      <br>
      <strong>Avg Ret 95% CI (boot):</strong> 1000-iteration bootstrap on the per-token cost-adjusted return vector at the filter's Panel 4 optimum (TP/SL). <span class="green">CI entirely above 0</span> = profitable with 95% confidence. <span class="red">entirely below 0</span> = the optimum is a loser in disguise.
      <br>
      <strong>Verdict:</strong>
      <span class="green">SIGNIFICANT</span> (p&lt;0.05 AND boot CI &gt; 0) ·
      <span class="yellow">MARGINAL</span> (one of the two) ·
      <span class="red">NOISE</span> (neither) ·
      <span style="color:#64748b">INSUFFICIENT</span> (n &lt; 30)
      <br>
      <em>Gate all other panels on this column — a high Opt Avg Ret is meaningless if its bootstrap CI straddles zero.</em>
    </div>`;

    panel5Html = `
    <div class="card">
      <h2>Panel 5 — ${panel5.title}</h2>
      <div class="desc">${panel5.description}</div>
      ${table5Html}
      ${legend5}
    </div>`;
  }

  // ── Panel 6 (Multi-Filter Intersection — 2-way + 3-way AND) ──
  let panel6Html = '';
  if (data.panel6) {
    const panel6 = data.panel6;
    const filterNames: { name: string; group: string }[] = panel6.filter_names || [];
    const dynamic: FilterV2Panel6Dynamic = panel6.dynamic;
    const topPairs: FilterV2Panel6PairRow[] = panel6.top_pairs || [];

    // Group dropdown options by filter family for readability
    const groups6 = new Map<string, { name: string; group: string }[]>();
    for (const fn of filterNames) {
      if (!groups6.has(fn.group)) groups6.set(fn.group, []);
      groups6.get(fn.group)!.push(fn);
    }

    const mkOptions = (selected: string | null) => {
      const parts: string[] = ['<option value="">(none)</option>'];
      for (const [groupName, items] of groups6) {
        parts.push(`<optgroup label="${escHtml(groupName)}">`);
        for (const it of items) {
          const sel = it.name === selected ? ' selected' : '';
          parts.push(`<option value="${escHtml(it.name)}"${sel}>${escHtml(it.name)}</option>`);
        }
        parts.push('</optgroup>');
      }
      return parts.join('');
    };

    const selA = dynamic && dynamic.selected[0] ? dynamic.selected[0] : null;
    const selB = dynamic && dynamic.selected[1] ? dynamic.selected[1] : null;
    const selC = dynamic && dynamic.selected[2] ? dynamic.selected[2] : null;

    const controls6 = `
    <div class="p4-controls">
      <label>Filter A: <select id="p6-a" onchange="onPanel6Change()">${mkOptions(selA)}</select></label>
      <label>Filter B: <select id="p6-b" onchange="onPanel6Change()">${mkOptions(selB)}</select></label>
      <label>Filter C: <select id="p6-c" onchange="onPanel6Change()">${mkOptions(selC)}</select></label>
      <span class="desc">Intersection is ANDed. Change any dropdown to reload the page with the new selection.</span>
    </div>`;

    let dynamicHtml = '';
    if (!dynamic) {
      dynamicHtml = `<div class="desc" style="margin:10px 0"><em>Select at least one filter from Filter A to see an intersection.</em></div>`;
    } else {
      const tpSl = (dynamic.opt_tp != null && dynamic.opt_sl != null) ? `${dynamic.opt_tp}/${dynamic.opt_sl}` : '—';
      const nWarn = dynamic.n < 30
        ? ` <span class="lowN">(low n, stats unreliable)</span>`
        : '';
      dynamicHtml = `
      <table id="panel6-dynamic-table" style="margin-top:12px">
        <thead>
          <tr>
            <th>Active combination</th>
            <th>n</th>
            <th>Opt TP/SL</th>
            <th>Opt Avg Ret</th>
            <th>Opt Win %</th>
            <th>Lift vs best single</th>
          </tr>
        </thead>
        <tbody>
          <tr class="row-baseline">
            <td>${dynamic.selected.map(s => `<code>${escHtml(s)}</code>`).join(' AND ')}</td>
            <td>${dynamic.n}${nWarn}</td>
            <td>${tpSl}</td>
            <td>${p4OptAvgRetCell(dynamic.opt_avg_ret)}</td>
            <td>${p4OptWinRateCell(dynamic.opt_win_rate)}</td>
            <td>${liftCell(dynamic.lift_vs_best_single)}</td>
          </tr>
        </tbody>
      </table>`;
    }

    const topPairsByHorizon: Array<{ key: 't300' | 't120' | 't60'; label: string; pairs: FilterV2Panel6PairRow[] }> = [
      { key: 't300', label: '5 min (T+300)', pairs: topPairs },
      { key: 't120', label: '2 min (T+120)', pairs: (panel6.top_pairs_t120 || []) as FilterV2Panel6PairRow[] },
      { key: 't60',  label: '1 min (T+60)',  pairs: (panel6.top_pairs_t60  || []) as FilterV2Panel6PairRow[] },
    ];

    const buildTopPairsRows = (rows: FilterV2Panel6PairRow[]): string => {
      if (rows.length === 0) {
        return '<tr><td colspan="8" style="color:#64748b;text-align:center"><em>No two-filter intersections meet the criteria (n ≥ 30 and lift &gt; 0) at this horizon. Collect more data.</em></td></tr>';
      }
      return rows.map(p => {
        const tpSl = `${p.opt_tp}/${p.opt_sl}`;
        return `<tr>
            <td><code>${escHtml(p.filter_a)}</code></td>
            <td><code>${escHtml(p.filter_b)}</code></td>
            <td>${p.n}</td>
            <td>${tpSl}</td>
            <td>${p4OptAvgRetCell(p.opt_avg_ret)}</td>
            <td>${p4OptWinRateCell(p.opt_win_rate)}</td>
            <td>${p4OptAvgRetCell(p.single_a_opt)} / ${p4OptAvgRetCell(p.single_b_opt)}</td>
            <td>${liftCell(p.lift)}</td>
          </tr>`;
      }).join('\n        ');
    };

    const p6Tabs = topPairsByHorizon
      .map(h => `<button type="button" class="p6-tab${h.key === 't300' ? ' active' : ''}" data-horizon="${h.key}" onclick="setPanel6Horizon('${h.key}')">${h.label}</button>`)
      .join('');

    const p6HorizonTables = topPairsByHorizon.map(h => {
      const tableId = `panel6-pairs-table-${h.key}`;
      return `
      <div class="p6-horizon-panel${h.key === 't300' ? ' active' : ''}" data-horizon="${h.key}">
        <table id="${tableId}" class="panel6-pairs-table" data-horizon="${h.key}">
          <thead>
            <tr>
              <th class="sortable" onclick="sortPanel6PairsTable('${tableId}',0,'str')">Filter A <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel6PairsTable('${tableId}',1,'str')">Filter B <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel6PairsTable('${tableId}',2,'num')">n <span class="arrow">⇅</span></th>
              <th>Opt TP/SL</th>
              <th class="sortable" onclick="sortPanel6PairsTable('${tableId}',4,'num')">Opt Avg Ret <span class="arrow">⇅</span></th>
              <th class="sortable" onclick="sortPanel6PairsTable('${tableId}',5,'num')">Opt Win % <span class="arrow">⇅</span></th>
              <th>Singles (A / B)</th>
              <th class="sortable" onclick="sortPanel6PairsTable('${tableId}',7,'num')">Lift <span class="arrow">⇅</span></th>
            </tr>
          </thead>
          <tbody>
            ${buildTopPairsRows(h.pairs)}
          </tbody>
        </table>
      </div>`;
    }).join('');

    const topPairsTable = `
    <h3 style="margin-top:20px;color:#e2e8f0;font-size:14px">Top 20 two-filter intersections (n ≥ 30, lift &gt; 0, sorted by Opt Avg Ret)</h3>
    <div class="p4-tabs">${p6Tabs}</div>
    ${p6HorizonTables}`;

    const legend6 = `
    <div class="desc" style="margin-top:10px">
      <strong>Lift vs best single:</strong> <code>combo_opt_avg_ret − max(component_opt_avg_ret)</code>. Positive = the combo beats its best constituent (real information gained). Zero or negative = the filters are redundant or hurt each other.
      <br>
      <strong>Small-n warning:</strong> Intersections with n &lt; 30 are flagged but not hidden. The optimum TP/SL may still show, but the bootstrap CI (Panel 5) would be untrustworthy at that n.
      <br>
      <strong>Top 20 pairs:</strong> auto-scan of all C(53, 2) = 1378 two-filter intersections. If the list is empty, either data is too sparse or no pairs have positive lift — investigate with Panel 5 first.
      <br>
      <em>Start by picking the best SIGNIFICANT single filter from Panel 5, then add a second filter to see if lift is positive.</em>
    </div>`;

    panel6Html = `
    <div class="card">
      <h2>Panel 6 — ${panel6.title}</h2>
      <div class="desc">${panel6.description}</div>
      ${controls6}
      ${dynamicHtml}
      ${topPairsTable}
      ${legend6}
    </div>`;
  }

  // ── Panel 7 (Walk-Forward Validation) ──
  let panel7Html = '';
  if (data.panel7) {
    const panel7 = data.panel7;
    const baseline7: FilterV2Panel7Row = panel7.baseline;
    const filters7: FilterV2Panel7Row[] = panel7.filters || [];
    const lowN7 = panel7.flags?.low_n_threshold ?? 30;
    const strongN7 = panel7.flags?.strong_n_threshold ?? 100;
    const split = panel7.split || {};

    const groups7 = new Map<string, FilterV2Panel7Row[]>();
    for (const f of filters7) {
      if (!groups7.has(f.group)) groups7.set(f.group, []);
      groups7.get(f.group)!.push(f);
    }

    const baselineRow7 = v2Panel7RowHtml(baseline7, lowN7, strongN7, true);
    const groupRows7: string[] = [];
    for (const [groupName, rows] of groups7) {
      groupRows7.push(`<tr class="row-group-header"><td colspan="8">${groupName}</td></tr>`);
      for (const r of rows) groupRows7.push(v2Panel7RowHtml(r, lowN7, strongN7, false));
    }

    const splitLegend = (split.train_start_iso && split.test_end_iso)
      ? `<div class="desc" style="margin-top:6px"><strong>Split:</strong>
          TRAIN ${split.train_start_iso.slice(0,10)} → ${split.train_end_iso.slice(0,10)} (n=${split.n_train}) ·
          TEST ${split.test_start_iso.slice(0,10)} → ${split.test_end_iso.slice(0,10)} (n=${split.n_test})
          ${Math.round((split.train_frac || 0.7) * 100)}/${Math.round((1 - (split.train_frac || 0.7)) * 100)} time split</div>`
      : '<div class="desc" style="margin-top:6px"><em>No split windows available.</em></div>';

    const table7Html = `
    <table id="panel7-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel7(0,'str')">Filter <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel7(1,'num')">n train <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel7(2,'num')">n test <span class="arrow">⇅</span></th>
          <th>Train TP/SL</th>
          <th class="sortable" onclick="sortPanel7(4,'num')">Train Avg Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel7(5,'num')">Test Avg Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel7(6,'num')">Degradation <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel7(7,'str')">Verdict <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${baselineRow7}
        ${groupRows7.join('\n        ')}
      </tbody>
    </table>`;

    const legend7 = `
    <div class="desc" style="margin-top:10px">
      <strong>Method:</strong> Sort all eligible rows by <code>created_at</code>. Find Panel 4's optimum TP/SL on the first 70% (TRAIN). Apply that exact (TP, SL) — without re-optimization — to the last 30% (TEST). The optimum was chosen from a 12×10=120 combo grid, so multiple-testing / selection bias is real; this panel quantifies it.
      <br>
      <strong>Degradation:</strong> <code>train_avg_ret − test_avg_ret</code>, in percentage points. Small or negative = robust edge. Large positive = the optimum was a lucky corner of the grid.
      <br>
      <strong>Verdict:</strong>
      <span class="green">ROBUST (&lt; 2pp)</span> ·
      <span class="yellow">DEGRADED (2–5pp)</span> ·
      <span class="red">OVERFIT (&gt; 5pp)</span> ·
      <span style="color:#64748b">INSUFFICIENT (train or test n &lt; 20)</span>
      <br>
      <strong>Cross-check:</strong> a filter that is ROBUST here should also be STABLE or MODERATE in Panel 3. A filter that is SIGNIFICANT in Panel 5 but OVERFIT here means the optimum is noise — trust the baseline TP/SL instead.
      <br>
      <em>Sort by Degradation ascending to surface the most robust filters.</em>
    </div>`;

    panel7Html = `
    <div class="card">
      <h2>Panel 7 — ${panel7.title}</h2>
      <div class="desc">${panel7.description}</div>
      ${splitLegend}
      ${table7Html}
      ${legend7}
    </div>`;
  }

  // ── Panel 8 (Loss Tail & Risk Metrics) ──
  let panel8Html = '';
  if (data.panel8) {
    const panel8 = data.panel8;
    const baseline8: FilterV2Panel8Row = panel8.baseline;
    const filters8: FilterV2Panel8Row[] = panel8.filters || [];
    const lowN8 = panel8.flags?.low_n_threshold ?? 30;
    const strongN8 = panel8.flags?.strong_n_threshold ?? 100;

    const groups8 = new Map<string, FilterV2Panel8Row[]>();
    for (const f of filters8) {
      if (!groups8.has(f.group)) groups8.set(f.group, []);
      groups8.get(f.group)!.push(f);
    }

    const baselineRow8 = v2Panel8RowHtml(baseline8, lowN8, strongN8, true);
    const groupRows8: string[] = [];
    for (const [groupName, rows] of groups8) {
      groupRows8.push(`<tr class="row-group-header"><td colspan="10">${groupName}</td></tr>`);
      for (const r of rows) groupRows8.push(v2Panel8RowHtml(r, lowN8, strongN8, false));
    }

    const table8Html = `
    <table id="panel8-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel8(0,'str')">Filter <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel8(1,'num')">n <span class="arrow">⇅</span></th>
          <th>Opt TP/SL</th>
          <th class="sortable" onclick="sortPanel8(3,'num')">% &lt;-10% <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel8(4,'num')">% &lt;-25% <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel8(5,'num')">% &lt;-50% <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel8(6,'num')">VaR 95% <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel8(7,'num')">CVaR 95% <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel8(8,'num')">Worst <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel8(9,'num')">Max Loss Streak <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${baselineRow8}
        ${groupRows8.join('\n        ')}
      </tbody>
    </table>`;

    const legend8 = `
    <div class="desc" style="margin-top:10px">
      <strong>Method:</strong> All metrics are computed on the <em>cost-adjusted</em> return distribution at each filter's Panel 4 optimum TP/SL. This is the same return array Panel 4 uses, so the rankings line up.
      <br>
      <strong>% &lt;-X%:</strong> fraction of trades that closed worse than −X%. Lower is better. Tracks CLAUDE.md's "18.2% of vel 5-20 trades lose &gt;50%" claim — sanity-checks whether the 10% SL is actually containing the tail.
      <br>
      <strong>VaR 95%:</strong> 5th percentile of the return distribution (the worst 5% starts here). <strong>CVaR 95%:</strong> mean of the bottom 5% (average loss when you're in the worst 5%). Both are negative; less negative = safer.
      <br>
      <strong>Worst:</strong> the single worst trade in the filter's distribution. <strong>Max Loss Streak:</strong> longest run of consecutive losses in chronological order.
      <br>
      <em>Cross-check:</em> a SIGNIFICANT filter in Panel 5 should have a manageable Worst (&gt;−50%) and CVaR (&gt;−30%) here. If the tail is fatter than expected, the Sharpe-ish from Panel 2 is misleading and the Kelly fraction in Panel 9 will be tiny.
    </div>`;

    panel8Html = `
    <div class="card">
      <h2>Panel 8 — ${panel8.title}</h2>
      <div class="desc">${panel8.description}</div>
      ${table8Html}
      ${legend8}
    </div>`;
  }

  // ── Panel 9 (Equity Curve & Drawdown Simulation) ──
  let panel9Html = '';
  if (data.panel9) {
    const panel9 = data.panel9;
    const baseline9: FilterV2Panel9Row = panel9.baseline;
    const filters9: FilterV2Panel9Row[] = panel9.filters || [];
    const lowN9 = panel9.flags?.low_n_threshold ?? 30;
    const strongN9 = panel9.flags?.strong_n_threshold ?? 100;

    const groups9 = new Map<string, FilterV2Panel9Row[]>();
    for (const f of filters9) {
      if (!groups9.has(f.group)) groups9.set(f.group, []);
      groups9.get(f.group)!.push(f);
    }

    const baselineRow9 = v2Panel9RowHtml(baseline9, lowN9, strongN9, true);
    const groupRows9: string[] = [];
    for (const [groupName, rows] of groups9) {
      groupRows9.push(`<tr class="row-group-header"><td colspan="9">${groupName}</td></tr>`);
      for (const r of rows) groupRows9.push(v2Panel9RowHtml(r, lowN9, strongN9, false));
    }

    const table9Html = `
    <table id="panel9-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel9(0,'str')">Filter <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel9(1,'num')">n <span class="arrow">⇅</span></th>
          <th>Opt TP/SL</th>
          <th>Equity Curve</th>
          <th class="sortable" onclick="sortPanel9(4,'num')">Final Equity <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel9(5,'num')">Max DD <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel9(6,'num')">Longest Loss Streak <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel9(7,'num')">Sharpe <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel9(8,'num')">Kelly <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${baselineRow9}
        ${groupRows9.join('\n        ')}
      </tbody>
    </table>`;

    const legend9 = `
    <div class="desc" style="margin-top:10px">
      <strong>Method:</strong> Take the filter's cost-adjusted return array at its Panel 4 optimum TP/SL, sorted by <code>created_at</code>. Simulate a unit-sized portfolio that compounds geometrically trade by trade: <code>equity[i+1] = equity[i] × (1 + r[i]/100)</code>, clamped at −99% per trade. Max drawdown is the largest peak-to-trough drop along the curve.
      <br>
      <strong>Final Equity:</strong> ending multiplier (1.5× = portfolio grew 50%). <strong>Max DD:</strong> worst peak-to-trough drawdown as a percentage. <strong>Longest Loss Streak:</strong> maximum run of consecutive losing trades. <strong>Sharpe:</strong> per-trade <code>mean(r) / stdev(r)</code> — not annualized, comparable across filters.
      <br>
      <strong>Kelly:</strong> full Kelly fraction <code>(p·b − q) / b</code> where p=win rate, b=avg_win/avg_loss. Displayed as %. <em>Do not actually bet full Kelly</em> — use 0.25–0.5 Kelly in practice. A high Kelly column just means the win rate and payoff ratio look healthy together.
      <br>
      <strong>Sparkline:</strong> green = ends above start, red = ends below. Faint dashed horizontal line marks equity=1.0 (break-even).
      <br>
      <em>Cross-check:</em> a SIGNIFICANT (Panel 5) + ROBUST (Panel 7) filter should show a rising green sparkline, Max DD &gt; −20%, and Sharpe &gt; 0.2 here. If it doesn't, the per-trade edge is not surviving sequencing and the filter isn't tradeable as a standalone strategy.
    </div>`;

    panel9Html = `
    <div class="card">
      <h2>Panel 9 — ${panel9.title}</h2>
      <div class="desc">${panel9.description}</div>
      ${table9Html}
      ${legend9}
    </div>`;
  }

  // ── Panel 11 (Combo Filter Regime Stability) ──
  let panel11Html = '';
  if (data.panel11) {
    const panel11 = data.panel11;
    const baseline11: FilterV2ComboRegimeRow = panel11.baseline;
    const filters11: FilterV2ComboRegimeRow[] = panel11.filters || [];
    const lowN11 = panel11.flags?.low_n_threshold ?? 20;
    const strongN11 = panel11.flags?.strong_n_threshold ?? 100;
    const bucketWindows11: { bucket: number; start_iso: string; end_iso: string }[] = panel11.bucket_windows || [];

    const baselineRow11 = v2ComboRegimeRowHtml(baseline11, lowN11, strongN11, true);
    const dataRows11 = filters11.map((r: FilterV2ComboRegimeRow) => v2ComboRegimeRowHtml(r, lowN11, strongN11, false)).join('\n        ');

    const shortDate = (iso: string) => {
      try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; }
    };
    const windowLegend11 = bucketWindows11.length === 0
      ? '<div class="desc" style="margin-top:6px"><em>No bucket windows available.</em></div>'
      : `<div class="desc" style="margin-top:6px">
          <strong>Bucket windows:</strong>
          ${bucketWindows11.map((b: any) => `<span style="margin-right:10px">B${b.bucket}: ${shortDate(b.start_iso)} → ${shortDate(b.end_iso)}</span>`).join(' · ')}
        </div>`;

    panel11Html = `
    <div class="card">
      <h2>Panel 11 — ${panel11.title}</h2>
      <div class="desc">${panel11.description}</div>
      ${windowLegend11}
      <table id="panel11-table">
        <thead>
          <tr>
            <th class="sortable" onclick="v2GenericSort('panel11-table',0,'str')">Combo <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',1,'num')">n <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',2,'num')">Sim Ret <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',3,'str')">Beats? <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',4,'num')">B1 WR <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',5,'num')">B1 Ret <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',6,'num')">B2 WR <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',7,'num')">B2 Ret <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',8,'num')">B3 WR <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',9,'num')">B3 Ret <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',10,'num')">B4 WR <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',11,'num')">B4 Ret <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',12,'num')">WR StdDev <span class="arrow">⇅</span></th>
            <th class="sortable" onclick="v2GenericSort('panel11-table',13,'str')">Stability <span class="arrow">⇅</span></th>
          </tr>
        </thead>
        <tbody>
          ${baselineRow11}
          ${dataRows11}
        </tbody>
      </table>
      <div class="desc" style="margin-top:10px">
        <strong>Entry gate:</strong> T+30 price +5% to +100% from open (same gate as /api/best-combos). Only cross-group pairs with n ≥ 20 are shown (max 40 rows).
        <br>
        <strong>Sort:</strong> Sim return descending by default — same order as the best-combos leaderboard. Click any column header to re-sort; click WR StdDev to find the most regime-stable combos.
        <br>
        <strong>Sim Ret:</strong> Simulated avg return at 10% SL / 50% TP with entry gate, same methodology as /api/best-combos.
        <strong>Beats?:</strong> YES = sim return beats the +1.7% baseline (≥ +0.3 pp above +1.4% floor) on n ≥ 100.
        <br>
        <strong>WR StdDev:</strong> Population std dev of bucket win rates (buckets with n &lt; 5 excluded).
        <strong>Stability:</strong>
        <span class="green" style="margin-left:6px">STABLE (&lt; 8)</span>
        <span class="yellow">MODERATE (8–15)</span>
        <span class="red">CLUSTERED (≥ 15)</span>
        <span style="color:#64748b">INSUFFICIENT (&lt; 2 buckets with n ≥ 5)</span>
      </div>
    </div>`;
  }

  // ── Panel 10 (Dynamic Position Monitoring Optimizer) ──
  let panel10Html = '';
  if (data.panel10) {
    const panel10 = data.panel10;
    const baseline10 = panel10.baseline;
    const filters10 = panel10.filters || [];
    const categoryAggs10 = panel10.category_aggregates || [];
    const overall10 = panel10.overall_aggregate;
    const lowN10 = panel10.flags?.low_n_threshold ?? 30;
    const strongN10 = panel10.flags?.strong_n_threshold ?? 100;

    // Cell helpers for DPM columns — '—' for null, color-coded for avg ret
    const p10Cell = (v: any): string => {
      if (v == null || v === '') return '<span style="color:#64748b">—</span>';
      return String(v);
    };
    const p10RetCell = (v: number | null | undefined): string => {
      if (v == null) return '<span style="color:#64748b">—</span>';
      const cls = v > 0.5 ? 'green' : v > -0.5 ? 'yellow' : 'red';
      const sign = v > 0 ? '+' : '';
      return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
    };
    const p10WinCell = (v: number | null | undefined): string => {
      if (v == null) return '<span style="color:#64748b">—</span>';
      const cls = v >= 50 ? 'green' : v >= 40 ? 'yellow' : 'red';
      return `<span class="${cls}">${v}%</span>`;
    };
    const p10DeltaCell = (opt: any): string => {
      if (!opt || opt.avg_ret == null || opt.fallthrough_avg_ret == null) {
        return '<span style="color:#64748b">—</span>';
      }
      const delta = opt.avg_ret - opt.fallthrough_avg_ret;
      const cls = delta > 0.25 ? 'green' : delta > -0.25 ? 'yellow' : 'red';
      const sign = delta > 0 ? '+' : '';
      return `<span class="${cls}">${sign}${delta.toFixed(1)}pp</span>`;
    };

    // Row builder for per-filter optimum table
    const p10RowHtml = (r: any, isBaseline = false): string => {
      const cls = isBaseline ? 'row-baseline' : v2RowClass(r.n, lowN10, strongN10);
      const nLabel = r.n < lowN10 && !isBaseline ? '<span class="lowN">(low n)</span>' : '';
      const opt = r.optimal;
      return `<tr class="${cls}">
        <td>${escHtml(r.filter)}${nLabel}</td>
        <td>${r.n}</td>
        <td>${p10RetCell(opt?.fallthrough_avg_ret)}</td>
        <td>${p10Cell(opt?.trailing_sl)}</td>
        <td>${opt?.sl_delay != null ? opt.sl_delay + 's' : p10Cell(null)}</td>
        <td>${p10Cell(opt?.trailing_tp)}</td>
        <td>${opt?.breakeven != null ? opt.breakeven + '%' : p10Cell(null)}</td>
        <td>${p10RetCell(opt?.avg_ret)}</td>
        <td>${p10WinCell(opt?.win_rate)}</td>
        <td>${p10DeltaCell(opt)}</td>
      </tr>`;
    };

    // Group per-filter rows by category
    const groups10 = new Map<string, any[]>();
    for (const f of filters10) {
      if (!groups10.has(f.group)) groups10.set(f.group, []);
      groups10.get(f.group)!.push(f);
    }
    const baselineRow10 = p10RowHtml(baseline10, true);
    const groupRows10: string[] = [];
    for (const [groupName, rows] of groups10) {
      groupRows10.push(`<tr class="row-group-header"><td colspan="10">${escHtml(groupName)}</td></tr>`);
      for (const r of rows) groupRows10.push(p10RowHtml(r, false));
    }

    const perFilterTable = `
    <h3 style="margin-top:16px;margin-bottom:6px">Per-Filter Optimum DPM Values</h3>
    <table id="panel10-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel10(0,'str')">Filter <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel10(1,'num')">n <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel10(2,'num')">Fallthrough Avg <span class="arrow">⇅</span></th>
          <th>Opt Trailing SL</th>
          <th>Opt SL Delay</th>
          <th>Opt Trailing TP</th>
          <th>Opt Breakeven</th>
          <th class="sortable" onclick="sortPanel10(7,'num')">Opt Avg Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel10(8,'num')">Opt Win % <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel10(9,'num')">Δ vs Fallthrough <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${baselineRow10}
        ${groupRows10.join('\n        ')}
      </tbody>
    </table>`;

    // ── Per-category aggregate table ──
    const categoryRowHtml = (cat: any): string => {
      const opt = cat.optimal;
      const eligibleLabel = `${cat.eligible_count}/${cat.filter_count}`;
      return `<tr>
        <td>${escHtml(cat.group)}</td>
        <td>${eligibleLabel}</td>
        <td>${p10RetCell(opt?.fallthrough_avg_ret)}</td>
        <td>${p10Cell(opt?.trailing_sl)}</td>
        <td>${opt?.sl_delay != null ? opt.sl_delay + 's' : p10Cell(null)}</td>
        <td>${p10Cell(opt?.trailing_tp)}</td>
        <td>${opt?.breakeven != null ? opt.breakeven + '%' : p10Cell(null)}</td>
        <td>${p10RetCell(opt?.avg_ret)}</td>
        <td>${p10WinCell(opt?.win_rate)}</td>
        <td>${p10DeltaCell(opt)}</td>
      </tr>`;
    };
    const categoryRows = categoryAggs10.map((c: any) => categoryRowHtml(c)).join('');

    const categoryTable = `
    <h3 style="margin-top:20px;margin-bottom:6px">Best DPM Values Per Filter Category <span style="color:#64748b;font-size:12px;font-weight:normal">(n-weighted avg across filters in category)</span></h3>
    <table id="panel10-cat-table">
      <thead>
        <tr>
          <th>Category</th>
          <th>Eligible Filters</th>
          <th>Fallthrough Avg</th>
          <th>Best Trailing SL</th>
          <th>Best SL Delay</th>
          <th>Best Trailing TP</th>
          <th>Best Breakeven</th>
          <th>Avg Ret</th>
          <th>Win %</th>
          <th>Δ vs Fallthrough</th>
        </tr>
      </thead>
      <tbody>
        ${categoryRows || '<tr><td colspan="10" style="color:#64748b">No eligible categories (need n ≥ 30)</td></tr>'}
      </tbody>
    </table>`;

    // ── Overall best row ──
    const overallRow = overall10 ? `
      <tr>
        <td><strong>All Filters</strong> (weighted avg)</td>
        <td>${filters10.filter((f: any) => f.n >= lowN10).length}/${filters10.length}</td>
        <td>${p10RetCell(overall10.fallthrough_avg_ret)}</td>
        <td>${p10Cell(overall10.trailing_sl)}</td>
        <td>${overall10.sl_delay != null ? overall10.sl_delay + 's' : p10Cell(null)}</td>
        <td>${p10Cell(overall10.trailing_tp)}</td>
        <td>${overall10.breakeven != null ? overall10.breakeven + '%' : p10Cell(null)}</td>
        <td>${p10RetCell(overall10.avg_ret)}</td>
        <td>${p10WinCell(overall10.win_rate)}</td>
        <td>${p10DeltaCell(overall10)}</td>
      </tr>` : '';
    const baselineOpt = baseline10.optimal;
    const baselineOptRow = baselineOpt ? `
      <tr>
        <td><strong>ALL labeled</strong> (no filter)</td>
        <td>${baseline10.n}</td>
        <td>${p10RetCell(baselineOpt.fallthrough_avg_ret)}</td>
        <td>${p10Cell(baselineOpt.trailing_sl)}</td>
        <td>${baselineOpt.sl_delay != null ? baselineOpt.sl_delay + 's' : p10Cell(null)}</td>
        <td>${p10Cell(baselineOpt.trailing_tp)}</td>
        <td>${baselineOpt.breakeven != null ? baselineOpt.breakeven + '%' : p10Cell(null)}</td>
        <td>${p10RetCell(baselineOpt.avg_ret)}</td>
        <td>${p10WinCell(baselineOpt.win_rate)}</td>
        <td>${p10DeltaCell(baselineOpt)}</td>
      </tr>` : '';

    const overallTable = `
    <h3 style="margin-top:20px;margin-bottom:6px">Overall Best DPM Values</h3>
    <table id="panel10-overall-table">
      <thead>
        <tr>
          <th>Scope</th>
          <th>Sample</th>
          <th>Fallthrough Avg</th>
          <th>Best Trailing SL</th>
          <th>Best SL Delay</th>
          <th>Best Trailing TP</th>
          <th>Best Breakeven</th>
          <th>Avg Ret</th>
          <th>Win %</th>
          <th>Δ vs Fallthrough</th>
        </tr>
      </thead>
      <tbody>
        ${baselineOptRow}
        ${overallRow}
      </tbody>
    </table>`;

    const legend10 = `
    <div class="desc" style="margin-top:10px">
      <strong>Entry:</strong> T+30. <strong>Base TP/SL:</strong> ${panel10.constants.base_tp_pct}% / ${panel10.constants.base_sl_pct}% (fixed — thesis defaults). Only DPM parameters vary across the ${panel10.constants.combo_count}-cell grid.
      <br>
      <strong>Grid:</strong>
      Trailing SL: [${panel10.grid.trailing_sl.map((x: any) => x.label).join(', ')}] ·
      SL Delay: [${panel10.grid.sl_delay_sec.join(', ')}]s ·
      Trailing TP: [${panel10.grid.trailing_tp.map((x: any) => x.label).join(', ')}] ·
      Breakeven: [${panel10.grid.breakeven_pct.join(', ')}]%
      <br>
      <strong>Simulation logic:</strong> Mirrors <code>position-manager.ts</code> exactly. At each checkpoint (T+40 … T+240): update high-water mark, compute effective SL as a layered max over [fixed SL, breakeven floor, trailing SL from peak], check SL exit (if past activation delay), check TP exit (fixed or trailing). Fall-through at T+300. SL gap penalty = ${panel10.constants.sl_gap_penalty_pct}% × distance-from-peak; TP gap penalty = ${panel10.constants.tp_gap_penalty_pct}% of exit return.
      <br>
      <strong>Fallthrough Avg:</strong> avg return when ALL DPM features are disabled (pure fixed 30/10). This is your baseline — the DPM optimizer should beat it meaningfully for a filter to be worth using DPM on.
      <br>
      <strong>Δ vs Fallthrough:</strong> improvement from activating the optimal DPM combo over the pure fixed 30/10 strategy, in percentage points.
      <br>
      <strong>Per-category aggregate:</strong> Single DPM combo maximizing n-weighted avg return across all filters in that category. Use this to pick DPM values when you're applying ANY filter in that category.
      <br>
      <strong>Overall aggregate:</strong> Single DPM combo maximizing n-weighted avg return across ALL filters (and also shown: the baseline "no filter" optimum). Use the All-Filters row as a safe default when you don't know which filter to use.
      <br>
      <strong>Gating:</strong> per-filter optimum requires n ≥ ${panel10.constants.min_n_for_optimum} AND ≥ ${panel10.constants.min_active_exits_for_optimum} non-fall-through exits. <code>—</code> means the filter cohort is too small or no combo actually triggered SL/TP.
    </div>`;

    panel10Html = `
    <div class="card">
      <h2>Panel 10 — ${panel10.title}</h2>
      <div class="desc">${panel10.description}</div>
      ${overallTable}
      ${categoryTable}
      ${perFilterTable}
      ${legend10}
    </div>`;
  }

  const sortScript = `
  <script>
  function v2GenericSort(tableId, col, type) {
    var table = document.getElementById(tableId);
    var tbody = table.tBodies[0];
    // Collect rows EXCLUDING baseline (first row) and group headers
    var allRows = Array.from(tbody.rows);
    var baselineRow = allRows[0];
    var dataRows = allRows.slice(1).filter(function(r){ return !r.classList.contains('row-group-header'); });
    var dir = table.getAttribute('data-sort-dir') === 'asc' ? 'desc' : 'asc';
    table.setAttribute('data-sort-dir', dir);
    dataRows.sort(function(a, b) {
      var av = a.cells[col].textContent.trim().replace('%','').replace('(low n)','').replace('+','').trim();
      var bv = b.cells[col].textContent.trim().replace('%','').replace('(low n)','').replace('+','').trim();
      if (type === 'num') {
        var an = av === '—' ? -Infinity : parseFloat(av);
        var bn = bv === '—' ? -Infinity : parseFloat(bv);
        return dir === 'asc' ? an - bn : bn - an;
      }
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    // Clear and re-add: baseline first, then sorted data rows (group headers removed in sort mode)
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    tbody.appendChild(baselineRow);
    dataRows.forEach(function(r){ tbody.appendChild(r); });
  }
  // Panel 1 has horizon variants — sortPanel1Table takes an explicit ID so
  // each horizon's table sorts independently. sortPanel1 is a back-compat
  // shim that targets the currently-active horizon panel.
  function sortPanel1Table(tableId, col, type) { v2GenericSort(tableId, col, type); }
  function sortPanel1(col, type) {
    var active = document.querySelector('.p1-horizon-panel.active');
    var horizon = active ? active.getAttribute('data-horizon') : 't300';
    sortPanel1Table('panel1-table-' + horizon, col, type);
  }
  function setPanel1Horizon(h) {
    var tabs = document.querySelectorAll('.p1-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-horizon') === h) tabs[i].classList.add('active');
      else tabs[i].classList.remove('active');
    }
    var panels = document.querySelectorAll('.p1-horizon-panel');
    for (var j = 0; j < panels.length; j++) {
      if (panels[j].getAttribute('data-horizon') === h) panels[j].classList.add('active');
      else panels[j].classList.remove('active');
    }
  }
  function sortPanel2(col, type) { v2GenericSort('panel2-table', col, type); }
  function sortPanel3(col, type) { v2GenericSort('panel3-table', col, type); }
  function sortPanel4(col, type) { v2GenericSort('panel4-table', col, type); }
  function sortPanel5(col, type) { v2GenericSort('panel5-table', col, type); }
  function sortPanel7(col, type) { v2GenericSort('panel7-table', col, type); }
  function sortPanel8(col, type) { v2GenericSort('panel8-table', col, type); }
  function sortPanel9(col, type) { v2GenericSort('panel9-table', col, type); }
  function sortPanel10(col, type) { v2GenericSort('panel10-table', col, type); }

  // Panel 6 top-pairs table has NO baseline row — use a simpler sort that treats
  // every row as data. sortPanel6PairsTable takes an explicit table ID so it
  // works across horizon variants; sortPanel6Pairs is a back-compat shim.
  function sortPanel6PairsTable(tableId, col, type) {
    var table = document.getElementById(tableId);
    if (!table) return;
    var tbody = table.tBodies[0];
    var rows = Array.from(tbody.rows).filter(function(r){ return r.cells.length >= 2; });
    var dir = table.getAttribute('data-sort-dir') === 'asc' ? 'desc' : 'asc';
    table.setAttribute('data-sort-dir', dir);
    rows.sort(function(a, b) {
      var av = a.cells[col].textContent.trim().replace('%','').replace('+','').trim();
      var bv = b.cells[col].textContent.trim().replace('%','').replace('+','').trim();
      if (type === 'num') {
        var an = av === '—' ? -Infinity : parseFloat(av);
        var bn = bv === '—' ? -Infinity : parseFloat(bv);
        return dir === 'asc' ? an - bn : bn - an;
      }
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    rows.forEach(function(r){ tbody.appendChild(r); });
  }
  function sortPanel6Pairs(col, type) {
    var active = document.querySelector('.p6-horizon-panel.active');
    var horizon = active ? active.getAttribute('data-horizon') : 't300';
    sortPanel6PairsTable('panel6-pairs-table-' + horizon, col, type);
  }
  function setPanel6Horizon(h) {
    var tabs = document.querySelectorAll('.p6-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-horizon') === h) tabs[i].classList.add('active');
      else tabs[i].classList.remove('active');
    }
    var panels = document.querySelectorAll('.p6-horizon-panel');
    for (var j = 0; j < panels.length; j++) {
      if (panels[j].getAttribute('data-horizon') === h) panels[j].classList.add('active');
      else panels[j].classList.remove('active');
    }
  }

  // Panel 6 dropdowns reload the page with a new ?p6= query param. Server
  // computes the intersection and renders it server-side on reload.
  function onPanel6Change() {
    var a = document.getElementById('p6-a');
    var b = document.getElementById('p6-b');
    var c = document.getElementById('p6-c');
    if (!a) return;
    var parts = [];
    if (a.value) parts.push(a.value);
    if (b && b.value) parts.push(b.value);
    if (c && c.value) parts.push(c.value);
    var url = new URL(window.location.href);
    if (parts.length > 0) {
      url.searchParams.set('p6', parts.join(','));
    } else {
      url.searchParams.delete('p6');
    }
    window.location.href = url.toString();
  }

  // ── Panel 4 dynamic update ──
  function p4ColorAvg(v) {
    if (v == null) return '—';
    var cls = v > 0.5 ? 'green' : v > -0.5 ? 'yellow' : 'red';
    var sign = v > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + v.toFixed(1) + '%</span>';
  }
  function p4ColorWin(v) {
    if (v == null) return '—';
    var cls = v >= 50 ? 'green' : v >= 40 ? 'yellow' : 'red';
    return '<span class="' + cls + '">' + v + '%</span>';
  }
  function p4ColorDiff(v) {
    if (v == null) return '—';
    var cls = v > 0 ? 'green' : v < 0 ? 'red' : 'yellow';
    var sign = v > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + v.toFixed(1) + '%</span>';
  }
  // Update one horizon's Panel 4 table in place at (tp, sl).
  function updatePanel4Table(horizon, tp, sl) {
    var all = window.__PANEL_4_BY_HORIZON;
    if (!all || !all[horizon]) return;
    var P = all[horizon];
    var ti = P.tp_levels.indexOf(tp);
    var si = P.sl_levels.indexOf(sl);
    if (ti === -1 || si === -1) return;
    var idx = ti * P.sl_levels.length + si;
    var baselineAvg = P.rows[0].combos.avg_ret[idx];
    var table = document.getElementById('panel4-table-' + horizon);
    if (!table) return;
    var rows = table.tBodies[0].rows;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var rowIdxAttr = row.getAttribute('data-row-idx');
      if (rowIdxAttr == null) continue; // group header
      var rIdx = parseInt(rowIdxAttr, 10);
      var combos = P.rows[rIdx].combos;
      var avg = combos.avg_ret[idx];
      var med = combos.med_ret[idx];
      var win = combos.win_rate[idx];
      var diff = +(avg - baselineAvg).toFixed(1);
      var sAvg = row.querySelector('.p4-sel-avg');
      var sMed = row.querySelector('.p4-sel-med');
      var sWin = row.querySelector('.p4-sel-win');
      var sDiff = row.querySelector('.p4-sel-diff');
      if (sAvg) sAvg.innerHTML = p4ColorAvg(avg);
      if (sMed) sMed.innerHTML = p4ColorAvg(med);
      if (sWin) sWin.innerHTML = p4ColorWin(win);
      if (sDiff) sDiff.innerHTML = row.getAttribute('data-baseline') === '1' ? '<span class="yellow">+0.0%</span>' : p4ColorDiff(diff);
    }
  }
  function updatePanel4(tp, sl) {
    var all = window.__PANEL_4_BY_HORIZON;
    if (!all) return;
    for (var h in all) {
      if (Object.prototype.hasOwnProperty.call(all, h)) updatePanel4Table(h, tp, sl);
    }
  }
  // Sort a single horizon's table. Wraps v2GenericSort so we can pass a
  // table ID instead of the hardcoded 'panel4-table'.
  function sortPanel4Table(tableId, col, type) { v2GenericSort(tableId, col, type); }
  // Back-compat shim for any inline handler that still calls sortPanel4
  // (older references): default to the active horizon's table.
  function sortPanel4(col, type) {
    var active = document.querySelector('.p4-horizon-panel.active');
    var horizon = active ? active.getAttribute('data-horizon') : 't300';
    sortPanel4Table('panel4-table-' + horizon, col, type);
  }
  function currentPanel4Horizon() {
    var active = document.querySelector('.p4-tab.active');
    return active ? active.getAttribute('data-horizon') : 't300';
  }
  function setPanel4Horizon(h) {
    var tabs = document.querySelectorAll('.p4-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-horizon') === h) tabs[i].classList.add('active');
      else tabs[i].classList.remove('active');
    }
    var panels = document.querySelectorAll('.p4-horizon-panel');
    for (var j = 0; j < panels.length; j++) {
      if (panels[j].getAttribute('data-horizon') === h) panels[j].classList.add('active');
      else panels[j].classList.remove('active');
    }
    onPanel4Change();
  }
  function onPanel4Change() {
    var tpSel = document.getElementById('p4-tp');
    var slSel = document.getElementById('p4-sl');
    if (!tpSel || !slSel) return;
    var tp = parseFloat(tpSel.value);
    var sl = parseFloat(slSel.value);
    updatePanel4(tp, sl);
    try { history.replaceState(null, '', '#p4=tp' + tp + ',sl' + sl + ',h=' + currentPanel4Horizon()); } catch (e) {}
  }
  function readPanel4Hash() {
    var all = window.__PANEL_4_BY_HORIZON;
    if (!all) return;
    var P = all.t300 || all[Object.keys(all)[0]];
    if (!P) return;
    var tp = P.default_tp;
    var sl = P.default_sl;
    var horizon = 't300';
    var m = (location.hash || '').match(/p4=tp([0-9.]+),sl([0-9.]+)(?:,h=(t60|t120|t300))?/);
    if (m) {
      var ht = parseFloat(m[1]);
      var hs = parseFloat(m[2]);
      if (P.tp_levels.indexOf(ht) !== -1) tp = ht;
      if (P.sl_levels.indexOf(hs) !== -1) sl = hs;
      if (m[3] && all[m[3]]) horizon = m[3];
    }
    var tpSel = document.getElementById('p4-tp');
    var slSel = document.getElementById('p4-sl');
    if (tpSel) tpSel.value = String(tp);
    if (slSel) slSel.value = String(sl);
    setPanel4Horizon(horizon);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readPanel4Hash);
  } else {
    readPanel4Hash();
  }
  </script>`;

  const body = panel1Html + panel2Html + panel3Html + panel4Html + panel5Html + panel6Html + panel7Html + panel8Html + panel9Html + panel10Html + panel11Html + panel4DataScript + sortScript;
  return shell('Filter Analysis V2', '/filter-analysis-v2', body, data);
}

// ── FILTER ANALYSIS V3 ───────────────────────────────────────────────
// Six panels extending v2 with triple-filter combos, drawdown-gate
// stacking, crash-survival curves, two new filter dimensions, and a
// velocity × liquidity heatmap. Reuses shell()/STYLES from the V2
// page so the visual language stays consistent.

function v3Pct(v: number | null | undefined, digits = 2): string {
  if (v == null) return '<span style="color:#4b5563">—</span>';
  const cls = v > 0 ? 'green' : v < 0 ? 'red' : '';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(digits)}%</span>`;
}

function v3Num(v: number | null | undefined, digits = 0): string {
  if (v == null) return '<span style="color:#4b5563">—</span>';
  return v.toFixed(digits);
}

function v3BaselineBadge(beats: boolean): string {
  return beats
    ? '<span class="badge badge-pump" style="font-size:10px">BEATS</span>'
    : '<span class="badge badge-dump" style="font-size:10px">NO</span>';
}

function v3HeatCellColor(v: number | null, baseline: number): string {
  if (v == null) return '#1a1a30';
  const delta = v - baseline;
  // Heatmap colors: green scale above baseline, red scale below
  if (delta >= 4) return '#166534';
  if (delta >= 2) return '#1e7a42';
  if (delta >= 0) return '#2a2a4a';
  if (delta >= -2) return '#4a2a2a';
  if (delta >= -5) return '#7f1d1d';
  return '#5a0e0e';
}

// Build an SVG line chart for one filter's survival curves.
// 3 lines (one per threshold), each plotting survival fraction vs timepoint.
function v3SurvivalChart(curves: number[][], timepoints: readonly number[], thresholds: readonly number[]): string {
  const W = 260;
  const H = 120;
  const padL = 30;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const minT = timepoints[0];
  const maxT = timepoints[timepoints.length - 1];
  const tRange = maxT - minT;
  const colorFor = (threshold: number) =>
    threshold === -5 ? '#facc15' : threshold === -10 ? '#f59e0b' : '#ef4444';
  const x = (t: number) => padL + ((t - minT) / tRange) * plotW;
  const y = (v: number) => padT + (1 - v) * plotH;

  const gridLines: string[] = [];
  for (const yv of [0.25, 0.5, 0.75, 1.0]) {
    gridLines.push(`<line x1="${padL}" y1="${y(yv)}" x2="${W - padR}" y2="${y(yv)}" stroke="#262640" stroke-width="1" />`);
    gridLines.push(`<text x="${padL - 4}" y="${y(yv) + 3}" fill="#64748b" font-size="8" text-anchor="end">${(yv * 100).toFixed(0)}%</text>`);
  }
  for (const t of timepoints) {
    gridLines.push(`<text x="${x(t)}" y="${H - 4}" fill="#64748b" font-size="8" text-anchor="middle">${t}</text>`);
  }

  const lines = curves.map((curve, idx) => {
    const threshold = thresholds[idx];
    const path = curve.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(timepoints[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<path d="${path}" fill="none" stroke="${colorFor(threshold)}" stroke-width="1.5" />`;
  }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${gridLines.join('\n    ')}
    ${lines}
  </svg>`;
}

export function renderFilterV3Html(data: any): string {
  // ── Panel 1 — top 20 three-filter combos ──
  type TripleRow = {
    filter_a: string; filter_b: string; filter_c: string;
    n: number;
    opt_tp: number; opt_sl: number;
    opt_avg_ret: number; opt_win_rate: number;
    parent_pair_opt: number;
    lift_vs_pair: number;
    beats_baseline: boolean;
  };
  const p1 = data.panelv3_1 ?? {};
  const horizons: Array<{ key: string; label: string; rows: TripleRow[] }> = [
    { key: 't300', label: '5 min (T+300)', rows: p1.top_triples_t300 ?? [] },
    { key: 't120', label: '2 min (T+120)', rows: p1.top_triples_t120 ?? [] },
    { key: 't60',  label: '1 min (T+60)',  rows: p1.top_triples_t60  ?? [] },
  ];
  const p1Tabs = horizons
    .map((h, i) => `<button type="button" class="p4-tab${i === 0 ? ' active' : ''}" data-horizon="${h.key}" onclick="v3SetP1Horizon('${h.key}')">${h.label}</button>`)
    .join('');
  const p1Panels = horizons.map((h, i) => {
    const rows = h.rows.map((r: TripleRow) => `
      <tr>
        <td>${escHtml(r.filter_a)}</td>
        <td>${escHtml(r.filter_b)}</td>
        <td>${escHtml(r.filter_c)}</td>
        <td>${r.n}</td>
        <td>${r.opt_tp}/${r.opt_sl}</td>
        <td>${v3Pct(r.opt_avg_ret, 2)}</td>
        <td>${r.opt_win_rate}%</td>
        <td>${v3Pct(r.parent_pair_opt, 2)}</td>
        <td>${v3Pct(r.lift_vs_pair, 2)}</td>
        <td>${v3BaselineBadge(r.beats_baseline)}</td>
      </tr>`).join('');
    const body = rows.length === 0
      ? `<tr><td colspan="10" style="text-align:center;color:#64748b;padding:20px">No triples with n ≥ 30 and lift > 0 at this horizon.</td></tr>`
      : rows;
    return `<div class="p4-horizon-panel${i === 0 ? ' active' : ''}" data-horizon="${h.key}">
      <table>
        <thead><tr>
          <th>Filter A</th><th>Filter B</th><th>Filter C</th>
          <th>n</th><th>TP/SL</th><th>Opt Avg Ret</th><th>WR</th>
          <th>Parent Pair Opt</th><th>Lift vs Pair</th><th>Beats Baseline</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }).join('');
  const panelV31Html = `<div class="card">
    <h2>v3 Panel 1 — ${escHtml(p1.title ?? 'Top 20 Three-Filter Combos')}</h2>
    <div class="desc">${escHtml(p1.description ?? '')}</div>
    <div class="p4-tabs">${p1Tabs}</div>
    ${p1Panels}
  </div>`;

  // ── Panel 2 — drawdown gate stacking ──
  type P2Row = {
    base: string; base_kind: string; threshold: number;
    base_n: number; base_opt_avg_ret: number | null;
    gated_n: number;
    gated_opt_tp: number | null; gated_opt_sl: number | null;
    gated_opt_avg_ret: number | null; gated_opt_win_rate: number | null;
    n_retention_pct: number | null; delta_vs_base: number | null;
    beats_baseline: boolean;
  };
  const p2 = data.panelv3_2 ?? {};
  const p2Rows: P2Row[] = p2.rows ?? [];
  const p2RowsHtml = p2Rows.map((r: P2Row) => {
    const tp = r.gated_opt_tp != null ? `${r.gated_opt_tp}/${r.gated_opt_sl}` : '—';
    return `<tr>
      <td>${escHtml(r.base)}</td>
      <td><span class="badge" style="background:#334155;color:#94a3b8;font-size:10px">${r.base_kind}</span></td>
      <td>${r.threshold > 0 ? '> ' : '> '}${r.threshold}%</td>
      <td>${r.base_n}</td>
      <td>${r.base_opt_avg_ret != null ? v3Pct(r.base_opt_avg_ret, 2) : '—'}</td>
      <td>${r.gated_n}</td>
      <td>${tp}</td>
      <td>${r.gated_opt_avg_ret != null ? v3Pct(r.gated_opt_avg_ret, 2) : '—'}</td>
      <td>${r.gated_opt_win_rate != null ? r.gated_opt_win_rate + '%' : '—'}</td>
      <td>${r.n_retention_pct != null ? r.n_retention_pct.toFixed(1) + '%' : '—'}</td>
      <td>${r.delta_vs_base != null ? v3Pct(r.delta_vs_base, 2) : '—'}</td>
      <td>${v3BaselineBadge(r.beats_baseline)}</td>
    </tr>`;
  }).join('');
  const panelV32Html = `<div class="card">
    <h2>v3 Panel 2 — ${escHtml(p2.title ?? 'max_dd_0_30 Gate Stacking')}</h2>
    <div class="desc">${escHtml(p2.description ?? '')}</div>
    <table>
      <thead><tr>
        <th>Base</th><th>Kind</th><th>DD Threshold</th>
        <th>Base n</th><th>Base Opt</th>
        <th>Gated n</th><th>Gated TP/SL</th><th>Gated Opt</th><th>Gated WR</th>
        <th>Retention</th><th>Δ vs Base</th><th>Beats Baseline</th>
      </tr></thead>
      <tbody>${p2RowsHtml || '<tr><td colspan="12" style="text-align:center;color:#64748b;padding:20px">No rows.</td></tr>'}</tbody>
    </table>
  </div>`;

  // ── Panel 3 — survival curves ──
  type P3Filter = { name: string; kind: string; n: number; curves: number[][] };
  const p3 = data.panelv3_3 ?? {};
  const p3Filters: P3Filter[] = p3.filters ?? [];
  const p3Timepoints: readonly number[] = p3.constants?.timepoints_sec ?? [30, 45, 60, 90, 120, 180, 240, 300];
  const p3Thresholds: readonly number[] = p3.constants?.thresholds_pct ?? [-5, -10, -20];
  const p3BaselineFilter: P3Filter | null = p3.baseline ?? null;

  const renderP3Cell = (f: P3Filter) => {
    if (f.n < 30) {
      return `<div class="grid" style="grid-template-columns:1fr;padding:10px;background:#1a1a30;border-radius:6px">
        <div style="font-weight:600;color:#e2e8f0">${escHtml(f.name)}</div>
        <div class="n-insuf">n=${f.n} &lt; 30 (insufficient)</div>
      </div>`;
    }
    const chart = v3SurvivalChart(f.curves, p3Timepoints, p3Thresholds);
    const finals = f.curves.map((c, i) => {
      const t = p3Thresholds[i];
      const finalVal = c[c.length - 1];
      const colorForThreshold = t === -5 ? '#facc15' : t === -10 ? '#f59e0b' : '#ef4444';
      return `<span style="color:${colorForThreshold};margin-right:10px">&gt;${t}%: ${(finalVal * 100).toFixed(1)}%</span>`;
    }).join('');
    return `<div style="padding:10px;background:#1a1a30;border-radius:6px">
      <div style="font-weight:600;color:#e2e8f0;margin-bottom:4px">${escHtml(f.name)}</div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px">n=${f.n} · kind=${f.kind}</div>
      ${chart}
      <div style="font-size:11px;margin-top:4px">P(survive at T+300): ${finals}</div>
    </div>`;
  };

  const baselineBlock = p3BaselineFilter ? `<div style="margin-bottom:14px">${renderP3Cell(p3BaselineFilter)}</div>` : '';
  const p3Grid = p3Filters.map(renderP3Cell).join('\n      ');
  const panelV33Html = `<div class="card">
    <h2>v3 Panel 3 — ${escHtml(p3.title ?? 'Crash Survival Curves')}</h2>
    <div class="desc">${escHtml(p3.description ?? '')}</div>
    <div class="desc"><strong>Legend (line colors):</strong>
      <span style="color:#facc15;margin-left:6px">&gt; −5%</span>
      <span style="color:#f59e0b;margin-left:10px">&gt; −10%</span>
      <span style="color:#ef4444;margin-left:10px">&gt; −20%</span>.
      X-axis = seconds since graduation (entry at T+30). Y-axis = fraction of tokens whose running min-rel-return has not yet breached the threshold.
    </div>
    ${baselineBlock}
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
      ${p3Grid || '<div class="n-insuf">No filters available.</div>'}
    </div>
  </div>`;

  // ── Panel 4 — max_tick_drop ──
  type P4Row = {
    threshold: number; mode: string; n: number;
    opt_tp: number | null; opt_sl: number | null;
    opt_avg_ret: number | null; opt_win_rate: number | null;
    beats_baseline: boolean;
  };
  const p4 = data.panelv3_4 ?? {};
  const p4Rows: P4Row[] = p4.rows ?? [];
  const p4RowsHtml = p4Rows.map((r: P4Row) => {
    const tp = r.opt_tp != null ? `${r.opt_tp}/${r.opt_sl}` : '—';
    const modeTag = r.mode === 'standalone'
      ? '<span class="badge" style="background:#334155;color:#94a3b8;font-size:10px">standalone</span>'
      : '<span class="badge" style="background:#1f2a44;color:#60a5fa;font-size:10px">+ baseline</span>';
    return `<tr>
      <td>&gt; ${r.threshold}%</td>
      <td>${modeTag}</td>
      <td>${r.n}</td>
      <td>${tp}</td>
      <td>${r.opt_avg_ret != null ? v3Pct(r.opt_avg_ret, 2) : '—'}</td>
      <td>${r.opt_win_rate != null ? r.opt_win_rate + '%' : '—'}</td>
      <td>${v3BaselineBadge(r.beats_baseline)}</td>
    </tr>`;
  }).join('');
  const panelV34Html = `<div class="card">
    <h2>v3 Panel 4 — ${escHtml(p4.title ?? 'max_tick_drop_0_30')}</h2>
    <div class="desc">${escHtml(p4.description ?? '')}</div>
    <table>
      <thead><tr>
        <th>Tick Drop Threshold</th><th>Mode</th><th>n</th><th>Opt TP/SL</th>
        <th>Opt Avg Ret</th><th>WR</th><th>Beats Baseline</th>
      </tr></thead>
      <tbody>${p4RowsHtml || '<tr><td colspan="7" style="text-align:center;color:#64748b;padding:20px">No rows.</td></tr>'}</tbody>
    </table>
  </div>`;

  // ── Panel 5 — vel × liq heatmap ──
  type P5Cell = {
    vel: string; liq: string; n: number;
    opt_tp: number | null; opt_sl: number | null;
    opt_avg_ret: number | null; opt_win_rate: number | null;
    beats_baseline: boolean;
  };
  const p5 = data.panelv3_5 ?? {};
  const p5Cells: P5Cell[] = p5.cells ?? [];
  const velBuckets: string[] = p5.constants?.vel_buckets ?? [];
  const liqBuckets: string[] = p5.constants?.liq_buckets ?? [];
  const cellByKey = new Map<string, P5Cell>();
  for (const c of p5Cells) cellByKey.set(`${c.vel}||${c.liq}`, c);

  const baselineSim: number = p5.constants?.baseline_sim_return ?? 0;
  const headerCells = liqBuckets.map(l => `<th style="text-align:center">${escHtml(l)}</th>`).join('');
  const heatmapRows = velBuckets.map(v => {
    const cells = liqBuckets.map(l => {
      const c = cellByKey.get(`${v}||${l}`);
      if (!c || c.n === 0) return `<td style="background:#111;text-align:center;color:#4b5563">—</td>`;
      const bgColor = c.opt_avg_ret != null ? v3HeatCellColor(c.opt_avg_ret, baselineSim) : '#1a1a30';
      const retStr = c.opt_avg_ret != null
        ? `${c.opt_avg_ret > 0 ? '+' : ''}${c.opt_avg_ret.toFixed(2)}%`
        : `n&lt;30`;
      const tp = c.opt_tp != null ? `${c.opt_tp}/${c.opt_sl}` : '';
      const wr = c.opt_win_rate != null ? `${c.opt_win_rate}%` : '';
      return `<td style="background:${bgColor};text-align:center;padding:8px">
        <div style="font-weight:600;color:${c.opt_avg_ret != null && c.opt_avg_ret > 0 ? '#4ade80' : '#ef4444'}">${retStr}</div>
        <div style="font-size:10px;color:#94a3b8">n=${c.n}${tp ? ' · ' + tp : ''}${wr ? ' · ' + wr : ''}</div>
      </td>`;
    }).join('');
    return `<tr><th style="text-align:right">${escHtml(v)}</th>${cells}</tr>`;
  }).join('');
  const panelV35Html = `<div class="card">
    <h2>v3 Panel 5 — ${escHtml(p5.title ?? 'Velocity × Liquidity Heatmap')}</h2>
    <div class="desc">${escHtml(p5.description ?? '')}</div>
    <table style="margin:16px 0">
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>${heatmapRows}</tbody>
    </table>
    <div class="desc">Cell coloring: darker green = well above rolling baseline (${baselineSim >= 0 ? '+' : ''}${baselineSim.toFixed(2)}%), darker red = well below. Empty dash = n &lt; 30 or no data.</div>
  </div>`;

  // ── Panel 6 — sum_abs_returns ──
  type P6Row = {
    op: string; threshold: number; mode: string; n: number;
    opt_tp: number | null; opt_sl: number | null;
    opt_avg_ret: number | null; opt_win_rate: number | null;
    beats_baseline: boolean;
  };
  const p6 = data.panelv3_6 ?? {};
  const p6Rows: P6Row[] = p6.rows ?? [];
  const p6RowsHtml = p6Rows.map((r: P6Row) => {
    const tp = r.opt_tp != null ? `${r.opt_tp}/${r.opt_sl}` : '—';
    const modeTag = r.mode === 'standalone'
      ? '<span class="badge" style="background:#334155;color:#94a3b8;font-size:10px">standalone</span>'
      : '<span class="badge" style="background:#1f2a44;color:#60a5fa;font-size:10px">+ baseline</span>';
    return `<tr>
      <td>${r.op} ${r.threshold}</td>
      <td>${modeTag}</td>
      <td>${r.n}</td>
      <td>${tp}</td>
      <td>${r.opt_avg_ret != null ? v3Pct(r.opt_avg_ret, 2) : '—'}</td>
      <td>${r.opt_win_rate != null ? r.opt_win_rate + '%' : '—'}</td>
      <td>${v3BaselineBadge(r.beats_baseline)}</td>
    </tr>`;
  }).join('');
  const panelV36Html = `<div class="card">
    <h2>v3 Panel 6 — ${escHtml(p6.title ?? 'sum_abs_returns_0_30')}</h2>
    <div class="desc">${escHtml(p6.description ?? '')}</div>
    <table>
      <thead><tr>
        <th>Threshold</th><th>Mode</th><th>n</th><th>Opt TP/SL</th>
        <th>Opt Avg Ret</th><th>WR</th><th>Beats Baseline</th>
      </tr></thead>
      <tbody>${p6RowsHtml || '<tr><td colspan="7" style="text-align:center;color:#64748b;padding:20px">No rows.</td></tr>'}</tbody>
    </table>
  </div>`;

  // ── Panel 7 — regime + walk-forward on v3 leaders ──
  type P7Row = {
    name: string;
    kind: 'pair' | 'triple';
    n_total: number;
    opt_tp: number | null;
    opt_sl: number | null;
    opt_avg_ret: number | null;
    n_train: number;
    n_test: number;
    train_tp: number | null;
    train_sl: number | null;
    train_avg_ret: number | null;
    test_avg_ret: number | null;
    degradation: number | null;
    wf_verdict: 'ROBUST' | 'DEGRADED' | 'OVERFIT' | 'INSUFFICIENT';
    buckets: { n: number; win_rate_pct: number | null; avg_return_pct: number | null }[];
    wr_std_dev: number | null;
    regime_stability: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT';
  };
  const p7 = data.panelv3_7 ?? {};
  const p7Rows: P7Row[] = p7.rows ?? [];

  const wfBadge = (v: P7Row['wf_verdict']): string => {
    const cls = v === 'ROBUST'      ? 'badge-pump'
              : v === 'DEGRADED'    ? 'badge-stable'
              : v === 'OVERFIT'     ? 'badge-dump'
              : '';
    const bg = v === 'INSUFFICIENT' ? 'background:#334155;color:#94a3b8' : '';
    return `<span class="badge ${cls}" style="font-size:10px;${bg}">${v}</span>`;
  };
  const regBadge = (v: P7Row['regime_stability']): string => {
    const cls = v === 'STABLE'     ? 'badge-pump'
              : v === 'MODERATE'   ? 'badge-stable'
              : v === 'CLUSTERED'  ? 'badge-dump'
              : '';
    const bg = v === 'INSUFFICIENT' ? 'background:#334155;color:#94a3b8' : '';
    return `<span class="badge ${cls}" style="font-size:10px;${bg}">${v}</span>`;
  };
  const bucketCell = (b: { n: number; win_rate_pct: number | null; avg_return_pct: number | null }): string => {
    if (b.win_rate_pct == null || b.avg_return_pct == null) {
      return `<td style="color:#4b5563;font-size:11px">n=${b.n}<br>—</td>`;
    }
    const wrCls = b.win_rate_pct >= 50 ? 'green' : b.win_rate_pct >= 40 ? 'yellow' : 'red';
    const retCls = b.avg_return_pct > 0 ? 'green' : 'red';
    return `<td style="font-size:11px">
      <span class="${wrCls}">${b.win_rate_pct}%</span>
      <span style="color:#64748b">/${b.n}</span><br>
      <span class="${retCls}">${b.avg_return_pct > 0 ? '+' : ''}${b.avg_return_pct}%</span>
    </td>`;
  };

  const p7RowsHtml = p7Rows.map((r: P7Row) => {
    const kindTag = `<span class="badge" style="background:${r.kind === 'triple' ? '#1f2a44' : '#334155'};color:${r.kind === 'triple' ? '#60a5fa' : '#94a3b8'};font-size:10px">${r.kind}</span>`;
    const optCell = r.opt_tp != null
      ? `<span>${r.opt_tp}/${r.opt_sl}</span><br>${v3Pct(r.opt_avg_ret, 2)}`
      : '—';
    const wfCell = r.train_tp != null
      ? `train=${r.train_tp}/${r.train_sl}<br>${v3Pct(r.train_avg_ret, 2)} → ${v3Pct(r.test_avg_ret, 2)}<br>deg=${r.degradation != null ? r.degradation.toFixed(2) + 'pp' : '—'}`
      : '—';
    const bucketCells = r.buckets.map(bucketCell).join('');
    const paddedBucketCells = bucketCells + '<td></td>'.repeat(Math.max(0, 4 - r.buckets.length));
    const stdDev = r.wr_std_dev != null ? r.wr_std_dev.toFixed(1) : '—';
    return `<tr>
      <td>${escHtml(r.name)}</td>
      <td>${kindTag}</td>
      <td>${r.n_total}</td>
      <td style="font-size:11px">${optCell}</td>
      <td style="font-size:11px">n=${r.n_train}/${r.n_test}<br>${wfCell}</td>
      <td>${wfBadge(r.wf_verdict)}</td>
      ${paddedBucketCells}
      <td>${stdDev}</td>
      <td>${regBadge(r.regime_stability)}</td>
    </tr>`;
  }).join('');

  const panelV37Html = `<div class="card">
    <h2>v3 Panel 7 — ${escHtml(p7.title ?? 'Regime Stability & Walk-Forward')}</h2>
    <div class="desc">${escHtml(p7.description ?? '')}</div>
    <table>
      <thead><tr>
        <th>Filter</th><th>Kind</th><th>n</th><th>Opt (TP/SL)<br>Avg Ret</th>
        <th>Walk-Forward<br>train → test</th><th>WF Verdict</th>
        <th>B1 WR/n<br>Ret</th><th>B2</th><th>B3</th><th>B4</th>
        <th>WR σ</th><th>Regime</th>
      </tr></thead>
      <tbody>${p7RowsHtml || '<tr><td colspan="12" style="text-align:center;color:#64748b;padding:20px">No rows.</td></tr>'}</tbody>
    </table>
    <div class="desc" style="margin-top:10px">
      <strong>Walk-forward verdict colors:</strong>
      <span class="badge badge-pump" style="font-size:10px">ROBUST</span> (&lt; 2pp degradation) ·
      <span class="badge badge-stable" style="font-size:10px">DEGRADED</span> (2–5pp) ·
      <span class="badge badge-dump" style="font-size:10px">OVERFIT</span> (&gt; 5pp).
      <br>
      <strong>Regime stability:</strong>
      <span class="badge badge-pump" style="font-size:10px">STABLE</span> (σ &lt; 8) ·
      <span class="badge badge-stable" style="font-size:10px">MODERATE</span> (8–15) ·
      <span class="badge badge-dump" style="font-size:10px">CLUSTERED</span> (≥ 15).
      <br>
      <em>A promotion candidate must be both NOT OVERFIT and NOT CLUSTERED.</em>
    </div>
  </div>`;

  const script = `<script>
  function v3SetP1Horizon(h) {
    var tabs = document.querySelectorAll('.p4-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-horizon') === h) tabs[i].classList.add('active');
      else tabs[i].classList.remove('active');
    }
    var panels = document.querySelectorAll('.p4-horizon-panel');
    for (var j = 0; j < panels.length; j++) {
      if (panels[j].getAttribute('data-horizon') === h) panels[j].classList.add('active');
      else panels[j].classList.remove('active');
    }
  }
  </script>`;

  const v3Data = {
    generated_at: data.generated_at,
    panelv3_1: data.panelv3_1,
    panelv3_2: data.panelv3_2,
    panelv3_3: data.panelv3_3,
    panelv3_4: data.panelv3_4,
    panelv3_5: data.panelv3_5,
    panelv3_6: data.panelv3_6,
    panelv3_7: data.panelv3_7,
  };

  const body = panelV31Html + panelV32Html + panelV33Html + panelV34Html + panelV35Html + panelV36Html + panelV37Html + script;
  return shell('Filter Analysis V3', '/filter-analysis-v3', body, v3Data);
}

export function renderPricePathHtml(db: Database.Database): string {
  // ── 1. Load data ──────────────────────────────────────────────────────────
  const allTokens = db.prepare(`
    SELECT label, bc_velocity_sol_per_min, round_trip_slippage_pct,
           pct_t5,  pct_t10, pct_t15, pct_t20, pct_t25, pct_t30,
           pct_t35, pct_t40, pct_t45, pct_t50, pct_t55, pct_t60,
           pct_t90, pct_t120, pct_t150, pct_t180, pct_t240, pct_t300,
           acceleration_t30, acceleration_t60,
           monotonicity_0_30, monotonicity_0_60,
           path_smoothness_0_30, path_smoothness_0_60,
           max_drawdown_0_30, max_drawdown_0_60,
           dip_and_recover_flag, early_vs_late_0_30, early_vs_late_0_60
    FROM graduation_momentum
    WHERE pct_t5 IS NOT NULL AND pct_t10 IS NOT NULL
      AND pct_t30 IS NOT NULL AND pct_t60 IS NOT NULL
      AND label IS NOT NULL
    ORDER BY id DESC
    LIMIT 600
  `).all() as any[];

  const total5s = (db.prepare(`
    SELECT COUNT(*) as n FROM graduation_momentum
    WHERE pct_t5 IS NOT NULL AND pct_t60 IS NOT NULL
  `).get() as any)?.n ?? 0;

  const labeled = allTokens.filter(r => r.label != null);
  const byLabel = groupBy(labeled, r => r.label);
  const pumps   = byLabel.get('PUMP') || [];
  const dumps   = byLabel.get('DUMP') || [];
  const stables = byLabel.get('STABLE') || [];
  const vel520  = labeled.filter(r => r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20);
  const vel520P = vel520.filter(r => r.label === 'PUMP');
  const vel520D = vel520.filter(r => r.label === 'DUMP');

  // ── 2. Shape overlay chart ────────────────────────────────────────────────
  const overlayPcts = labeled.slice(0, 200).map(r =>
    TIME_POINTS.map(t => t === 0 ? 0 : r[`pct_t${t}`] as number | null)
  );
  const [yMin, yMax] = computeYRange(overlayPcts);
  const grid = svgGrid(yMin, yMax);

  const overlayLines: string[] = [];
  for (const row of labeled.slice(0, 200)) {
    const rowPcts = TIME_POINTS.map(t => t === 0 ? 0 : row[`pct_t${t}`] as number | null);
    const color = row.label === 'PUMP' ? '#4ade80' : row.label === 'DUMP' ? '#ef4444' : '#facc15';
    overlayLines.push(svgPolyline(rowPcts, yMin, yMax, color, 0.15, 1));
  }
  const overlayChart = svgChart(
    `Price Path Overlay — all labeled tokens with complete 5s data (n=${labeled.length}, showing ≤200, green=PUMP red=DUMP yellow=STABLE)`,
    overlayLines, grid
  );

  // ── 3. Average path by label ──────────────────────────────────────────────
  const avgPump   = meanPcts(pumps);
  const avgDump   = meanPcts(dumps);
  const avgStable = meanPcts(stables);
  const sdPump    = stdDevPcts(pumps, avgPump);
  const sdDump    = stdDevPcts(dumps, avgDump);

  const avgAllPcts = [avgPump, avgDump, avgStable].filter(a => a.some(v => v != null));
  const [ayMin, ayMax] = computeYRange(avgAllPcts, 5);
  const avgGrid = svgGrid(ayMin, ayMax);

  // Shade ±1 SD bands for PUMP and DUMP
  const sdBandLines: string[] = [];
  const bandPts = (means: (number | null)[], sds: (number | null)[], sign: 1 | -1): string => {
    const pts: string[] = [];
    for (let i = 0; i < TIME_POINTS.length; i++) {
      const m = means[i], sd = sds[i];
      if (m == null || sd == null) continue;
      pts.push(`${xScale(TIME_POINTS[i]).toFixed(1)},${yScale(m + sign * sd, ayMin, ayMax).toFixed(1)}`);
    }
    return pts.join(' ');
  };
  if (pumps.length > 1) {
    const upper = bandPts(avgPump, sdPump, 1);
    const lower = bandPts(avgPump, sdPump, -1).split(' ').reverse().join(' ');
    if (upper && lower) sdBandLines.push(`<polygon points="${upper} ${lower}" fill="#4ade80" opacity="0.08"/>`);
  }
  if (dumps.length > 1) {
    const upper = bandPts(avgDump, sdDump, 1);
    const lower = bandPts(avgDump, sdDump, -1).split(' ').reverse().join(' ');
    if (upper && lower) sdBandLines.push(`<polygon points="${upper} ${lower}" fill="#ef4444" opacity="0.08"/>`);
  }

  const avgLines = [
    ...sdBandLines,
    pumps.length   > 0 ? svgPolyline(avgPump,   ayMin, ayMax, '#4ade80', 0.9, 2.5) : '',
    dumps.length   > 0 ? svgPolyline(avgDump,   ayMin, ayMax, '#ef4444', 0.9, 2.5) : '',
    stables.length > 0 ? svgPolyline(avgStable, ayMin, ayMax, '#facc15', 0.9, 2.5) : '',
  ].filter(Boolean);

  const avgLegend = [
    pumps.length   > 0 ? `<span style="color:#4ade80">■ PUMP (n=${pumps.length})</span>` : '',
    dumps.length   > 0 ? `<span style="color:#ef4444">■ DUMP (n=${dumps.length})</span>` : '',
    stables.length > 0 ? `<span style="color:#facc15">■ STABLE (n=${stables.length})</span>` : '',
  ].filter(Boolean).join(' &nbsp; ');

  const avgChart = svgChart(
    'Average Price Path by Label (±1 SD shaded)',
    avgLines, avgGrid
  );

  // ── 4. Vel 5-20 vs all ────────────────────────────────────────────────────
  const avgAllP  = meanPcts(pumps);
  const avgAllD  = meanPcts(dumps);
  const avgV5P   = meanPcts(vel520P);
  const avgV5D   = meanPcts(vel520D);
  const [vyMin, vyMax] = computeYRange([avgAllP, avgAllD, avgV5P, avgV5D].filter(a => a.some(v => v != null)), 5);
  const velGrid = svgGrid(vyMin, vyMax);

  const velLines = [
    avgAllP.some(v => v != null) ? svgPolyline(avgAllP, vyMin, vyMax, '#4ade80', 0.35, 1.5) : '',
    avgAllD.some(v => v != null) ? svgPolyline(avgAllD, vyMin, vyMax, '#ef4444', 0.35, 1.5) : '',
    avgV5P.some(v => v != null)  ? svgPolyline(avgV5P,  vyMin, vyMax, '#22d3ee', 0.9, 2.5) : '',
    avgV5D.some(v => v != null)  ? svgPolyline(avgV5D,  vyMin, vyMax, '#f97316', 0.9, 2.5) : '',
  ].filter(Boolean);

  const velLegend = [
    `<span style="color:#4ade80;opacity:0.5">— All PUMP (n=${pumps.length})</span>`,
    `<span style="color:#ef4444;opacity:0.5">— All DUMP (n=${dumps.length})</span>`,
    `<span style="color:#22d3ee">— Vel5-20 PUMP (n=${vel520P.length})</span>`,
    `<span style="color:#f97316">— Vel5-20 DUMP (n=${vel520D.length})</span>`,
  ].join(' &nbsp; ');

  const velChart = svgChart(
    'Average Path: Vel 5-20 (bold) vs All (faded)',
    velLines, velGrid
  );

  // ── 5. Derived metrics table ──────────────────────────────────────────────
  function avgMetricNum(rows: any[], col: string): number | null {
    const vals = rows.map(r => r[col] as number | null).filter(v => v != null) as number[];
    if (vals.length === 0) return null;
    return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3);
  }
  function effectSizeNum(p: any[], d: any[], col: string): number | null {
    const pv = p.map(r => r[col] as number | null).filter(v => v != null) as number[];
    const dv = d.map(r => r[col] as number | null).filter(v => v != null) as number[];
    if (pv.length < 2 || dv.length < 2) return null;
    const pm = pv.reduce((a, b) => a + b, 0) / pv.length;
    const dm = dv.reduce((a, b) => a + b, 0) / dv.length;
    const pv2 = pv.reduce((a, b) => a + (b - pm) ** 2, 0) / pv.length;
    const dv2 = dv.reduce((a, b) => a + (b - dm) ** 2, 0) / dv.length;
    const pooledSD = Math.sqrt((pv2 + dv2) / 2);
    if (pooledSD === 0) return null;
    return +Math.abs(pm - dm) / pooledSD;
  }
  function avgMetric(rows: any[], col: string): string {
    const vals = rows.map(r => r[col] as number | null).filter(v => v != null) as number[];
    if (vals.length === 0) return '—';
    const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3);
    return `${avg} <span style="opacity:0.55;font-size:0.85em">(n=${vals.length})</span>`;
  }
  function effectSize(p: any[], d: any[], col: string): string {
    const d_eff = effectSizeNum(p, d, col);
    if (d_eff === null) return '—';
    const cls = d_eff > 0.8 ? 'green' : d_eff > 0.4 ? 'yellow' : 'red';
    return `<span class="${cls}">${d_eff.toFixed(2)}</span>`;
  }

  const METRIC_COLS: Array<[string, string]> = [
    ['acceleration_t30',    'Acceleration at T+30'],
    ['acceleration_t60',    'Acceleration at T+60'],
    ['monotonicity_0_30',   'Monotonicity 0–30s (0–1)'],
    ['monotonicity_0_60',   'Monotonicity 0–60s (0–1)'],
    ['path_smoothness_0_30','Path Smoothness 0–30s (SD)'],
    ['path_smoothness_0_60','Path Smoothness 0–60s (SD)'],
    ['max_drawdown_0_30',   'Max Drawdown 0–30s (%)'],
    ['max_drawdown_0_60',   'Max Drawdown 0–60s (%)'],
    ['early_vs_late_0_30',  'Early vs Late 0–30s'],
    ['early_vs_late_0_60',  'Early vs Late 0–60s'],
  ];

  // Collect raw metric data for JSON export
  const derivedMetricsJson: Record<string, { pump_avg: number | null; dump_avg: number | null; stable_avg: number | null; cohens_d: number | null }> = {};
  for (const [col] of METRIC_COLS) {
    derivedMetricsJson[col] = {
      pump_avg:   avgMetricNum(pumps,   col),
      dump_avg:   avgMetricNum(dumps,   col),
      stable_avg: avgMetricNum(stables, col),
      cohens_d:   effectSizeNum(pumps, dumps, col),
    };
  }
  const pDipForJson = pumps.filter(r => r.dip_and_recover_flag === 1).length;
  const dDipForJson = dumps.filter(r => r.dip_and_recover_flag === 1).length;
  const sDipForJson = stables.filter(r => r.dip_and_recover_flag === 1).length;
  derivedMetricsJson['dip_and_recover_flag'] = {
    pump_avg:   pumps.length   > 0 ? +(pDipForJson / pumps.length   * 100).toFixed(1) : null,
    dump_avg:   dumps.length   > 0 ? +(dDipForJson / dumps.length   * 100).toFixed(1) : null,
    stable_avg: stables.length > 0 ? +(sDipForJson / stables.length * 100).toFixed(1) : null,
    cohens_d:   null,
  };

  const metricRows = METRIC_COLS.map(([col, label]) => `
    <tr>
      <td>${label}</td>
      <td class="green">${avgMetric(pumps, col)}</td>
      <td class="red">${avgMetric(dumps, col)}</td>
      <td class="yellow">${avgMetric(stables, col)}</td>
      <td>${effectSize(pumps, dumps, col)}</td>
    </tr>`).join('');

  const dipRow = (() => {
    const pDip = pumps.filter(r => r.dip_and_recover_flag === 1).length;
    const dDip = dumps.filter(r => r.dip_and_recover_flag === 1).length;
    const sDip = stables.filter(r => r.dip_and_recover_flag === 1).length;
    return `
    <tr>
      <td>Dip &amp; Recover % (flag=1)</td>
      <td class="green">${pumps.length > 0 ? `${(pDip/pumps.length*100).toFixed(1)}% <span style="opacity:0.55;font-size:0.85em">(n=${pumps.length})</span>` : '—'}</td>
      <td class="red">${dumps.length > 0 ? `${(dDip/dumps.length*100).toFixed(1)}% <span style="opacity:0.55;font-size:0.85em">(n=${dumps.length})</span>` : '—'}</td>
      <td class="yellow">${stables.length > 0 ? `${(sDip/stables.length*100).toFixed(1)}% <span style="opacity:0.55;font-size:0.85em">(n=${stables.length})</span>` : '—'}</td>
      <td>—</td>
    </tr>`;
  })();

  const metricsTable = `
  <div class="card">
    <h2>Derived Path Metrics by Label</h2>
    <div class="desc">Effect Size = Cohen's d (|PUMP mean − DUMP mean| / pooled SD). >0.8 = large signal (green), 0.4–0.8 = medium (yellow), &lt;0.4 = weak (red).</div>
    <table>
      <tr><th>Metric</th><th>PUMP avg</th><th>DUMP avg</th><th>STABLE avg</th><th>Effect Size</th></tr>
      ${metricRows}
      ${dipRow}
    </table>
  </div>`;

  // ── 6. Acceleration histogram (PUMP vs DUMP) ──────────────────────────────
  const accValues = (label: string) =>
    labeled.filter(r => r.label === label && r.acceleration_t30 != null)
           .map(r => r.acceleration_t30 as number);

  const pumpAcc = accValues('PUMP');
  const dumpAcc = accValues('DUMP');

  let accHistHtml = '';
  if (pumpAcc.length > 0 || dumpAcc.length > 0) {
    const allAcc = [...pumpAcc, ...dumpAcc];
    const accMin = Math.max(Math.min(...allAcc), -100);
    const accMax = Math.min(Math.max(...allAcc),  100);
    const BIN_COUNT = 14;
    const binW = (accMax - accMin) / BIN_COUNT;

    function buildBins(vals: number[]): number[] {
      const bins = new Array(BIN_COUNT).fill(0);
      for (const v of vals) {
        const idx = Math.min(Math.floor((v - accMin) / binW), BIN_COUNT - 1);
        if (idx >= 0) bins[idx]++;
      }
      return bins;
    }
    const pBins = buildBins(pumpAcc);
    const dBins = buildBins(dumpAcc);
    const maxCount = Math.max(...pBins, ...dBins, 1);

    const HW = 800, HH = 160, HP = 30;
    const bw = (HW - HP * 2) / BIN_COUNT;
    const bars: string[] = [];
    for (let i = 0; i < BIN_COUNT; i++) {
      const x = HP + i * bw;
      const ph = (pBins[i] / maxCount) * (HH - HP - 20);
      const dh = (dBins[i] / maxCount) * (HH - HP - 20);
      const py = HH - HP - ph;
      const dy = HH - HP - dh;
      bars.push(`<rect x="${x}" y="${py}" width="${bw * 0.45}" height="${ph}" fill="#4ade80" opacity="0.6"/>`);
      bars.push(`<rect x="${x + bw * 0.5}" y="${dy}" width="${bw * 0.45}" height="${dh}" fill="#ef4444" opacity="0.6"/>`);
      const label = (accMin + i * binW).toFixed(0);
      bars.push(`<text x="${x + bw / 2}" y="${HH - 5}" fill="#64748b" font-size="9" text-anchor="middle">${label}</text>`);
    }

    accHistHtml = `
    <div class="card">
      <h2>Acceleration T+30 Histogram</h2>
      <div class="desc">Distribution of momentum acceleration at T+30 — (pct_t30−pct_t25)−(pct_t25−pct_t20). Green=PUMP (n=${pumpAcc.length}), Red=DUMP (n=${dumpAcc.length}). Separation = usable filter.</div>
      <div style="overflow-x:auto">
      <svg width="${HW}" height="${HH}" viewBox="0 0 ${HW} ${HH}" style="background:#13131f;border-radius:8px;display:block">
        <line x1="${HP}" y1="${HH - HP}" x2="${HW - HP}" y2="${HH - HP}" stroke="#333" stroke-width="1"/>
        ${bars.join('\n        ')}
      </svg>
      </div>
    </div>`;
  }

  // ── 7. Entry timing heatmap ───────────────────────────────────────────────
  const SL = 10, TP = 50;
  const entryTimes = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
  const entrySimRows: string[] = [];
  let bestTime = '—', bestReturn = -Infinity;
  let bestVelTime = '—', bestVelReturn = -Infinity;
  const entryHeatmapJson: Array<{ entry_time: string; all: { n: number; win_rate: number; avg_return: number }; vel520: { n: number; win_rate: number; avg_return: number } }> = [];

  // Load full data for simulation (needs more pct columns + slippage)
  const simRows = db.prepare(`
    SELECT label, bc_velocity_sol_per_min, round_trip_slippage_pct,
           pct_t5,  pct_t10, pct_t15, pct_t20, pct_t25, pct_t30,
           pct_t35, pct_t40, pct_t45, pct_t50, pct_t55, pct_t60,
           pct_t90, pct_t120, pct_t150, pct_t180, pct_t240, pct_t300
    FROM graduation_momentum
    WHERE label IS NOT NULL
  `).all() as any[];

  const simRowsVel520 = simRows.filter(
    r => r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20
  );

  const fmtRet = (r: { avg_return: number; n: number }) => {
    if (r.n === 0) return '<span class="n-insuf">—</span>';
    const cls = r.avg_return > 0 ? 'ev-pos' : r.avg_return < -0.5 ? 'ev-neg' : '';
    return `<span class="${cls}">${r.avg_return > 0 ? '+' : ''}${r.avg_return}%</span>`;
  };

  for (const t of entryTimes) {
    const col = `pct_t${t}`;
    const rAll = simulateEntryAtTime(simRows,       col, SL, TP, 5, 100);
    const rVel = simulateEntryAtTime(simRowsVel520, col, SL, TP, 5, 100);
    entrySimRows.push(`
      <tr>
        <td>T+${t}s</td>
        <td>${rAll.n || 0}</td>
        <td>${rAll.n > 0 ? rAll.win_rate + '%' : '—'}</td>
        <td>${fmtRet(rAll)}</td>
        <td>${rVel.n || 0}</td>
        <td>${rVel.n > 0 ? rVel.win_rate + '%' : '—'}</td>
        <td>${fmtRet(rVel)}</td>
      </tr>`);
    entryHeatmapJson.push({ entry_time: `T+${t}s`, all: rAll, vel520: rVel });
    if (rAll.n >= 20 && rAll.avg_return > bestReturn) {
      bestReturn = rAll.avg_return; bestTime = `T+${t}s`;
    }
    if (rVel.n >= 10 && rVel.avg_return > bestVelReturn) {
      bestVelReturn = rVel.avg_return; bestVelTime = `T+${t}s`;
    }
  }

  const entryHeatmap = `
  <div class="card">
    <h2>Entry Timing Heatmap (${SL}% SL / ${TP}% TP)</h2>
    <div class="desc">If we entered at each 5s snapshot instead of T+30, how does avg return change? Gate: +5% to +100% from open. Costs: 30% SL gap (recalibrated 2026-04-15), 10% TP gap, round-trip slippage. <b style="color:#60a5fa">Vel 5-20</b> = primary thesis filter (bc_velocity 5–20 sol/min).</div>
    <table>
      <tr>
        <th rowspan="2">Entry Time</th>
        <th colspan="3" style="background:#1a2a1a;color:#4ade80;text-align:center">All Tokens</th>
        <th colspan="3" style="background:#1a1a2e;color:#60a5fa;text-align:center">Vel 5-20 sol/min</th>
      </tr>
      <tr>
        <th style="background:#1a2a1a">n</th><th style="background:#1a2a1a">Win Rate</th><th style="background:#1a2a1a">Avg Return</th>
        <th style="background:#1a1a2e">n</th><th style="background:#1a1a2e">Win Rate</th><th style="background:#1a1a2e">Avg Return</th>
      </tr>
      ${entrySimRows.join('')}
    </table>
    <div style="margin-top:8px;font-size:12px;color:#94a3b8">
      Best all-tokens (n≥20): <span class="green">${bestTime}</span>
      &nbsp;|&nbsp;
      Best vel 5-20 (n≥10): <span class="blue">${bestVelTime}</span>
    </div>
  </div>`;

  // ── 8. Monotonicity breakdown ─────────────────────────────────────────────
  const monoBuckets = [
    { label: '0–33% (choppy)',    min: 0,    max: 0.334 },
    { label: '33–67% (mixed)',    min: 0.334, max: 0.667 },
    { label: '67–100% (smooth)', min: 0.667, max: 1.001 },
  ];

  const monoJsonData: Array<{ bucket: string; n: number; pump: number; dump: number; win_rate_pct: number | null; vel520_n: number; vel520_win_rate_pct: number | null }> = [];
  const monoRows = monoBuckets.map(b => {
    const inBucket = labeled.filter(r => r.monotonicity_0_30 != null && r.monotonicity_0_30 >= b.min && r.monotonicity_0_30 < b.max);
    const bPump = inBucket.filter(r => r.label === 'PUMP').length;
    const bDump = inBucket.filter(r => r.label === 'DUMP').length;
    const bN    = inBucket.length;
    const vSub  = inBucket.filter(r => r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20);
    const vN    = vSub.length;
    const vP    = vSub.filter(r => r.label === 'PUMP').length;
    monoJsonData.push({
      bucket: b.label,
      n: bN,
      pump: bPump,
      dump: bDump,
      win_rate_pct: bN > 0 ? +(bPump / bN * 100).toFixed(1) : null,
      vel520_n: vN,
      vel520_win_rate_pct: vN > 0 ? +(vP / vN * 100).toFixed(1) : null,
    });
    return `
    <tr>
      <td>${b.label}</td><td>${bN}</td>
      <td class="green">${bPump}</td><td class="red">${bDump}</td>
      <td>${wr(bN > 0 ? +((bPump / bN) * 100).toFixed(1) : null)}</td>
      <td>${vN}</td><td>${wr(vN > 0 ? +(vP / vN * 100).toFixed(1) : null)}</td>
    </tr>`;
  }).join('');

  const monoTable = `
  <div class="card">
    <h2>Win Rate by Monotonicity (0–30s)</h2>
    <div class="desc">Does a smooth upward path (high monotonicity) predict PUMP? Cross-referenced with vel 5-20 filter.</div>
    <table>
      <tr><th>Bucket</th><th>n</th><th>PUMP</th><th>DUMP</th><th>Win Rate</th><th>Vel5-20 n</th><th>Vel5-20 WR</th></tr>
      ${monoRows || '<tr><td colspan="7" class="n-insuf">No monotonicity data yet — data will appear once 5s snapshots are collected</td></tr>'}
    </table>
  </div>`;

  // ── Assemble page ──────────────────────────────────────────────────────────
  const statusCard = `
  <div class="card">
    <h2>Price Path Data Status</h2>
    <div class="stat"><span class="label">Tokens with complete T+0→T+60 5s data</span><span class="value blue">${total5s}</span></div>
    <div class="stat"><span class="label">Labeled tokens used for charts</span><span class="value">${labeled.length}</span></div>
    <div class="stat"><span class="label">PUMP / DUMP / STABLE</span><span class="value"><span class="green">${pumps.length}</span> / <span class="red">${dumps.length}</span> / <span class="yellow">${stables.length}</span></span></div>
    <div class="stat"><span class="label">Vel 5-20 subset</span><span class="value">${vel520.length} (${vel520P.length} PUMP / ${vel520D.length} DUMP)</span></div>
    ${total5s === 0 ? '<div style="color:#facc15;margin-top:8px;font-size:12px">No 5s data yet — charts will populate as the bot collects new graduations with the updated snapshot schedule.</div>' : ''}
  </div>`;

  const body = statusCard +
    '<hr class="section-sep">' + overlayChart +
    `<div style="font-size:11px;color:#64748b;margin-bottom:12px;padding-left:4px">${avgLegend}</div>` +
    '<hr class="section-sep">' + avgChart +
    '<hr class="section-sep">' + velChart +
    `<div style="font-size:11px;color:#64748b;margin-bottom:12px;padding-left:4px">${velLegend}</div>` +
    '<hr class="section-sep">' + metricsTable +
    accHistHtml +
    '<hr class="section-sep">' + entryHeatmap +
    '<hr class="section-sep">' + monoTable;

  return shell('Price Path Analysis — Graduation Arb Research', '/price-path', body, {
    total_5s_tokens: total5s,
    labeled_count: labeled.length,
    by_label: { PUMP: pumps.length, DUMP: dumps.length, STABLE: stables.length },
    vel520_count: vel520.length,
    best_entry_time: bestTime,
    best_entry_avg_return: bestReturn === -Infinity ? null : bestReturn,
    best_vel520_entry_time: bestVelTime,
    best_vel520_entry_avg_return: bestVelReturn === -Infinity ? null : bestVelReturn,
    derived_path_metrics_by_label: derivedMetricsJson,
    entry_timing_heatmap_sl10_tp50: entryHeatmapJson,
    win_rate_by_monotonicity_0_30: monoJsonData,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trading dashboard
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a UTC datetime string (from SQLite datetime()) to Central Time display */
function utcToCentral(utcStr: string | null | undefined): string {
  if (!utcStr) return '-';
  try {
    // Two input formats are passed in:
    //  - SQLite datetime(): "YYYY-MM-DD HH:MM:SS" (no timezone, treat as UTC)
    //  - JS Date.toISOString(): "YYYY-MM-DDTHH:MM:SS.sssZ" (already UTC-marked)
    // Only append Z when the input has no timezone marker — appending it to an
    // ISO string that already has Z produces "...ZZ" which Date.parse rejects.
    const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(utcStr);
    const d = new Date(hasTz ? utcStr : utcStr + 'Z');
    if (isNaN(d.getTime())) return utcStr;
    return d.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
      hour12: true,
    });
  } catch { return utcStr; }
}

/**
 * Filter presets matching PANEL_1_FILTERS from filter-analysis-v2.
 * Each maps to the FilterConfig[] array used by the trading engine.
 * Grouped by category for <optgroup> rendering.
 */
const FILTER_PRESET_GROUPS: Array<{ group: string; filters: Array<{ name: string; configs: Array<{ field: string; operator: string; value: number; label: string }> }> }> = [
  { group: 'Velocity', filters: [
    { name: 'vel < 5 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '<', value: 5, label: 'vel<5' }] },
    { name: 'vel 5-10 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '>=', value: 5, label: 'vel>=5' }, { field: 'bc_velocity_sol_per_min', operator: '<', value: 10, label: 'vel<10' }] },
    { name: 'vel 5-20 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '>=', value: 5, label: 'vel>=5' }, { field: 'bc_velocity_sol_per_min', operator: '<', value: 20, label: 'vel<20' }] },
    { name: 'vel 10-20 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '>=', value: 10, label: 'vel>=10' }, { field: 'bc_velocity_sol_per_min', operator: '<', value: 20, label: 'vel<20' }] },
    { name: 'vel < 20 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '<', value: 20, label: 'vel<20' }] },
    { name: 'vel < 50 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '<', value: 50, label: 'vel<50' }] },
    { name: 'vel 20-50 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '>=', value: 20, label: 'vel>=20' }, { field: 'bc_velocity_sol_per_min', operator: '<', value: 50, label: 'vel<50' }] },
    { name: 'vel 50-200 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '>=', value: 50, label: 'vel>=50' }, { field: 'bc_velocity_sol_per_min', operator: '<', value: 200, label: 'vel<200' }] },
    { name: 'vel > 200 sol/min', configs: [{ field: 'bc_velocity_sol_per_min', operator: '>=', value: 200, label: 'vel>=200' }] },
  ]},
  { group: 'BC Age', filters: [
    { name: 'bc_age < 10 min', configs: [{ field: 'token_age_seconds', operator: '<', value: 600, label: 'age<10m' }] },
    { name: 'bc_age > 10 min', configs: [{ field: 'token_age_seconds', operator: '>', value: 600, label: 'age>10m' }] },
    { name: 'bc_age > 30 min', configs: [{ field: 'token_age_seconds', operator: '>', value: 1800, label: 'age>30m' }] },
    { name: 'bc_age > 1 hr', configs: [{ field: 'token_age_seconds', operator: '>', value: 3600, label: 'age>1h' }] },
    { name: 'bc_age > 1 day', configs: [{ field: 'token_age_seconds', operator: '>', value: 86400, label: 'age>1d' }] },
  ]},
  { group: 'Holders', filters: [
    { name: 'holders >= 5', configs: [{ field: 'holder_count', operator: '>=', value: 5, label: 'holders>=5' }] },
    { name: 'holders >= 10', configs: [{ field: 'holder_count', operator: '>=', value: 10, label: 'holders>=10' }] },
    { name: 'holders >= 15', configs: [{ field: 'holder_count', operator: '>=', value: 15, label: 'holders>=15' }] },
    { name: 'holders >= 18', configs: [{ field: 'holder_count', operator: '>=', value: 18, label: 'holders>=18' }] },
  ]},
  { group: 'Top 5 Concentration', filters: [
    { name: 'top5 < 10%', configs: [{ field: 'top5_wallet_pct', operator: '<', value: 10, label: 'top5<10%' }] },
    { name: 'top5 < 15%', configs: [{ field: 'top5_wallet_pct', operator: '<', value: 15, label: 'top5<15%' }] },
    { name: 'top5 < 20%', configs: [{ field: 'top5_wallet_pct', operator: '<', value: 20, label: 'top5<20%' }] },
    { name: 'top5 > 15%', configs: [{ field: 'top5_wallet_pct', operator: '>', value: 15, label: 'top5>15%' }] },
  ]},
  { group: 'Dev Wallet', filters: [
    { name: 'dev < 3%', configs: [{ field: 'dev_wallet_pct', operator: '<', value: 3, label: 'dev<3%' }] },
    { name: 'dev < 5%', configs: [{ field: 'dev_wallet_pct', operator: '<', value: 5, label: 'dev<5%' }] },
    { name: 'dev > 5%', configs: [{ field: 'dev_wallet_pct', operator: '>', value: 5, label: 'dev>5%' }] },
  ]},
  { group: 'SOL Raised', filters: [
    { name: 'sol >= 70', configs: [{ field: 'total_sol_raised', operator: '>=', value: 70, label: 'sol>=70' }] },
    { name: 'sol >= 80', configs: [{ field: 'total_sol_raised', operator: '>=', value: 80, label: 'sol>=80' }] },
    { name: 'sol >= 84', configs: [{ field: 'total_sol_raised', operator: '>=', value: 84, label: 'sol>=84' }] },
  ]},
  { group: 'Liquidity (T+30)', filters: [
    { name: 'liquidity > 50 SOL', configs: [{ field: 'liquidity_sol_t30', operator: '>', value: 50, label: 'liq>50' }] },
    { name: 'liquidity > 100 SOL', configs: [{ field: 'liquidity_sol_t30', operator: '>', value: 100, label: 'liq>100' }] },
    { name: 'liquidity > 150 SOL', configs: [{ field: 'liquidity_sol_t30', operator: '>', value: 150, label: 'liq>150' }] },
  ]},
  { group: 'Volatility (0-30s)', filters: [
    { name: 'volatility < 10%', configs: [{ field: 'volatility_0_30', operator: '<', value: 10, label: 'vol<10%' }] },
    { name: 'volatility 10-30%', configs: [{ field: 'volatility_0_30', operator: '>=', value: 10, label: 'vol>=10%' }, { field: 'volatility_0_30', operator: '<', value: 30, label: 'vol<30%' }] },
    { name: 'volatility 30-60%', configs: [{ field: 'volatility_0_30', operator: '>=', value: 30, label: 'vol>=30%' }, { field: 'volatility_0_30', operator: '<', value: 60, label: 'vol<60%' }] },
    { name: 'volatility > 60%', configs: [{ field: 'volatility_0_30', operator: '>=', value: 60, label: 'vol>=60%' }] },
  ]},
  { group: 'Path: Monotonicity', filters: [
    { name: 'mono > 0.33', configs: [{ field: 'monotonicity_0_30', operator: '>', value: 0.33, label: 'mono>0.33' }] },
    { name: 'mono > 0.5', configs: [{ field: 'monotonicity_0_30', operator: '>', value: 0.5, label: 'mono>0.5' }] },
    { name: 'mono > 0.66', configs: [{ field: 'monotonicity_0_30', operator: '>', value: 0.66, label: 'mono>0.66' }] },
  ]},
  { group: 'Path: Drawdown', filters: [
    { name: 'max_dd > -10% (shallow)', configs: [{ field: 'max_drawdown_0_30', operator: '>', value: -10, label: 'dd>-10%' }] },
    { name: 'max_dd > -20%', configs: [{ field: 'max_drawdown_0_30', operator: '>', value: -20, label: 'dd>-20%' }] },
  ]},
  { group: 'Path: Tick Drop', filters: [
    { name: 'max_tick_drop > -3%', configs: [{ field: 'max_tick_drop_0_30', operator: '>', value: -3,  label: 'tick>-3%' }] },
    { name: 'max_tick_drop > -5%', configs: [{ field: 'max_tick_drop_0_30', operator: '>', value: -5,  label: 'tick>-5%' }] },
    { name: 'max_tick_drop > -8%', configs: [{ field: 'max_tick_drop_0_30', operator: '>', value: -8,  label: 'tick>-8%' }] },
    { name: 'max_tick_drop > -10%', configs: [{ field: 'max_tick_drop_0_30', operator: '>', value: -10, label: 'tick>-10%' }] },
    { name: 'max_tick_drop > -15%', configs: [{ field: 'max_tick_drop_0_30', operator: '>', value: -15, label: 'tick>-15%' }] },
  ]},
  { group: 'Path: Realized Vol', filters: [
    { name: 'sum_abs < 20',  configs: [{ field: 'sum_abs_returns_0_30', operator: '<', value: 20,  label: 'sum_abs<20'  }] },
    { name: 'sum_abs < 40',  configs: [{ field: 'sum_abs_returns_0_30', operator: '<', value: 40,  label: 'sum_abs<40'  }] },
    { name: 'sum_abs < 60',  configs: [{ field: 'sum_abs_returns_0_30', operator: '<', value: 60,  label: 'sum_abs<60'  }] },
    { name: 'sum_abs < 100', configs: [{ field: 'sum_abs_returns_0_30', operator: '<', value: 100, label: 'sum_abs<100' }] },
    { name: 'sum_abs > 20',  configs: [{ field: 'sum_abs_returns_0_30', operator: '>', value: 20,  label: 'sum_abs>20'  }] },
    { name: 'sum_abs > 40',  configs: [{ field: 'sum_abs_returns_0_30', operator: '>', value: 40,  label: 'sum_abs>40'  }] },
    { name: 'sum_abs > 60',  configs: [{ field: 'sum_abs_returns_0_30', operator: '>', value: 60,  label: 'sum_abs>60'  }] },
  ]},
  { group: 'Path: Other', filters: [
    { name: 'dip_and_recover = 1', configs: [{ field: 'dip_and_recover_flag', operator: '==', value: 1, label: 'dip_recover' }] },
    { name: 'acceleration > 0', configs: [{ field: 'acceleration_t30', operator: '>', value: 0, label: 'accel>0' }] },
    { name: 'front-loaded (early>late)', configs: [{ field: 'early_vs_late_0_30', operator: '>', value: 0, label: 'front-loaded' }] },
    { name: 'back-loaded (late>early)', configs: [{ field: 'early_vs_late_0_30', operator: '<', value: 0, label: 'back-loaded' }] },
  ]},
  { group: 'Buy Pressure', filters: [
    { name: 'buy_ratio > 0.5', configs: [{ field: 'buy_pressure_buy_ratio', operator: '>', value: 0.5, label: 'buy_ratio>0.5' }] },
    { name: 'buy_ratio > 0.6', configs: [{ field: 'buy_pressure_buy_ratio', operator: '>', value: 0.6, label: 'buy_ratio>0.6' }] },
    { name: 'unique_buyers >= 5', configs: [{ field: 'buy_pressure_unique_buyers', operator: '>=', value: 5, label: 'buyers>=5' }] },
    { name: 'unique_buyers >= 10', configs: [{ field: 'buy_pressure_unique_buyers', operator: '>=', value: 10, label: 'buyers>=10' }] },
    { name: 'whale_pct < 30%', configs: [{ field: 'buy_pressure_whale_pct', operator: '<', value: 30, label: 'whale<30%' }] },
    { name: 'whale_pct < 50%', configs: [{ field: 'buy_pressure_whale_pct', operator: '<', value: 50, label: 'whale<50%' }] },
  ]},
  { group: 'Snipers', filters: [
    { name: 'snipers <= 2', configs: [{ field: 'sniper_count_t0_t2', operator: '<=', value: 2, label: 'snipers <= 2' }] },
    { name: 'snipers <= 5', configs: [{ field: 'sniper_count_t0_t2', operator: '<=', value: 5, label: 'snipers <= 5' }] },
    { name: 'snipers > 5', configs: [{ field: 'sniper_count_t0_t2', operator: '>', value: 5, label: 'snipers > 5' }] },
    { name: 'snipers > 10', configs: [{ field: 'sniper_count_t0_t2', operator: '>', value: 10, label: 'snipers > 10' }] },
  ]},
  { group: 'Sniper Wallet Velocity', filters: [
    { name: 'wallet_vel_avg < 5', configs: [{ field: 'sniper_wallet_velocity_avg', operator: '<', value: 5, label: 'wallet_vel_avg < 5' }] },
    { name: 'wallet_vel_avg < 10', configs: [{ field: 'sniper_wallet_velocity_avg', operator: '<', value: 10, label: 'wallet_vel_avg < 10' }] },
    { name: 'wallet_vel_avg < 20', configs: [{ field: 'sniper_wallet_velocity_avg', operator: '<', value: 20, label: 'wallet_vel_avg < 20' }] },
    { name: 'wallet_vel_avg >= 20', configs: [{ field: 'sniper_wallet_velocity_avg', operator: '>=', value: 20, label: 'wallet_vel_avg >= 20' }] },
  ]},
  { group: 'Creator Reputation', filters: [
    { name: 'fresh_dev (0 prior)', configs: [{ field: 'creator_prior_token_count', operator: '==', value: 0, label: 'fresh_dev' }] },
    { name: 'repeat_dev >= 3', configs: [{ field: 'creator_prior_token_count', operator: '>=', value: 3, label: 'repeat>=3' }] },
    { name: 'clean_dev (rug < 30%)', configs: [{ field: 'creator_prior_rug_rate', operator: '<', value: 0.3, label: 'clean_dev' }] },
    { name: 'serial_rugger (rug >= 70%)', configs: [{ field: 'creator_prior_rug_rate', operator: '>=', value: 0.7, label: 'rugger' }] },
    { name: 'rapid_fire (< 1hr gap)', configs: [{ field: 'creator_last_token_age_hours', operator: '<', value: 1, label: 'rapid_fire' }] },
  ]},
  { group: 'T+30 Entry', filters: [
    { name: 't30 > 0%', configs: [{ field: 'pct_t30', operator: '>', value: 0, label: 't30>0%' }] },
    { name: 't30 +5% to +50%', configs: [{ field: 'pct_t30', operator: '>=', value: 5, label: 't30>=5%' }, { field: 'pct_t30', operator: '<=', value: 50, label: 't30<=50%' }] },
    { name: 't30 +5% to +100%', configs: [{ field: 'pct_t30', operator: '>=', value: 5, label: 't30>=5%' }, { field: 'pct_t30', operator: '<=', value: 100, label: 't30<=100%' }] },
    { name: 't30 +10% to +50%', configs: [{ field: 'pct_t30', operator: '>=', value: 10, label: 't30>=10%' }, { field: 'pct_t30', operator: '<=', value: 50, label: 't30<=50%' }] },
  ]},
];

const TP_OPTIONS = [10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100, 150];
const SL_OPTIONS = [3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30];

/** Build <option> tags for a filter select, with the matching option pre-selected */
function filterSelectOptions(selectedName: string): string {
  let html = '<option value="">-- None --</option>';
  for (const g of FILTER_PRESET_GROUPS) {
    html += `<optgroup label="${g.group}">`;
    for (const f of g.filters) {
      const sel = f.name === selectedName ? ' selected' : '';
      html += `<option value="${f.name}"${sel}>${f.name}</option>`;
    }
    html += '</optgroup>';
  }
  return html;
}

/** Build <option> tags for TP or SL select */
function numSelectOptions(options: number[], selected: number, suffix = '%'): string {
  return options.map(v => {
    const sel = v === selected ? ' selected' : '';
    return `<option value="${v}"${sel}>${v}${suffix}</option>`;
  }).join('');
}

/**
 * Reverse-lookup: given a FilterConfig array, find the best matching preset name.
 * Returns the preset name or '' if no match.
 */
function findPresetName(configs: any[]): string {
  if (!configs || configs.length === 0) return '';
  for (const g of FILTER_PRESET_GROUPS) {
    for (const f of g.filters) {
      if (f.configs.length !== configs.length) continue;
      const allMatch = f.configs.every((fc, i) => {
        const c = configs[i];
        return c && fc.field === c.field && fc.operator === c.operator && fc.value === c.value;
      });
      if (allMatch) return f.name;
    }
  }
  return '';
}

/**
 * Split a FilterConfig array into filter preset slots, one per preset.
 *
 * Walks the config array left-to-right; at each position, tries every preset
 * across every group (NOT just the next one in group-iteration order) and
 * picks the first match, preferring longer presets (e.g. "vel 20-50" which
 * consumes two configs) over shorter ones at the same position. If no preset
 * matches, emits an empty slot and advances by one config so the renderer
 * still shows a placeholder the user can fix. Returns at least 2 slots.
 */
function splitFiltersToPresets(allConfigs: any[]): string[] {
  if (!allConfigs || allConfigs.length === 0) return ['', ''];

  // Flatten all presets into one list, sorted by config-length DESC so a
  // 2-config preset (e.g. "vel 20-50") wins over a 1-config accidental
  // prefix match when both exist at the same position.
  type Preset = { name: string; configs: any[] };
  const allPresets: Preset[] = [];
  for (const g of FILTER_PRESET_GROUPS) {
    for (const f of g.filters) allPresets.push({ name: f.name, configs: f.configs });
  }
  allPresets.sort((a, b) => b.configs.length - a.configs.length);

  const matched: string[] = [];
  let i = 0;
  while (i < allConfigs.length) {
    const remaining = allConfigs.slice(i);
    let bestMatch: Preset | null = null;
    for (const p of allPresets) {
      if (p.configs.length > remaining.length) continue;
      const isMatch = p.configs.every((fc, j) => {
        const c = remaining[j];
        return c && fc.field === c.field && fc.operator === c.operator && fc.value === c.value;
      });
      if (isMatch) { bestMatch = p; break; } // first match wins (longest-first ordering)
    }
    if (bestMatch) {
      matched.push(bestMatch.name);
      i += bestMatch.configs.length;
    } else {
      // Config at position i has no matching preset — emit a placeholder slot
      // and advance one step so unmatched filters don't vanish silently.
      matched.push('');
      i += 1;
    }
  }
  while (matched.length < 2) matched.push('');
  return matched;
}

// ────────────────────────────────────────────────────────────────────────
// Trading-page research panels (added 2026-05-07)
// 5 panels surfaced on /trading underneath the existing performance cards:
//   distribution / edge-decay / counterfactual / loss-postmortem / journal
// Each takes the merged `data` object built in src/index.ts:/trading and
// returns an HTML card. Empty / no-data fallbacks render a muted card with
// an explanatory message instead of disappearing — keeps the layout stable
// while strategies populate.
// ────────────────────────────────────────────────────────────────────────

/** Per-strategy distribution panel (n, mean, median, p10/p25/p75/p90, min/max,
 *  std, exit-mix, top winner/loser). Sources from /api/strategy-percentiles. */
export function renderStrategyPercentilesPanel(data: any): string {
  const sp = data.strategy_percentiles;
  if (!sp || !Array.isArray(sp.rows) || sp.rows.length === 0) {
    return `
    <div class="card">
      <div class="card-title">Per-Strategy Distribution</div>
      <p style="color:#94a3b8">No active strategies yet — toggle one on to populate.</p>
    </div>`;
  }

  const fmt = (v: number | null | undefined, suffix = '') =>
    v == null ? '<span style="color:#64748b">-</span>' : `${v}${suffix}`;
  const colorMed = (v: number | null) =>
    v == null ? '#94a3b8' : v > 0 ? '#22d3ee' : '#f87171';

  const rowsHtml = sp.rows.map((r: any) => {
    const totalExits = (r.exit_reasons.take_profit ?? 0) + (r.exit_reasons.stop_loss ?? 0)
      + (r.exit_reasons.trailing_stop ?? 0) + (r.exit_reasons.breakeven_stop ?? 0)
      + (r.exit_reasons.trailing_tp ?? 0) + (r.exit_reasons.timeout ?? 0)
      + (r.exit_reasons.killswitch ?? 0);
    const pct = (count: number) => totalExits > 0 ? Math.round((count / totalExits) * 100) : 0;
    const exitMix = totalExits > 0
      ? `TP ${pct(r.exit_reasons.take_profit + r.exit_reasons.trailing_tp)}% · SL ${pct(r.exit_reasons.stop_loss + r.exit_reasons.trailing_stop + r.exit_reasons.breakeven_stop)}% · TO ${pct(r.exit_reasons.timeout)}%`
      : '<span style="color:#64748b">-</span>';

    // Two stacked sub-rows per strategy: gross then net.
    const gross = r.gross_return_pct;
    const net = r.net_return_pct;
    const winner = r.top_winners?.[0];
    const loser = r.top_losers?.[0];
    const winnerCell = winner
      ? `<span title="trade ${winner.trade_id} · grad ${winner.graduation_id ?? '?'}" style="font-size:11px">${mintCell(winner.mint, 6)} <span style="color:#22d3ee">+${winner.gross_return_pct?.toFixed(0)}%</span></span>`
      : '<span style="color:#64748b">-</span>';
    const loserCell = loser
      ? `<span title="trade ${loser.trade_id} · grad ${loser.graduation_id ?? '?'}" style="font-size:11px">${mintCell(loser.mint, 6)} <span style="color:#f87171">${loser.gross_return_pct?.toFixed(0)}%</span></span>`
      : '<span style="color:#64748b">-</span>';

    // Distribution badge — simple visual cue when whole IQR is on one side of zero.
    let badge = '';
    if (net.p25 != null && net.p25 > 0) {
      badge = '<span style="background:#065f4633;color:#4ade80;border:1px solid #065f46;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px">p25&gt;0</span>';
    } else if (net.p75 != null && net.p75 < 0) {
      badge = '<span style="background:#7f1d1d33;color:#f87171;border:1px solid #7f1d1d;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px">p75&lt;0</span>';
    }

    const sidEsc = escHtml(r.strategy_id);
    return `
      <tr style="border-top:2px solid #334155" data-strategy="${sidEsc}">
        <td rowspan="2" style="vertical-align:top">
          <div><a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;font-weight:600;cursor:pointer;text-decoration:none">${sidEsc}</a>${badge}</div>
          <div style="color:#64748b;font-size:11px">${escHtml(r.label)}</div>
          <div style="color:#94a3b8;font-size:11px">n=${r.n_closed} closed · cost ${fmt(r.avg_execution_cost_pp, 'pp')}</div>
        </td>
        <td style="color:#64748b;font-size:11px">gross</td>
        <td>${fmt(gross.mean, '%')}</td>
        <td style="color:${colorMed(gross.median)}">${fmt(gross.median, '%')}</td>
        <td>${fmt(gross.p10, '%')}</td>
        <td>${fmt(gross.p25, '%')}</td>
        <td>${fmt(gross.p75, '%')}</td>
        <td>${fmt(gross.p90, '%')}</td>
        <td>${fmt(gross.min, '%')}</td>
        <td>${fmt(gross.max, '%')}</td>
        <td>${fmt(gross.std_dev, '')}</td>
        <td rowspan="2" style="vertical-align:top;font-size:11px">${exitMix}</td>
        <td rowspan="2" style="vertical-align:top">${winnerCell}<br>${loserCell}</td>
      </tr>
      <tr data-strategy="${sidEsc}">
        <td style="color:#64748b;font-size:11px">net</td>
        <td>${fmt(net.mean, '%')}</td>
        <td style="color:${colorMed(net.median)}">${fmt(net.median, '%')}</td>
        <td>${fmt(net.p10, '%')}</td>
        <td>${fmt(net.p25, '%')}</td>
        <td>${fmt(net.p75, '%')}</td>
        <td>${fmt(net.p90, '%')}</td>
        <td>${fmt(net.min, '%')}</td>
        <td>${fmt(net.max, '%')}</td>
        <td>${fmt(net.std_dev, '')}</td>
      </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Per-Strategy Distribution
        <span style="color:#64748b;font-size:11px;font-weight:400">— closed trades only · sorted by median net desc</span>
      </div>
      <div style="overflow-x:auto"><table class="table">
        <thead><tr>
          <th>Strategy</th><th></th>
          <th>Mean</th><th>Median</th>
          <th>p10</th><th>p25</th><th>p75</th><th>p90</th>
          <th>Min</th><th>Max</th><th>Std</th>
          <th>Exit Mix</th><th>Top ↗ / ↘</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
    </div>`;
}

/** Inline SVG sparkline for the edge-decay panel. Width × height in px, value
 *  array oldest -> newest. Null entries leave a gap. */
function renderSparkline(values: Array<number | null>, width = 120, height = 30): string {
  const vals = values.filter((v): v is number => v != null);
  if (vals.length === 0) {
    return `<span style="color:#64748b;font-size:11px">no data</span>`;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = values.length > 1 ? innerW / (values.length - 1) : 0;

  const points: Array<[number, number]> = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const x = pad + i * step;
    const y = pad + innerH - ((v - min) / range) * innerH;
    points.push([+x.toFixed(1), +y.toFixed(1)]);
  }
  if (points.length === 0) {
    return `<span style="color:#64748b;font-size:11px">no data</span>`;
  }

  // Zero baseline if it falls in range.
  const zeroLine = (min < 0 && max > 0)
    ? `<line x1="${pad}" y1="${(pad + innerH - ((0 - min) / range) * innerH).toFixed(1)}" x2="${(pad + innerW).toFixed(1)}" y2="${(pad + innerH - ((0 - min) / range) * innerH).toFixed(1)}" stroke="#475569" stroke-width="0.5" stroke-dasharray="2,2"/>`
    : '';
  const last = points[points.length - 1];
  const lastVal = vals[vals.length - 1];
  const color = lastVal > 0 ? '#22d3ee' : '#f87171';
  const polylinePts = points.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg width="${width}" height="${height}" style="vertical-align:middle">
    ${zeroLine}
    <polyline points="${polylinePts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2" fill="${color}"/>
  </svg>`;
}

/** Edge-decay tracker panel — last 25/50/100/all + sparkline + flag. */
export function renderEdgeDecayPanel(data: any): string {
  const ed = data.edge_decay;
  if (!ed || !Array.isArray(ed.rows) || ed.rows.length === 0) {
    return `
    <div class="card">
      <div class="card-title">Edge-Decay Tracker</div>
      <p style="color:#94a3b8">No active strategies — toggle one on to populate.</p>
    </div>`;
  }

  const flagBadge = (flag: string) => {
    const styles: Record<string, { bg: string; fg: string; border: string }> = {
      'DECAYING':       { bg: '#7f1d1d33', fg: '#f87171', border: '#7f1d1d' },
      'STRENGTHENING':  { bg: '#065f4633', fg: '#4ade80', border: '#065f46' },
      'STABLE':         { bg: '#33415533', fg: '#94a3b8', border: '#334155' },
      'LOW-N':          { bg: '#33415533', fg: '#64748b', border: '#334155' },
    };
    const s = styles[flag] ?? styles['STABLE'];
    return `<span style="background:${s.bg};color:${s.fg};border:1px solid ${s.border};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:600">${flag}</span>`;
  };

  const fmtCell = (s: any) => {
    if (!s || s.n === 0) return '<span style="color:#64748b">-</span>';
    const m = s.median_net_pct;
    const color = m == null ? '#94a3b8' : m > 0 ? '#22d3ee' : '#f87171';
    return `<span style="color:${color}">${m == null ? '-' : m + '%'}</span><span style="color:#64748b;font-size:10px"> (n=${s.n})</span>`;
  };

  const rowsHtml = ed.rows.map((r: any) => {
    const sidEsc = escHtml(r.strategy_id);
    return `<tr data-strategy="${sidEsc}">
      <td>
        <div><a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;font-weight:600;cursor:pointer;text-decoration:none">${sidEsc}</a></div>
        <div style="color:#64748b;font-size:11px">${escHtml(r.label)}</div>
      </td>
      <td>${fmtCell(r.last_25)}</td>
      <td>${fmtCell(r.last_50)}</td>
      <td>${fmtCell(r.last_100)}</td>
      <td>${fmtCell(r.all)}</td>
      <td title="Median across the most recent ~30 trades">${r.recent_30_median_pct != null ? r.recent_30_median_pct + '%' : '<span style=\"color:#64748b\">-</span>'}</td>
      <td>${renderSparkline(r.sparkline)}</td>
      <td>${flagBadge(r.flag)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Edge-Decay Tracker
        <span style="color:#64748b;font-size:11px;font-weight:400">— median net % across rolling trade-count windows · DECAYING flag fires when last-30 median &lt; lifetime − 5pp</span>
      </div>
      <div style="overflow-x:auto"><table class="table">
        <thead><tr>
          <th>Strategy</th>
          <th>Last 25</th><th>Last 50</th><th>Last 100</th><th>All</th>
          <th title="Recent-30 median used by the flag rule">Recent-30</th>
          <th>Sparkline (oldest → newest)</th>
          <th>Flag</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
    </div>`;
}

/** Filter + TP/SL counterfactual panel. */
export function renderCounterfactualPanel(data: any): string {
  const cf = data.counterfactual;
  if (!cf || !Array.isArray(cf.rows) || cf.rows.length === 0) {
    return `
    <div class="card">
      <div class="card-title">Counterfactual — Filter + TP/SL</div>
      <p style="color:#94a3b8">No active strategies — toggle one on to populate.</p>
    </div>`;
  }

  const verdictBadge = (verdict: string) => {
    const styles: Record<string, { bg: string; fg: string; border: string }> = {
      'pulls weight': { bg: '#065f4633', fg: '#4ade80', border: '#065f46' },
      'dead weight':  { bg: '#33415533', fg: '#94a3b8', border: '#334155' },
      'hurts':        { bg: '#7f1d1d33', fg: '#f87171', border: '#7f1d1d' },
      'unknown':      { bg: '#33415533', fg: '#64748b', border: '#334155' },
    };
    const s = styles[verdict] ?? styles['unknown'];
    return `<span style="background:${s.bg};color:${s.fg};border:1px solid ${s.border};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">${verdict}</span>`;
  };

  const cardsHtml = cf.rows.map((r: any) => {
    const errBanner = r.error
      ? `<div style="background:#7f1d1d33;color:#f87171;border:1px solid #7f1d1d;padding:6px 10px;border-radius:4px;margin-bottom:8px;font-size:11px">${escHtml(r.error)}</div>`
      : '';

    const fmtPct = (v: number | null) => v == null
      ? '<span style="color:#64748b">-</span>'
      : `<span style="color:${v > 0 ? '#22d3ee' : '#f87171'}">${v > 0 ? '+' : ''}${v}%</span>`;
    const fmtDelta = (v: number | null) => v == null
      ? '<span style="color:#64748b">-</span>'
      : `<span style="color:${v > 0 ? '#22d3ee' : v < 0 ? '#f87171' : '#94a3b8'}">${v > 0 ? '+' : ''}${v}pp</span>`;

    const dropRows = (r.filter_drops || []).map((d: any) => `
      <tr>
        <td style="color:#94a3b8;font-size:11px">${escHtml(d.label)}</td>
        <td>${d.n_with}</td>
        <td>${d.n_without}<span style="color:${d.delta_n > 0 ? '#22d3ee' : '#f87171'};font-size:10px"> (${d.delta_n > 0 ? '+' : ''}${d.delta_n})</span></td>
        <td>${fmtPct(d.opt_avg_ret_with)}</td>
        <td>${fmtPct(d.opt_avg_ret_without)}</td>
        <td>${fmtDelta(d.delta_ret_pp)}</td>
        <td>${verdictBadge(d.verdict)}</td>
      </tr>`).join('');

    const altRows = (r.tp_sl_alternatives || []).map((a: any) => `
      <tr>
        <td>${a.tp}%</td>
        <td>${a.sl}%</td>
        <td>${fmtPct(a.avg_ret)}</td>
        <td>${a.win_rate}%</td>
        <td>${fmtDelta(a.delta_ret_pp)}</td>
        <td><span style="color:${a.delta_win_rate_pp > 0 ? '#22d3ee' : '#f87171'}">${a.delta_win_rate_pp > 0 ? '+' : ''}${a.delta_win_rate_pp}pp</span></td>
      </tr>`).join('');

    const tpSlHeader = `
      <div style="display:flex;align-items:center;gap:12px;margin:12px 0 6px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">
        TP / SL alternatives
        <span style="color:#64748b;font-weight:400;text-transform:none;letter-spacing:0">configured ${r.configured.tp_input}%/${r.configured.sl_input}% → grid ${r.configured.tp_grid}%/${r.configured.sl_grid}% (avg_ret ${r.configured.avg_ret == null ? '-' : r.configured.avg_ret + '%'}, wr ${r.configured.win_rate == null ? '-' : r.configured.win_rate + '%'})</span>
      </div>`;

    const altsTable = altRows ? `<table class="table" style="font-size:11px">
      <thead><tr><th>TP</th><th>SL</th><th>Avg Ret</th><th>Win%</th><th>Δret vs cfg</th><th>Δwr vs cfg</th></tr></thead>
      <tbody>${altRows}</tbody>
    </table>` : '<p style="color:#64748b;font-size:11px;margin:0">No qualifying alternatives in the grid.</p>';

    const dropTable = dropRows ? `<table class="table" style="font-size:11px">
      <thead><tr><th>Filter</th><th>n with</th><th>n w/o</th><th>opt with</th><th>opt w/o</th><th>Δret pp</th><th>Verdict</th></tr></thead>
      <tbody>${dropRows}</tbody>
    </table>` : '<p style="color:#64748b;font-size:11px;margin:0">No filters configured — counterfactual only shows TP/SL grid.</p>';

    const sidEsc = escHtml(r.strategy_id);
    return `
      <div data-strategy="${sidEsc}" style="background:#0f172a;border:1px solid #334155;border-radius:6px;padding:12px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div>
            <a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;font-weight:600;cursor:pointer;text-decoration:none">${sidEsc}</a>
            <span style="color:#94a3b8;font-size:12px;margin-left:6px">${escHtml(r.label)}</span>
            <span style="color:#64748b;font-size:11px;margin-left:8px">entry T+${r.entry_sec} · n=${r.baseline_n} · opt ${r.opt.tp == null ? '-' : r.opt.tp + '%/' + r.opt.sl + '% → ' + (r.opt.avg_ret > 0 ? '+' : '') + r.opt.avg_ret + '%'}</span>
          </div>
        </div>
        ${errBanner}
        <div style="color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Filter contribution</div>
        ${dropTable}
        ${tpSlHeader}
        ${altsTable}
      </div>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Counterfactual — Filter + TP/SL
        <span style="color:#64748b;font-size:11px;font-weight:400">— Δret &lt; 0 means dropping the filter hurts (filter pulls weight) · TP/SL alternatives from the same 12×10 grid as /api/best-combos</span>
      </div>
      ${cardsHtml}
    </div>`;
}

/** Loss postmortem panel — top patterns + raw loser drill-down. */
export function renderLossPostmortemPanel(data: any): string {
  const lp = data.loss_postmortem;
  if (!lp || !Array.isArray(lp.rows) || lp.rows.length === 0) {
    return `
    <div class="card">
      <div class="card-title">Loss Postmortem</div>
      <p style="color:#94a3b8">No active strategies — toggle one on to populate.</p>
    </div>`;
  }

  const cardsHtml = lp.rows.map((r: any) => {
    const sidEsc = escHtml(r.strategy_id);
    if (r.population_n === 0) {
      return `
      <div data-strategy="${sidEsc}" style="background:#0f172a;border:1px solid #334155;border-radius:6px;padding:12px;margin-bottom:10px">
        <div><a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;font-weight:600;cursor:pointer;text-decoration:none">${sidEsc}</a> <span style="color:#64748b">— no closed trades yet</span></div>
      </div>`;
    }

    const patternRows = (r.dominant_patterns || []).map((p: any) => {
      const worst = p.buckets[p.worst_bucket];
      const direction = worst.deviation_pp > 0 ? 'cluster in' : 'avoid';
      const rangeStr = `[${worst.range[0]}, ${worst.range[1]}]`;
      const sign = worst.deviation_pp > 0 ? '+' : '';
      return `<tr>
        <td style="color:#94a3b8;font-family:monospace;font-size:11px">${escHtml(p.feature)}</td>
        <td>${worst.loser_count}/${r.loser_n} losers ${direction} bucket ${p.worst_bucket} (${rangeStr})</td>
        <td>${worst.overall_count}/${p.overall_n} overall</td>
        <td><span style="color:${worst.deviation_pp > 0 ? '#f87171' : '#22d3ee'};font-weight:600">${sign}${worst.deviation_pp}pp</span></td>
      </tr>`;
    }).join('');

    const dominantTable = patternRows
      ? `<table class="table" style="font-size:11px"><thead><tr><th>Feature</th><th>Loser bucket</th><th>Overall</th><th>Δpp</th></tr></thead><tbody>${patternRows}</tbody></table>`
      : `<p style="color:#64748b;font-size:11px;margin:0">No feature crosses the 20pp deviation threshold — losses look diffuse.</p>`;

    // Drill-down: top 10 worst trades with feature values (collapsible <details>).
    const featureCols = lp.rows[0]?.dominant_patterns?.[0]?.buckets ? Object.keys(r.losers[0]?.features ?? {}) : [];
    const loserHeader = featureCols.length > 0
      ? '<th>mint</th><th>net%</th><th>exit</th><th>held</th>' + featureCols.map(f => `<th title="${f}">${f.replace(/_/g, ' ').slice(0, 12)}</th>`).join('')
      : '<th>mint</th><th>net%</th><th>exit</th><th>held</th>';
    const loserRowsHtml = (r.losers || []).slice(0, 10).map((l: any) => {
      const cells = featureCols.map(f => {
        const v = l.features[f];
        return v == null ? '<td style="color:#64748b">-</td>' : `<td style="font-size:10px">${typeof v === 'number' ? +v.toFixed(2) : v}</td>`;
      }).join('');
      return `<tr>
        <td>${mintCell(l.mint, 6)}</td>
        <td style="color:#f87171">${l.net_return_pct?.toFixed(1)}%</td>
        <td style="color:#94a3b8;font-size:10px">${escHtml(l.exit_reason || '-')}</td>
        <td style="font-size:10px">${l.held_seconds ?? '-'}s</td>
        ${cells}
      </tr>`;
    }).join('');
    const loserTable = `
      <details style="margin-top:8px">
        <summary style="color:#64748b;font-size:11px;cursor:pointer">Raw losers (top 10 by net loss)</summary>
        <div style="overflow-x:auto;margin-top:6px">
          <table class="table" style="font-size:10px"><thead><tr>${loserHeader}</tr></thead><tbody>${loserRowsHtml}</tbody></table>
        </div>
      </details>`;

    return `
      <div data-strategy="${sidEsc}" style="background:#0f172a;border:1px solid #334155;border-radius:6px;padding:12px;margin-bottom:10px">
        <div style="margin-bottom:8px">
          <a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;font-weight:600;cursor:pointer;text-decoration:none">${sidEsc}</a>
          <span style="color:#94a3b8;font-size:12px;margin-left:6px">${escHtml(r.label)}</span>
          <span style="color:#64748b;font-size:11px;margin-left:8px">losers ${r.loser_n} of ${r.population_n} closed</span>
        </div>
        ${dominantTable}
        ${loserTable}
      </div>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Loss Postmortem
        <span style="color:#64748b;font-size:11px;font-weight:400">— worst 20 trades / strategy bucketed against the strategy's own population · features with |deviation| ≥ 20pp surface as dominant patterns</span>
      </div>
      ${cardsHtml}
    </div>`;
}

/** Strategy journal panel — hypothesis + auto-status + updates timeline. */
export function renderJournalPanel(data: any): string {
  const j = data.journal;
  if (!j || !Array.isArray(j.rows) || j.rows.length === 0) {
    return `
    <div class="card">
      <div class="card-title">Strategy Journal
        <span style="color:#64748b;font-size:11px;font-weight:400">— push entries via strategy-commands.json journal-upsert</span>
      </div>
      <p style="color:#94a3b8">No journal entries yet. Push a journal-upsert command in strategy-commands.json to record the hypothesis behind a strategy cohort.</p>
    </div>`;
  }

  const autoBadge = (status: string) => {
    const styles: Record<string, { bg: string; fg: string; border: string }> = {
      'OPEN':      { bg: '#33415533', fg: '#94a3b8', border: '#334155' },
      'ON-TRACK':  { bg: '#065f4633', fg: '#4ade80', border: '#065f46' },
      'DEGRADING': { bg: '#7f1d1d33', fg: '#f87171', border: '#7f1d1d' },
      'HIT-KILL':  { bg: '#7f1d1d',   fg: '#fff',    border: '#7f1d1d' },
      'NO-DATA':   { bg: '#33415533', fg: '#64748b', border: '#334155' },
      'PROMOTED':  { bg: '#1e3a8a33', fg: '#60a5fa', border: '#1e3a8a' },
      'KILLED':    { bg: '#1f2937',   fg: '#94a3b8', border: '#374151' },
      'PAUSED':    { bg: '#33415533', fg: '#fbbf24', border: '#334155' },
    };
    const s = styles[status] ?? styles['OPEN'];
    return `<span style="background:${s.bg};color:${s.fg};border:1px solid ${s.border};padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600">${status}</span>`;
  };

  const stateBadge = (state: string) => {
    if (state === 'enabled') return '';
    const color = state === 'disabled' ? '#94a3b8' : '#64748b';
    return `<span style="background:#33415533;color:${color};border:1px solid #334155;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px">[${state}]</span>`;
  };

  const cardsHtml = j.rows.map((e: any) => {
    const muted = e.strategy_state !== 'enabled';
    const cardBg = muted ? '#0f172a99' : '#0f172a';
    const cardOpacity = muted ? '0.75' : '1';

    const pred = e.prediction;
    const predLine = pred
      ? `<div style="color:#94a3b8;font-size:11px;margin-bottom:6px">
          Prediction:
          ${pred.target_median_net_pct != null ? `target median ${pred.target_median_net_pct > 0 ? '+' : ''}${pred.target_median_net_pct}%` : ''}
          ${pred.target_n != null ? `· n=${pred.target_n}` : ''}
          ${pred.target_days != null ? `· ${pred.target_days}d` : ''}
          ${pred.kill_criterion ? `· kill: <span style="color:#fbbf24">${escHtml(pred.kill_criterion)}</span>` : ''}
        </div>`
      : '';

    const live = e.live_stats;
    const liveLine = `<div style="color:#94a3b8;font-size:11px;margin-bottom:8px">
      Live: n=${live.n_closed} closed · median ${live.median_net_pct == null ? '-' : (live.median_net_pct > 0 ? '+' : '') + live.median_net_pct + '%'} · mean ${live.mean_net_pct == null ? '-' : (live.mean_net_pct > 0 ? '+' : '') + live.mean_net_pct + '%'} · wr ${live.win_rate_pct == null ? '-' : live.win_rate_pct + '%'}
    </div>`;

    const updatesHtml = (e.updates || []).length > 0
      ? `<details style="margin-top:6px"><summary style="color:#64748b;font-size:11px;cursor:pointer">${e.updates.length} update${e.updates.length === 1 ? '' : 's'}</summary>
          <div style="margin-top:6px;padding-left:12px;border-left:2px solid #334155">
            ${(e.updates as any[]).map(u => `
              <div style="margin-bottom:6px">
                <div style="color:#64748b;font-size:10px">${utcToCentral(new Date(u.at * 1000).toISOString())} CT</div>
                <div style="color:#e0e0e0;font-size:11px;white-space:pre-wrap">${escHtml(u.note)}</div>
              </div>`).join('')}
          </div>
        </details>`
      : '';

    const cohortChip = e.cohort_label
      ? `<span style="background:#1e3a8a33;color:#60a5fa;border:1px solid #1e3a8a;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px">${escHtml(e.cohort_label)}</span>`
      : '';

    const manualBadge = e.manual_status !== 'OPEN' && e.manual_status !== e.auto_status
      ? `<span style="color:#64748b;font-size:10px;margin-left:6px">manual: ${escHtml(e.manual_status)}</span>`
      : '';

    const sidEsc = escHtml(e.strategy_id);
    return `
      <div data-strategy="${sidEsc}" style="background:${cardBg};border:1px solid #334155;border-radius:6px;padding:12px;margin-bottom:10px;opacity:${cardOpacity}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div>
            <a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;font-weight:600;cursor:pointer;text-decoration:none">${sidEsc}</a>
            <span style="color:#94a3b8;font-size:12px;margin-left:6px">${escHtml(e.strategy_label)}</span>
            ${stateBadge(e.strategy_state)}${cohortChip}
          </div>
          <div>${autoBadge(e.auto_status)}${manualBadge}</div>
        </div>
        ${predLine}
        ${liveLine}
        <div style="color:#e0e0e0;font-size:12px;white-space:pre-wrap;background:#1e293b;border-radius:4px;padding:8px;border:1px solid #334155">${escHtml(e.hypothesis)}</div>
        ${updatesHtml}
        <div style="color:#64748b;font-size:10px;margin-top:6px">
          id <span style="font-family:monospace">${escHtml(e.id)}</span>
          · created ${utcToCentral(new Date(e.created_at * 1000).toISOString())} CT
        </div>
      </div>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Strategy Journal
        <span style="color:#64748b;font-size:11px;font-weight:400">— ${j.entry_count} entries · auto-status from live closed-trade stats · entries persist across strategy delete/disable</span>
      </div>
      ${cardsHtml}
    </div>`;
}

/** Recent Trades panel — last 50 trades, optionally filtered by
 *  data.selected_strategy / data.selected_execution_mode. Same SQL backs
 *  the initial server render and the /api/recent-trades?format=html refetch
 *  triggered when the user clicks a strategy filter. */
export function renderRecentTradesPanel(data: any): string {
  const selected = data.selected_strategy || '';
  const selectedExec = data.selected_execution_mode || '';
  const tradeRows = (data.recent_trades || []).map((t: any) => {
    const ret = t.net_return_pct;
    const retColor = ret == null ? '#94a3b8' : ret > 0 ? '#22d3ee' : '#f87171';
    const trueRet = t.true_net_return_pct;
    const trueRetColor = trueRet == null ? '#64748b' : trueRet > 0 ? '#22d3ee' : '#f87171';
    const reasonColor = (t.exit_reason === 'take_profit' || t.exit_reason === 'trailing_tp') ? '#22d3ee' : t.exit_reason === 'trailing_stop' ? '#fb923c' : t.exit_reason === 'breakeven_stop' ? '#fbbf24' : t.exit_reason === 'stop_loss' ? '#f87171' : '#94a3b8';
    const heldStr = t.held_seconds != null ? t.held_seconds + 's' : '-';
    const exec = execModeStyle(t.execution_mode || 'paper');
    const sid = t.strategy_id ?? 'default';
    const sidEsc = escHtml(sid);
    return `<tr data-strategy="${sidEsc}">
      <td data-label="ID">${t.id}</td>
      <td data-label="Strategy" style="font-size:11px"><a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;cursor:pointer;text-decoration:none">${sidEsc}</a></td>
      <td data-label="Mode"><span style="background:${exec.color}22;color:${exec.color};border:1px solid ${exec.color}55;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">${exec.label}</span></td>
      <td data-label="Status" style="color:${t.status === 'open' ? '#a78bfa' : t.status === 'failed' ? '#f87171' : '#94a3b8'}">${t.status}</td>
      <td data-label="Mint">${mintCell(t.mint)}</td>
      <td data-label="Entry%">${t.entry_pct_from_open != null ? '+' + t.entry_pct_from_open.toFixed(1) + '%' : '-'}</td>
      <td data-label="Exit Reason" style="color:${reasonColor}">${t.exit_reason ?? '-'}</td>
      <td data-label="Net Ret%" style="color:${retColor}">${ret != null ? ret.toFixed(2) + '%' : '-'}</td>
      <td data-label="True Net%" style="color:${trueRetColor}" title="Shadow-only: gross − measured entry slip − measured exit slip">${trueRet != null ? trueRet.toFixed(2) + '%' : '-'}</td>
      <td data-label="Held">${heldStr}</td>
      <td data-label="T+300" style="color:#94a3b8">${t.momentum_label ?? '-'} ${t.momentum_pct_t300 != null ? '(' + t.momentum_pct_t300.toFixed(1) + '%)' : ''}</td>
      <td data-label="Entry Time" style="font-size:11px;color:#64748b">${utcToCentral(t.entry_dt)} CT</td>
    </tr>`;
  }).join('');

  const tradesTitleSuffix = [
    selected ? selected : '',
    selectedExec ? execModeStyle(selectedExec).label : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="card">
      <div class="card-title">Recent Trades (last 50${selected ? ' for this strategy' : ''})${tradesTitleSuffix ? ` — ${tradesTitleSuffix}` : ''}</div>
      ${tradeRows ? `<div style="overflow-x:auto"><table class="table">
        <thead><tr><th>ID</th><th>Strategy</th><th>Mode</th><th>Status</th><th>Mint</th><th>Entry%</th>
          <th>Exit Reason</th><th>Net Ret%</th>
          <th title="Shadow-only — measured AMM slippage applied instead of gap penalty">True Net Ret%</th>
          <th>Held</th><th>T+300 Outcome</th><th>Entry Time</th></tr></thead>
        <tbody>${tradeRows}</tbody>
      </table></div>` : '<p style="color:#94a3b8">No trades yet</p>'}
    </div>`;
}

/** Recent Skips panel — Skip Reasons aggregate + Recent Skips table. The
 *  Skip Reasons aggregate is global (it's a count(*) by reason), so when a
 *  strategy filter is active the aggregate shows the "Filter doesn't apply"
 *  pill. Recent Skips table is filtered server-side via data.recent_skips. */
export function renderRecentSkipsPanel(data: any): string {
  const skipCountRows = (data.skip_reason_counts || []).map((s: any) =>
    `<tr><td>${s.skip_reason}</td><td>${s.count}</td></tr>`
  ).join('');

  const skipRows = (data.recent_skips || []).slice(0, 20).map((s: any) => {
    const sid = s.strategy_id ?? 'default';
    const sidEsc = escHtml(sid);
    return `<tr data-strategy="${sidEsc}">
      <td>${s.graduation_id}</td>
      <td>${mintCell(s.mint)}</td>
      <td style="font-size:11px"><a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;cursor:pointer;text-decoration:none">${sidEsc}</a></td>
      <td style="color:#f87171">${s.skip_reason}</td>
      <td>${s.skip_value != null ? s.skip_value.toFixed(2) : '-'}</td>
      <td>${s.pct_t30 != null ? s.pct_t30.toFixed(1) + '%' : '-'}</td>
      <td style="font-size:11px;color:#64748b">${utcToCentral(s.created_dt)} CT</td>
    </tr>`;
  }).join('');

  const selected = data.selected_strategy || '';
  return `
    <div class="skips-grid" style="display:grid;grid-template-columns:1fr 2fr;gap:16px">
      <div class="card" data-aggregate="true">
        <div class="aggregate-overlay">Filter doesn't apply — shows all strategies</div>
        <div class="card-title">Skip Reasons</div>
        ${skipCountRows ? `<table class="table">
          <thead><tr><th>Reason</th><th>Count</th></tr></thead>
          <tbody>${skipCountRows}</tbody>
        </table>` : '<p style="color:#94a3b8">No skips yet</p>'}
      </div>
      <div class="card">
        <div class="card-title">Recent Skips (last 20${selected ? ' for this strategy' : ''})</div>
        ${skipRows ? `<div style="overflow-x:auto"><table class="table">
          <thead><tr><th>GradID</th><th>Mint</th><th>Strategy</th><th>Reason</th><th>Value</th><th>pct_t30</th><th>Time</th></tr></thead>
          <tbody>${skipRows}</tbody>
        </table></div>` : '<p style="color:#94a3b8">No skips yet</p>'}
      </div>
    </div>`;
}

export function renderTradingHtml(data: any): string {
  const navHtml = nav('/trading');
  const strategies: any[] = data.strategies || [];
  const selected = data.selected_strategy || '';
  const selectedExec = data.selected_execution_mode || '';
  const modeColor = !data.trading_enabled ? '#94a3b8' : data.global_mode === 'live' ? '#f59e0b' : '#22d3ee';
  const modeLabel = !data.trading_enabled ? 'DISABLED' : (data.global_mode ?? 'paper').toUpperCase();

  // Color/short-label per execution_mode — used by the badges in Recent Trades
  // and the Performance by Execution Mode card. Distinct from the global
  // `mode` (paper/live) which only has two values.
  // (execModeStyle is hoisted to module scope so the extracted Recent
  // Trades / Recent Skips renders can use it from /api endpoints too.)

  // ── Strategy tabs ─────────────────────────────────────────────────────────
  const tabStyle = (active: boolean) => active
    ? 'background:#2563eb;color:#fff;pointer-events:none'
    : 'background:#334155;color:#94a3b8';
  const tabsHtml = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center">
      <a href="/trading${selectedExec ? '?execution_mode=' + selectedExec : ''}" style="padding:6px 14px;border-radius:4px;font-size:12px;text-decoration:none;${tabStyle(!selected)}">All</a>
      ${strategies.map((s: any) => {
        const tabExec = execModeStyle((s.params?.executionMode) || 'paper');
        return `
        <a href="/trading?strategy=${s.id}${selectedExec ? '&execution_mode=' + selectedExec : ''}" style="padding:6px 14px;border-radius:4px;font-size:12px;text-decoration:none;${tabStyle(selected === s.id)};display:inline-flex;align-items:center;gap:6px">
          <span style="background:${tabExec.color}22;color:${tabExec.color};border:1px solid ${tabExec.color}55;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:600;letter-spacing:0.4px">${tabExec.label}</span>
          ${escHtml(s.label)}${!s.enabled ? ' (off)' : ''}
          <span style="font-size:10px;color:#64748b">${s.activePositions}pos</span>
        </a>
      `;
      }).join('')}
      <button onclick="document.getElementById('new-strategy-form').style.display='block'" style="padding:6px 14px;border-radius:4px;font-size:12px;background:#065f46;color:#fff;border:none;cursor:pointer">+ New Strategy</button>
    </div>`;

  // Execution-mode filter pills. Compose with the strategy filter — clicking
  // a mode pill keeps the current strategy in the URL, and vice versa. Default
  // = "All" so the historical paper-trade view is unchanged unless explicitly
  // narrowed.
  const stratQs = selected ? `strategy=${selected}` : '';
  const buildExecHref = (mode: string) => {
    const parts = [stratQs, mode ? `execution_mode=${mode}` : ''].filter(Boolean);
    return `/trading${parts.length ? '?' + parts.join('&') : ''}`;
  };
  const execPill = (mode: string, label: string, color: string) => {
    const active = selectedExec === mode;
    const bg = active ? color : '#1e293b';
    const fg = active ? '#0f172a' : color;
    const cursor = active ? 'pointer-events:none;' : '';
    return `<a href="${buildExecHref(mode)}" style="padding:4px 12px;border-radius:4px;font-size:11px;text-decoration:none;background:${bg};color:${fg};border:1px solid ${color};font-weight:600;${cursor}">${label}</a>`;
  };
  const execTabsHtml = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
      <span style="color:#64748b;font-size:11px;margin-right:4px">Mode:</span>
      <a href="${buildExecHref('')}" style="padding:4px 12px;border-radius:4px;font-size:11px;text-decoration:none;${selectedExec === '' ? 'background:#2563eb;color:#fff;pointer-events:none' : 'background:#334155;color:#94a3b8'}">All</a>
      ${execPill('paper', 'PAPER', '#64748b')}
      ${execPill('shadow', 'SHADOW', '#a78bfa')}
      ${execPill('live_micro', 'LIVE μ', '#f59e0b')}
      ${execPill('live_full', 'LIVE', '#ef4444')}
    </div>`;

  // ── Shared select style ────────────────────────────────────────────────────
  const selStyle = 'display:block;width:100%;box-sizing:border-box;background:#0f172a;color:#e2e8f0;border:1px solid #334155;padding:4px 8px;border-radius:4px;margin-top:2px;font-size:12px;cursor:pointer';
  const inpStyle = 'display:block;width:100%;box-sizing:border-box;background:#0f172a;color:#e0e0e0;border:1px solid #334155;padding:4px 8px;border-radius:4px;margin-top:2px';

  // ── New strategy form (hidden by default) ─────────────────────────────────
  const newFormHtml = `
    <div id="new-strategy-form" class="card" style="display:none;border:1px solid #065f46">
      <div class="card-title">Create New Strategy</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <label style="color:#94a3b8;font-size:11px">ID (slug)<input id="new-id" type="text" placeholder="e.g. aggressive" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Label<input id="new-label" type="text" placeholder="e.g. Aggressive TP" style="${inpStyle}"></label>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
        <label style="color:#94a3b8;font-size:11px">TP %<select id="new-tp" style="${selStyle}">${numSelectOptions(TP_OPTIONS, 30)}</select></label>
        <label style="color:#94a3b8;font-size:11px">SL %<select id="new-sl" style="${selStyle}">${numSelectOptions(SL_OPTIONS, 10)}</select></label>
        <label style="color:#94a3b8;font-size:11px">Trade Size SOL<input id="new-size" type="number" value="0.5" step="0.1" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Max Concurrent<input id="new-maxpos" type="number" value="1" step="1" style="${inpStyle}"></label>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
        <label style="color:#94a3b8;font-size:11px">Entry Gate Min %<input id="new-gate-min" type="number" value="5" step="1" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Entry Gate Max %<input id="new-gate-max" type="number" value="100" step="1" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Max Hold (s)<input id="new-hold" type="number" value="300" step="30" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">SL Gap Penalty %<input id="new-sl-gap" type="number" value="20" step="1" style="${inpStyle}"></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <label style="color:#94a3b8;font-size:11px">TP Gap Penalty %<input id="new-tp-gap" type="number" value="10" step="1" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Position Monitor Mode<select id="new-monitor-mode" style="${selStyle}">
          <option value="five_second">5s intervals (from entry)</option>
          <option value="match_collection">Match collection schedule</option>
        </select></label>
        <label style="color:#94a3b8;font-size:11px">Execution Mode<select id="new-execution-mode" style="${selStyle}">
          <option value="paper">PAPER — sim fill, gap-penalty cost model</option>
          <option value="shadow">SHADOW — read on-chain pool, measured cost</option>
        </select>
        <span style="color:#64748b;font-size:10px;display:block;margin-top:2px">Live modes only via env or strategy-commands.json</span></label>
      </div>
      <div style="margin-bottom:12px;border-top:1px solid #334155;padding-top:10px">
        <div style="color:#94a3b8;font-size:11px;font-weight:bold;margin-bottom:8px">Dynamic Position Monitoring <span style="color:#64748b;font-weight:normal">(0 = disabled)</span></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px">
          <label style="color:#94a3b8;font-size:11px">Trailing SL Activation %<input id="new-trailing-sl-act" type="number" value="0" step="1" min="0" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">Trailing SL Distance %<input id="new-trailing-sl-dist" type="number" value="5" step="1" min="1" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">SL Delay (s)<input id="new-sl-delay" type="number" value="0" step="5" min="0" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">Breakeven Stop %<input id="new-breakeven-stop" type="number" value="0" step="1" min="0" style="${inpStyle}"></label>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px">
          <label style="color:#94a3b8;font-size:11px">Trailing TP<select id="new-trailing-tp" style="${selStyle}"><option value="false" selected>Off</option><option value="true">On</option></select></label>
          <label style="color:#94a3b8;font-size:11px">Trailing TP Drop %<input id="new-trailing-tp-drop" type="number" value="5" step="1" min="1" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">SL Tighten @ Time %<input id="new-tighten-sl-time" type="number" value="0" step="5" min="0" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">SL Tighten to %<input id="new-tighten-sl-pct" type="number" value="7" step="0.5" min="0.5" style="${inpStyle}"></label>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
          <label style="color:#94a3b8;font-size:11px">SL Tighten Stage 2 @ %<input id="new-tighten-sl-time2" type="number" value="0" step="5" min="0" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">SL Tighten Stage 2 to %<input id="new-tighten-sl-pct2" type="number" value="5" step="0.5" min="0.5" style="${inpStyle}"></label>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="color:#94a3b8;font-size:11px;margin-bottom:6px">Filters (AND logic)</div>
        <div id="new-filter-slots">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
            <select id="new-filter-1" style="${selStyle};flex:1">${filterSelectOptions('vel 5-20 sol/min')}</select>
            <button onclick="removeFilterSlot('new',1)" style="background:#7f1d1d;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px" title="Remove">x</button>
          </div>
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
            <select id="new-filter-2" style="${selStyle};flex:1">${filterSelectOptions('')}</select>
            <button onclick="removeFilterSlot('new',2)" style="background:#7f1d1d;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px" title="Remove">x</button>
          </div>
        </div>
        <button onclick="addFilterSlot('new')" style="background:#334155;color:#94a3b8;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;margin-top:2px">+ Add Filter</button>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button onclick="createStrategy()" style="background:#2563eb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px">Create</button>
        <button onclick="document.getElementById('new-strategy-form').style.display='none'" style="background:#334155;color:#94a3b8;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px">Cancel</button>
        <span id="new-error" style="color:#f87171;font-size:12px;line-height:30px"></span>
      </div>
    </div>`;

  // ── Strategy config editor (shown when a specific strategy is selected) ───
  const selectedStrategy = strategies.find((s: any) => s.id === selected);
  let editorHtml = '';
  if (selectedStrategy) {
    const p = selectedStrategy.params;
    const edPresets = splitFiltersToPresets(p.filters || []);
    const edFilterSlots = edPresets.map((name: string, i: number) => `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
        <select id="ed-filter-${i + 1}" style="${selStyle};flex:1">${filterSelectOptions(name)}</select>
        <button onclick="removeFilterSlot('ed',${i + 1})" style="background:#7f1d1d;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px" title="Remove">x</button>
      </div>`).join('');

    const edExec = execModeStyle(p.executionMode || 'paper');
    const edExecCurrent = p.executionMode || 'paper';
    const isLiveMode = edExecCurrent === 'live_micro' || edExecCurrent === 'live_full';
    editorHtml = `
    <div class="card" style="border:1px solid #334155">
      <div class="card-title">Strategy: ${escHtml(selectedStrategy.label)}
        <span style="background:${edExec.color}22;color:${edExec.color};border:1px solid ${edExec.color}55;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;margin-left:8px;letter-spacing:0.5px">${edExec.label}</span>
        <span style="color:${selectedStrategy.enabled ? '#4ade80' : '#f87171'};font-size:12px;margin-left:8px">${selectedStrategy.enabled ? 'ENABLED' : 'DISABLED'}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
        <label style="color:#94a3b8;font-size:11px">TP %<select id="ed-tp" style="${selStyle}">${numSelectOptions(TP_OPTIONS, p.takeProfitPct)}</select></label>
        <label style="color:#94a3b8;font-size:11px">SL %<select id="ed-sl" style="${selStyle}">${numSelectOptions(SL_OPTIONS, p.stopLossPct)}</select></label>
        <label style="color:#94a3b8;font-size:11px">Trade Size SOL<input id="ed-size" type="number" value="${p.tradeSizeSol}" step="0.1" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Max Concurrent<input id="ed-maxpos" type="number" value="${p.maxConcurrentPositions}" step="1" style="${inpStyle}"></label>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
        <label style="color:#94a3b8;font-size:11px">Entry Gate Min %<input id="ed-gate-min" type="number" value="${p.entryGateMinPctT30}" step="1" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Entry Gate Max %<input id="ed-gate-max" type="number" value="${p.entryGateMaxPctT30}" step="1" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Max Hold (s)<input id="ed-hold" type="number" value="${p.maxHoldSeconds}" step="30" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">SL Gap Penalty %<input id="ed-sl-gap" type="number" value="${p.slGapPenaltyPct}" step="1" style="${inpStyle}"></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <label style="color:#94a3b8;font-size:11px">TP Gap Penalty %<input id="ed-tp-gap" type="number" value="${p.tpGapPenaltyPct}" step="1" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Label<input id="ed-label" type="text" value="${escHtml(selectedStrategy.label)}" style="${inpStyle}"></label>
        <label style="color:#94a3b8;font-size:11px">Position Monitor Mode<select id="ed-monitor-mode" style="${selStyle}">
          <option value="five_second" ${(p.positionMonitorMode ?? 'five_second') === 'five_second' ? 'selected' : ''}>5s intervals (from entry)</option>
          <option value="match_collection" ${p.positionMonitorMode === 'match_collection' ? 'selected' : ''}>Match collection schedule</option>
        </select>
        <span style="color:#64748b;font-size:10px;display:block;margin-top:2px">Restart required to apply</span></label>
        <label style="color:#94a3b8;font-size:11px">Execution Mode<select id="ed-execution-mode" style="${selStyle}" ${isLiveMode ? 'disabled' : ''}>
          <option value="paper" ${edExecCurrent === 'paper' ? 'selected' : ''}>PAPER — sim fill, gap-penalty cost</option>
          <option value="shadow" ${edExecCurrent === 'shadow' ? 'selected' : ''}>SHADOW — measured cost</option>
          ${isLiveMode ? `<option value="${edExecCurrent}" selected>${edExec.label} (read-only)</option>` : ''}
        </select>
        <span style="color:#64748b;font-size:10px;display:block;margin-top:2px">${isLiveMode ? 'Live mode locked — change via strategy-commands.json' : 'Toggle paper ↔ shadow takes effect on next trade'}</span></label>
      </div>
      <div style="margin-bottom:12px;border-top:1px solid #334155;padding-top:10px">
        <div style="color:#94a3b8;font-size:11px;font-weight:bold;margin-bottom:8px">Dynamic Position Monitoring <span style="color:#64748b;font-weight:normal">(0 = disabled)</span></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px">
          <label style="color:#94a3b8;font-size:11px">Trailing SL Activation %<input id="ed-trailing-sl-act" type="number" value="${p.trailingSlActivationPct ?? 0}" step="1" min="0" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">Trailing SL Distance %<input id="ed-trailing-sl-dist" type="number" value="${p.trailingSlDistancePct ?? 5}" step="1" min="1" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">SL Delay (s)<input id="ed-sl-delay" type="number" value="${p.slActivationDelaySec ?? 0}" step="5" min="0" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">Breakeven Stop %<input id="ed-breakeven-stop" type="number" value="${p.breakevenStopPct ?? 0}" step="1" min="0" style="${inpStyle}"></label>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px">
          <label style="color:#94a3b8;font-size:11px">Trailing TP<select id="ed-trailing-tp" style="${selStyle}"><option value="false" ${!(p.trailingTpEnabled) ? 'selected' : ''}>Off</option><option value="true" ${p.trailingTpEnabled ? 'selected' : ''}>On</option></select></label>
          <label style="color:#94a3b8;font-size:11px">Trailing TP Drop %<input id="ed-trailing-tp-drop" type="number" value="${p.trailingTpDropPct ?? 5}" step="1" min="1" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">SL Tighten @ Time %<input id="ed-tighten-sl-time" type="number" value="${p.tightenSlAtPctTime ?? 0}" step="5" min="0" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">SL Tighten to %<input id="ed-tighten-sl-pct" type="number" value="${p.tightenSlTargetPct ?? 7}" step="0.5" min="0.5" style="${inpStyle}"></label>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
          <label style="color:#94a3b8;font-size:11px">SL Tighten Stage 2 @ %<input id="ed-tighten-sl-time2" type="number" value="${p.tightenSlAtPctTime2 ?? 0}" step="5" min="0" style="${inpStyle}"></label>
          <label style="color:#94a3b8;font-size:11px">SL Tighten Stage 2 to %<input id="ed-tighten-sl-pct2" type="number" value="${p.tightenSlTargetPct2 ?? 5}" step="0.5" min="0.5" style="${inpStyle}"></label>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="color:#94a3b8;font-size:11px;margin-bottom:6px">Filters (AND logic)</div>
        <div id="ed-filter-slots">${edFilterSlots}</div>
        <button onclick="addFilterSlot('ed')" style="background:#334155;color:#94a3b8;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;margin-top:2px">+ Add Filter</button>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button onclick="saveStrategy('${selectedStrategy.id}')" style="background:#2563eb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px">Save Changes</button>
        <button onclick="toggleStrategy('${selectedStrategy.id}',${!selectedStrategy.enabled})" style="background:${selectedStrategy.enabled ? '#7f1d1d' : '#065f46'};color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px">${selectedStrategy.enabled ? 'Disable' : 'Enable'}</button>
        ${selectedStrategy.id !== 'default' ? `<button onclick="if(confirm('Delete strategy ${selectedStrategy.id}?'))deleteStrategy('${selectedStrategy.id}')" style="background:#7f1d1d;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px">Delete</button>` : ''}
        <span id="ed-status" style="color:#4ade80;font-size:12px"></span>
      </div>
    </div>`;
  }

  // ── Open positions ────────────────────────────────────────────────────────
  // Server-side strategy filter is retained for JSON consumers (Accept: application/json)
  // but the HTML shell renders all rows; client-side filter hides non-matches in real time.
  const openPositionsAll = data.open_positions || [];
  const posRows = (openPositionsAll as any[]).map((p: any) => {
    const effSlDiffers = p.effectiveSlPriceSol != null && p.slPriceSol != null && Math.abs(p.effectiveSlPriceSol - p.slPriceSol) > 1e-12;
    const sid = p.strategyId ?? 'default';
    const sidEsc = escHtml(sid);
    return `
    <tr data-strategy="${sidEsc}">
      <td>${p.tradeId}</td>
      <td style="font-size:11px"><a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;cursor:pointer;text-decoration:none">${sidEsc}</a></td>
      <td>${mintCell(p.mint)}</td>
      <td>${p.entryPriceSol?.toFixed(8) ?? '-'}</td>
      <td style="color:#22d3ee">${p.tpPriceSol?.toFixed(8) ?? '-'}</td>
      <td style="color:#f87171">${p.slPriceSol?.toFixed(8) ?? '-'}</td>
      <td style="color:${effSlDiffers ? '#fbbf24' : '#f87171'}">${p.effectiveSlPriceSol?.toFixed(8) ?? p.slPriceSol?.toFixed(8) ?? '-'}${effSlDiffers ? ' *' : ''}</td>
      <td style="color:#a78bfa">${p.highWaterMark?.toFixed(8) ?? '-'}</td>
      <td>${p.secondsHeld}s / ${p.maxHoldSeconds}s</td>
    </tr>`;
  }).join('');

  const openHtml = `
    <div class="card">
      <div class="card-title">Open Positions (<span class="row-count" data-row-count-for="open-positions">${openPositionsAll.length}</span>)</div>
      ${posRows ? `<table class="table" data-row-scope="open-positions">
        <thead><tr><th>ID</th><th>Strategy</th><th>Mint</th><th>Entry</th><th>TP</th><th>Fixed SL</th><th>Eff. SL</th><th>HWM</th><th>Held</th></tr></thead>
        <tbody>${posRows}</tbody>
      </table>` : '<p style="color:#94a3b8">No open positions</p>'}
    </div>`;

  // ── Per-strategy performance summary ──────────────────────────────────────
  const strategyStatsData = data.strategy_stats || [];
  const stratStatRows = strategyStatsData.map((s: any) => {
    const ret = s.avg_net_return_pct;
    const retColor = ret == null ? '#94a3b8' : ret > 0 ? '#22d3ee' : '#f87171';
    const firstDt = s.first_trade_ts ? utcToCentral(new Date(s.first_trade_ts * 1000).toISOString()) : '-';
    // Use execution_mode (paper/shadow/live_micro/live_full) for the badge —
    // the legacy `mode` column only distinguishes paper vs live and would
    // mislabel shadow trades as PAPER.
    const exec = execModeStyle(s.execution_mode || 'paper');
    const sid = s.strategy_id ?? 'default';
    const sidEsc = escHtml(sid);
    return `<tr data-strategy="${sidEsc}">
      <td data-label="Strategy"><a class="filter-link" data-filter-strategy="${sidEsc}" style="color:#a78bfa;cursor:pointer;text-decoration:none">${sidEsc}</a></td>
      <td data-label="Mode"><span style="background:${exec.color}22;color:${exec.color};border:1px solid ${exec.color}55;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600">${exec.label}</span></td>
      <td data-label="Total">${s.total}</td><td data-label="Closed">${s.closed}</td><td data-label="Open">${s.open_count}</td>
      <td data-label="Avg Net Ret%" style="color:${retColor}" data-sort="${ret ?? -999}">${ret != null ? ret + '%' : '-'}</td>
      <td data-label="TP" style="color:#22d3ee">${s.tp_exits}</td>
      <td data-label="SL" style="color:#f87171">${s.sl_exits}</td>
      <td data-label="Timeout" style="color:#94a3b8">${s.timeout_exits}</td>
      <td data-label="Net P&L" data-sort="${s.total_net_profit_sol ?? -999}">${s.total_net_profit_sol != null ? s.total_net_profit_sol + ' SOL' : '-'}</td>
      <td data-label="First Trade" style="font-size:11px;color:#64748b" data-sort="${s.first_trade_ts ?? 0}">${firstDt}</td>
    </tr>`;
  }).join('');

  const perfHtml = `
    <div class="card">
      <div class="card-title">Performance by Strategy</div>
      ${stratStatRows ? `<div style="overflow-x:auto"><table class="table sortable" id="perf-table">
        <thead><tr>
          <th data-col="0">Strategy</th><th data-col="1">Mode</th><th data-col="2">Total</th>
          <th data-col="3">Closed</th><th data-col="4">Open</th>
          <th data-col="5">Avg Net Ret%</th><th data-col="6">TP</th><th data-col="7">SL</th>
          <th data-col="8">Timeout</th><th data-col="9">Net P&L</th><th data-col="10">First Trade</th>
        </tr></thead>
        <tbody>${stratStatRows}</tbody>
      </table></div>` : '<p style="color:#94a3b8">No trades yet</p>'}
    </div>`;

  // ── Performance by Execution Mode ────────────────────────────────────────
  // Mirrors Performance by Strategy but bucketed by paper / shadow / live_*.
  // Surfaces measured slippage (only meaningful for shadow/live) so we can
  // compare against paper's static gap-penalty assumption during rollout.
  const execModeData = data.performance_by_execution_mode || [];
  const execModeRows = execModeData.map((m: any) => {
    const ret = m.avg_net_return_pct;
    const retColor = ret == null ? '#94a3b8' : ret > 0 ? '#22d3ee' : '#f87171';
    const trueRet = m.avg_true_net_return_pct;
    const trueRetColor = trueRet == null ? '#94a3b8' : trueRet > 0 ? '#22d3ee' : '#f87171';
    const trueRetLabel = trueRet == null
      ? '-'
      : `${trueRet}% <span style="color:#64748b;font-size:10px">(n=${m.true_net_n ?? 0})</span>`;
    const exec = execModeStyle(m.execution_mode);
    const fmt = (v: any, suffix = '') => v == null ? '-' : v + suffix;
    return `<tr>
      <td><span style="background:${exec.color}22;color:${exec.color};border:1px solid ${exec.color}55;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600">${exec.label}</span></td>
      <td>${m.total}</td><td>${m.closed}</td><td>${m.open_count}</td><td>${m.failed}</td>
      <td style="color:${retColor}" data-sort="${ret ?? -999}">${ret != null ? ret + '%' : '-'}</td>
      <td style="color:${trueRetColor}" data-sort="${trueRet ?? -999}">${trueRetLabel}</td>
      <td style="color:#94a3b8" data-sort="${m.avg_shadow_entry_slip_pct ?? -999}">${fmt(m.avg_shadow_entry_slip_pct, '%')}</td>
      <td style="color:#94a3b8" data-sort="${m.avg_shadow_exit_slip_pct ?? -999}">${fmt(m.avg_shadow_exit_slip_pct, '%')}</td>
      <td style="color:#94a3b8" data-sort="${m.avg_tx_land_ms ?? -999}">${fmt(m.avg_tx_land_ms, 'ms')}</td>
      <td style="color:#94a3b8" data-sort="${m.total_jito_tip_sol ?? 0}">${fmt(m.total_jito_tip_sol, ' SOL')}</td>
      <td data-sort="${m.total_net_profit_sol ?? -999}">${m.total_net_profit_sol != null ? m.total_net_profit_sol + ' SOL' : '-'}</td>
    </tr>`;
  }).join('');

  const execModeHtml = `
    <div class="card" data-aggregate="true">
      <div class="aggregate-overlay">Filter doesn't apply — shows all strategies</div>
      <div class="card-title">Performance by Execution Mode</div>
      ${execModeRows ? `<div style="overflow-x:auto"><table class="table sortable" id="exec-mode-table">
        <thead><tr>
          <th data-col="0">Mode</th><th data-col="1">Total</th>
          <th data-col="2">Closed</th><th data-col="3">Open</th><th data-col="4">Failed</th>
          <th data-col="5">Avg Net Ret%</th>
          <th data-col="6" title="Shadow only: gross_return - shadow_entry_slip - shadow_exit_slip. What the net return would be using measured AMM slippage instead of the modeled gap penalty.">True Net Ret%</th>
          <th data-col="7">Shadow Entry Slip%</th><th data-col="8">Shadow Exit Slip%</th>
          <th data-col="9">Avg Land ms</th><th data-col="10">Jito Tips</th>
          <th data-col="11">Net P&L</th>
        </tr></thead>
        <tbody>${execModeRows}</tbody>
      </table></div>
      <p style="color:#64748b;font-size:11px;margin-top:6px">
        <b>Avg Net Ret%</b> uses the static gap-penalty model (same for paper and shadow, so they're sim-comparable).
        <b>True Net Ret%</b> is shadow-only — recomputes net return from the actual measured AMM slippage on each fill
        (gross − shadow_entry_slip − shadow_exit_slip), no extra round-trip cost. The gap between the two columns is
        the modeling overcharge: positive means our paper sim is more pessimistic than reality.
        Slippage / land-time / Jito columns are only populated for shadow and live modes.
      </p>` : '<p style="color:#94a3b8">No trades yet</p>'}
    </div>`;

  // ── Shadow Slippage Range ────────────────────────────────────────────────
  // Distribution of measured AMM slippage on closed shadow trades — gives a
  // direct read on how wide the real fill range is vs the modeled 1-3% gap
  // assumption. If max here is small (single-digit %), the gap-penalty model
  // is overcharging us; if max is large the model may be lenient.
  const ssr = data.shadow_slippage_range;
  const ssrFmtRow = (label: string, stats: any, suffix = '%') => {
    if (!stats) {
      return `<tr><td>${label}</td><td colspan="7" style="color:#64748b">no shadow trades yet</td></tr>`;
    }
    const f = (v: number) => `${v.toFixed(3)}${suffix}`;
    const colorFor = (v: number) => label.includes('True Net') ? (v > 0 ? '#22d3ee' : '#f87171') : '#e5e7eb';
    return `<tr>
      <td style="color:#94a3b8">${label}</td>
      <td>${stats.n}</td>
      <td style="color:${colorFor(stats.min)}">${f(stats.min)}</td>
      <td style="color:${colorFor(stats.p10)}">${f(stats.p10)}</td>
      <td style="color:${colorFor(stats.p50)}">${f(stats.p50)}</td>
      <td style="color:${colorFor(stats.p90)}">${f(stats.p90)}</td>
      <td style="color:${colorFor(stats.max)}">${f(stats.max)}</td>
      <td style="color:${colorFor(stats.mean)}">${f(stats.mean)}</td>
    </tr>`;
  };
  const ssrHtml = ssr ? `
    <div class="card" data-aggregate="true">
      <div class="aggregate-overlay">Filter doesn't apply — shows all strategies</div>
      <div class="card-title">Shadow Slippage Range
        <span style="color:#64748b;font-size:11px;font-weight:400">— measured AMM slippage on closed shadow trades (n=${ssr.n_trades})</span>
      </div>
      ${ssr.n_trades > 0 ? `<div style="overflow-x:auto"><table class="table">
        <thead><tr>
          <th>Metric</th><th>n</th><th>Min</th><th>P10</th><th>Median</th><th>P90</th><th>Max</th><th>Mean</th>
        </tr></thead>
        <tbody>
          ${ssrFmtRow('Entry slippage', ssr.entry_slippage_pct, '%')}
          ${ssrFmtRow('Exit slippage', ssr.exit_slippage_pct, '%')}
          ${ssrFmtRow('Round-trip (entry + exit)', ssr.round_trip_slippage_pct, '%')}
          ${ssrFmtRow('Sim overhead (jito tip + tx fee)', ssr.sim_overhead_pct, '%')}
          ${ssrFmtRow('True Net Ret (gross − round-trip − overhead)', ssr.true_net_return_pct, '%')}
        </tbody>
      </table></div>
      <p style="color:#64748b;font-size:11px;margin-top:6px">
        <b>Shadow's net_return_pct now uses this measured-cost model</b> — gap penalty and roundTripCostPct
        are no longer applied. The True Net Ret row recomputes the same formula on-the-fly as a sanity check
        and should match Avg Net Ret% in the panel above. Sim overhead is 2 × jito tip + 2 × tx fee
        (~0.04% on a 0.5 SOL trade at default tip 0.0001 SOL).
      </p>` : '<p style="color:#94a3b8">No closed shadow trades with measured slippage yet.</p>'}
    </div>` : '';

  // ── Recent Trades + Recent Skips ─────────────────────────────────────────
  // Wrapped in identifiable sections so the click-to-filter JS can refetch
  // strategy-specific slices via /api/recent-trades?format=html&strategy=<id>
  // and /api/recent-skips?format=html&strategy=<id>. Without refetch, a
  // low-volume strategy's trades may not appear in the global last-50.
  const tradesHtml = `<section data-section="recent-trades">${renderRecentTradesPanel(data)}</section>`;
  const skipsHtml = `<section data-section="recent-skips">${renderRecentSkipsPanel(data)}</section>`;

  // ── Build client-side FILTER_PRESETS map ────────────────────────────────────
  const filterPresetsMap: Record<string, any[]> = {};
  for (const g of FILTER_PRESET_GROUPS) {
    for (const f of g.filters) {
      filterPresetsMap[f.name] = f.configs;
    }
  }

  // ── Top-20 filter combo presets card ──────────────────────────────────────
  const topPairs: any[] = data.top_pairs || [];
  let presetsHtml = '';
  if (topPairs.length > 0) {
    const pairRows = topPairs.map((p: any, i: number) => {
      const retCls = p.opt_avg_ret > 0 ? 'ev-pos' : 'ev-neg';
      const escA = (p.filter_a || '').replace(/'/g, "\\'");
      const escB = (p.filter_b || '').replace(/'/g, "\\'");
      return `<tr>
        <td>${i + 1}</td>
        <td style="font-size:11px">${p.filter_a}</td>
        <td style="font-size:11px">${p.filter_b}</td>
        <td>${p.n}</td>
        <td>${p.opt_tp}%</td><td>${p.opt_sl}%</td>
        <td class="${retCls}">${p.opt_avg_ret > 0 ? '+' : ''}${p.opt_avg_ret}%</td>
        <td>${p.opt_win_rate}%</td>
        <td><button onclick="usePreset('${escA}','${escB}',${p.opt_tp},${p.opt_sl})" style="background:#065f46;color:#fff;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px">Use</button></td>
      </tr>`;
    }).join('');
    presetsHtml = `
    <div class="card" data-aggregate="true" style="border:1px solid #1e3a5f">
      <div class="aggregate-overlay">Filter doesn't apply — shows all strategies</div>
      <div class="card-title">Top Filter Combos <span style="color:#64748b;font-size:11px;font-weight:400">(from Filter V2 — visit <a href="/filter-analysis-v2" style="color:#60a5fa">Filters V2</a> to refresh)</span></div>
      <div style="overflow-x:auto"><table class="table">
        <thead><tr><th>#</th><th>Filter A</th><th>Filter B</th><th>n</th><th>TP%</th><th>SL%</th><th>Avg Ret%</th><th>Win%</th><th></th></tr></thead>
        <tbody>${pairRows}</tbody>
      </table></div>
    </div>`;
  } else {
    presetsHtml = `
    <div class="card" data-aggregate="true" style="border:1px solid #334155">
      <div class="aggregate-overlay">Filter doesn't apply — shows all strategies</div>
      <div class="card-title" style="color:#64748b">Top Filter Combos</div>
      <p style="color:#64748b;font-size:12px">No cached data yet. Visit <a href="/filter-analysis-v2" style="color:#60a5fa">Filters V2</a> first to compute the top combos.</p>
    </div>`;
  }

  // ── JavaScript for strategy management ────────────────────────────────────
  const filterOptionsHtml = filterSelectOptions('');
  const js = `
  <script>
    const FILTER_PRESETS = ${JSON.stringify(filterPresetsMap)};
    const FILTER_OPTIONS_HTML = ${JSON.stringify(filterOptionsHtml)};

    function gv(id) { return document.getElementById(id).value; }
    function gn(id) { return parseFloat(gv(id)); }

    /** Collect all filter configs from select dropdowns with given prefix */
    function getFilters(prefix) {
      const container = document.getElementById(prefix + '-filter-slots');
      if (!container) return [];
      const selects = container.querySelectorAll('select');
      const configs = [];
      for (const sel of selects) {
        const name = sel.value;
        if (name && FILTER_PRESETS[name]) {
          configs.push(...FILTER_PRESETS[name]);
        }
      }
      return configs;
    }

    /** Count current filter slots */
    function countFilterSlots(prefix) {
      const container = document.getElementById(prefix + '-filter-slots');
      return container ? container.querySelectorAll('select').length : 0;
    }

    /** Add a new filter dropdown slot */
    function addFilterSlot(prefix) {
      const container = document.getElementById(prefix + '-filter-slots');
      if (!container) return;
      const idx = countFilterSlots(prefix) + 1;
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px';
      div.innerHTML = '<select id="' + prefix + '-filter-' + idx + '" style="${selStyle};flex:1">' + FILTER_OPTIONS_HTML + '</select>'
        + '<button onclick="removeFilterSlot(\\'' + prefix + '\\',' + idx + ')" style="background:#7f1d1d;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px" title="Remove">x</button>';
      container.appendChild(div);
    }

    /** Remove a filter slot and re-index remaining ones */
    function removeFilterSlot(prefix, idx) {
      const container = document.getElementById(prefix + '-filter-slots');
      if (!container) return;
      const slots = container.children;
      if (slots.length <= 1) return; // keep at least 1
      for (let i = 0; i < slots.length; i++) {
        const sel = slots[i].querySelector('select');
        if (sel && sel.id === prefix + '-filter-' + idx) {
          container.removeChild(slots[i]);
          break;
        }
      }
      // Re-index remaining
      const remaining = container.querySelectorAll('select');
      remaining.forEach(function(sel, i) { sel.id = prefix + '-filter-' + (i + 1); });
    }

    /** Use a top-20 preset — fills the new strategy form */
    function usePreset(filterA, filterB, tp, sl) {
      const form = document.getElementById('new-strategy-form');
      form.style.display = 'block';
      // Set filters
      const sel1 = document.getElementById('new-filter-1');
      const sel2 = document.getElementById('new-filter-2');
      if (sel1) sel1.value = filterA;
      if (sel2) sel2.value = filterB;
      // Set TP/SL
      const tpSel = document.getElementById('new-tp');
      const slSel = document.getElementById('new-sl');
      if (tpSel) tpSel.value = String(tp);
      if (slSel) slSel.value = String(sl);
      // Auto-generate ID and label
      var shortA = filterA.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
      var shortB = filterB.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
      var idEl = document.getElementById('new-id');
      var labelEl = document.getElementById('new-label');
      if (idEl && !idEl.value) idEl.value = shortA + '-' + shortB;
      if (labelEl && !labelEl.value) labelEl.value = filterA + ' + ' + filterB;
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function createStrategy() {
      const errEl = document.getElementById('new-error');
      errEl.textContent = '';
      try {
        const filters = getFilters('new');
        const body = {
          id: gv('new-id').trim().toLowerCase().replace(/[^a-z0-9-]/g, ''),
          label: gv('new-label').trim(),
          params: {
            tradeSizeSol: gn('new-size'), maxConcurrentPositions: parseInt(gv('new-maxpos')),
            entryGateMinPctT30: gn('new-gate-min'), entryGateMaxPctT30: gn('new-gate-max'),
            takeProfitPct: gn('new-tp'), stopLossPct: gn('new-sl'),
            maxHoldSeconds: parseInt(gv('new-hold')),
            slGapPenaltyPct: gn('new-sl-gap'), tpGapPenaltyPct: gn('new-tp-gap'),
            filters: filters,
            positionMonitorMode: gv('new-monitor-mode'),
            trailingSlActivationPct: gn('new-trailing-sl-act'),
            trailingSlDistancePct: gn('new-trailing-sl-dist'),
            slActivationDelaySec: parseInt(gv('new-sl-delay')),
            breakevenStopPct: gn('new-breakeven-stop'),
            trailingTpEnabled: gv('new-trailing-tp') === 'true',
            trailingTpDropPct: gn('new-trailing-tp-drop'),
            tightenSlAtPctTime: gn('new-tighten-sl-time'),
            tightenSlTargetPct: gn('new-tighten-sl-pct'),
            tightenSlAtPctTime2: gn('new-tighten-sl-time2'),
            tightenSlTargetPct2: gn('new-tighten-sl-pct2'),
            executionMode: gv('new-execution-mode')
          }
        };
        if (!body.id) { errEl.textContent = 'ID is required'; return; }
        if (!body.label) { errEl.textContent = 'Label is required'; return; }
        const res = await fetch('/api/strategies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || 'Failed'; return; }
        location.href = '/trading?strategy=' + body.id;
      } catch (e) { errEl.textContent = e.message; }
    }

    async function saveStrategy(id) {
      const statusEl = document.getElementById('ed-status');
      statusEl.textContent = 'Saving...';
      statusEl.style.color = '#94a3b8';
      try {
        const filters = getFilters('ed');
        const body = {
          label: gv('ed-label').trim(),
          params: {
            tradeSizeSol: gn('ed-size'), maxConcurrentPositions: parseInt(gv('ed-maxpos')),
            entryGateMinPctT30: gn('ed-gate-min'), entryGateMaxPctT30: gn('ed-gate-max'),
            takeProfitPct: gn('ed-tp'), stopLossPct: gn('ed-sl'),
            maxHoldSeconds: parseInt(gv('ed-hold')),
            slGapPenaltyPct: gn('ed-sl-gap'), tpGapPenaltyPct: gn('ed-tp-gap'),
            filters: filters,
            positionMonitorMode: gv('ed-monitor-mode'),
            trailingSlActivationPct: gn('ed-trailing-sl-act'),
            trailingSlDistancePct: gn('ed-trailing-sl-dist'),
            slActivationDelaySec: parseInt(gv('ed-sl-delay')),
            breakevenStopPct: gn('ed-breakeven-stop'),
            trailingTpEnabled: gv('ed-trailing-tp') === 'true',
            trailingTpDropPct: gn('ed-trailing-tp-drop'),
            tightenSlAtPctTime: gn('ed-tighten-sl-time'),
            tightenSlTargetPct: gn('ed-tighten-sl-pct'),
            tightenSlAtPctTime2: gn('ed-tighten-sl-time2'),
            tightenSlTargetPct2: gn('ed-tighten-sl-pct2'),
            executionMode: gv('ed-execution-mode')
          }
        };
        const res = await fetch('/api/strategies/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) { statusEl.textContent = data.error || 'Failed'; statusEl.style.color = '#f87171'; return; }
        statusEl.textContent = 'Saved!';
        statusEl.style.color = '#4ade80';
      } catch (e) { statusEl.textContent = e.message; statusEl.style.color = '#f87171'; }
    }

    async function toggleStrategy(id, enabled) {
      await fetch('/api/strategies/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      location.reload();
    }

    async function deleteStrategy(id) {
      const res = await fetch('/api/strategies/' + id, { method: 'DELETE' });
      if (res.ok) location.href = '/trading';
      else { const d = await res.json(); alert(d.error || 'Failed'); }
    }

    // ── Lazy-loader for heavy panels ─────────────────────────────────────────
    // Each placeholder section carries data-lazy-panel + data-endpoint. We fetch
    // the HTML fragment, swap in, then re-apply any active strategy filter and
    // attach sortable handlers. Failure → error state with retry button.
    function loadLazyPanel(section) {
      const endpoint = section.getAttribute('data-endpoint');
      if (!endpoint) return;
      section.setAttribute('data-state', 'loading');
      fetch(endpoint, { headers: { 'Accept': 'text/html' } })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (html) {
          section.innerHTML = html;
          section.setAttribute('data-state', 'ok');
          // Re-apply current filter to newly injected rows.
          applyStrategyFilter(document.body.dataset.activeStrategy || '');
          // Attach sort behaviour to any newly injected sortable tables.
          section.querySelectorAll('table.sortable').forEach(initSortable);
        })
        .catch(function (err) {
          section.setAttribute('data-state', 'error');
          section.innerHTML = '<div class="card"><div class="card-title">' + (section.getAttribute('data-label') || 'Panel') + '</div>' +
            '<p style="color:#f87171;font-size:12px">Failed to load: ' + (err && err.message ? err.message : 'unknown error') + '</p>' +
            '<button onclick="loadLazyPanel(this.closest(\\'[data-lazy-panel]\\'))" style="background:#2563eb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px">Retry</button></div>';
        });
    }

    function loadAllLazyPanels() {
      document.querySelectorAll('[data-lazy-panel]').forEach(loadLazyPanel);
    }

    // ── Sortable table init (extracted from per-table IIFEs) ─────────────────
    function initSortable(table) {
      if (!table || table.__sortableInit) return;
      table.__sortableInit = true;
      const headers = table.querySelectorAll('th[data-col]');
      let sortCol = -1, sortAsc = true;
      headers.forEach(function (th) {
        th.style.cursor = 'pointer';
        th.style.userSelect = 'none';
        th.addEventListener('click', function () {
          const col = parseInt(th.getAttribute('data-col'));
          if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
          headers.forEach(function (h) { h.textContent = h.textContent.replace(/ [▲▼]$/, ''); });
          th.textContent += sortAsc ? ' ▲' : ' ▼';
          const tbody = table.querySelector('tbody');
          const rows = Array.from(tbody.querySelectorAll('tr'));
          rows.sort(function (a, b) {
            const aCell = a.children[col]; const bCell = b.children[col];
            const aSort = aCell.getAttribute('data-sort');
            const bSort = bCell.getAttribute('data-sort');
            let aVal, bVal;
            if (aSort !== null && bSort !== null) {
              aVal = parseFloat(aSort); bVal = parseFloat(bSort);
            } else {
              aVal = (aCell.textContent || '').trim(); bVal = (bCell.textContent || '').trim();
              const aNum = parseFloat(aVal); const bNum = parseFloat(bVal);
              if (!isNaN(aNum) && !isNaN(bNum)) { aVal = aNum; bVal = bNum; }
            }
            if (aVal < bVal) return sortAsc ? -1 : 1;
            if (aVal > bVal) return sortAsc ? 1 : -1;
            return 0;
          });
          rows.forEach(function (r) { tbody.appendChild(r); });
        });
      });
    }

    // ── Click-to-filter strategy ─────────────────────────────────────────────
    // Click any [data-filter-strategy] element to filter the page to that strategy.
    // Click again (same id) to clear. State persists in the ?strategy= query param
    // via history.replaceState (no reload, no hash collisions).
    function applyStrategyFilter(activeId) {
      const body = document.body;
      if (activeId) {
        body.dataset.activeStrategy = activeId;
      } else {
        delete body.dataset.activeStrategy;
      }
      // Show/hide each [data-strategy] element.
      document.querySelectorAll('[data-strategy]').forEach(function (el) {
        const sid = el.getAttribute('data-strategy');
        if (!activeId || sid === activeId) {
          el.classList.remove('is-hidden-by-filter');
        } else {
          el.classList.add('is-hidden-by-filter');
        }
      });
      // Update visible row counts on tables that opt in via data-row-scope.
      document.querySelectorAll('[data-row-count-for]').forEach(function (el) {
        const scope = el.getAttribute('data-row-count-for');
        const tbl = document.querySelector('[data-row-scope="' + scope + '"]');
        if (!tbl) return;
        const rows = tbl.querySelectorAll('tbody > tr[data-strategy]');
        let visible = 0;
        rows.forEach(function (r) { if (!r.classList.contains('is-hidden-by-filter')) visible++; });
        el.textContent = String(visible);
      });
      // Toggle the sticky filter pill.
      const pill = document.getElementById('filter-pill');
      if (pill) {
        if (activeId) {
          pill.removeAttribute('hidden');
          const labelEl = pill.querySelector('.filter-pill-label');
          if (labelEl) labelEl.textContent = activeId;
        } else {
          pill.setAttribute('hidden', '');
        }
      }
    }

    function setStrategyFilter(activeId) {
      applyStrategyFilter(activeId);
      // Persist via query param. Preserve any other params (e.g. execution_mode).
      const url = new URL(window.location.href);
      if (activeId) url.searchParams.set('strategy', activeId);
      else url.searchParams.delete('strategy');
      window.history.replaceState({}, '', url.toString());
      // Refetch recent trades + skips for the new filter so low-volume
      // strategies surface their actual last 50 (not a 0-row slice of the
      // global last 50). On clear, refetch without strategy → restores
      // system-wide last 50.
      refreshTradesAndSkips(activeId);
    }

    // ── Strategy-aware refresh of Recent Trades + Recent Skips ───────────────
    let refreshSeq = 0;
    function refreshTradesAndSkips(activeId) {
      const seq = ++refreshSeq;
      const params = new URLSearchParams(window.location.search);
      const execMode = params.get('execution_mode') || '';
      const qs = function (extra) {
        const p = new URLSearchParams();
        p.set('format', 'html');
        if (activeId) p.set('strategy', activeId);
        if (execMode) p.set('execution_mode', execMode);
        return '?' + p.toString();
      };
      const swap = function (sectionAttr, endpoint) {
        const section = document.querySelector('[data-section="' + sectionAttr + '"]');
        if (!section) return;
        section.style.opacity = '0.6';
        fetch(endpoint, { headers: { 'Accept': 'text/html' } })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then(function (html) {
            // Discard stale responses if the user clicked again.
            if (seq !== refreshSeq) return;
            section.innerHTML = html;
            section.style.opacity = '1';
            applyStrategyFilter(document.body.dataset.activeStrategy || '');
          })
          .catch(function () { section.style.opacity = '1'; });
      };
      swap('recent-trades', '/api/recent-trades' + qs());
      swap('recent-skips', '/api/recent-skips' + qs());
    }

    // Delegated click handlers — one listener for filter, one for clipboard.
    document.addEventListener('click', function (e) {
      const t = e.target;
      // Mint copy button — must run before the filter handler since the
      // copy button can sit inside an interactive cell.
      const copyBtn = t && (t.closest ? t.closest('.mint-copy') : null);
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const mint = copyBtn.getAttribute('data-mint') || '';
        if (!mint) return;
        const reset = function () { copyBtn.classList.remove('copied'); copyBtn.textContent = '⎘'; };
        const ok = function () {
          copyBtn.classList.add('copied');
          copyBtn.textContent = '✓';
          setTimeout(reset, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(mint).then(ok).catch(function () { /* ignore */ });
        } else {
          // Fallback for older browsers / insecure contexts.
          const ta = document.createElement('textarea');
          ta.value = mint; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); ok(); } catch (_) { /* ignore */ }
          document.body.removeChild(ta);
        }
        return;
      }
      const link = t && (t.closest ? t.closest('[data-filter-strategy]') : null);
      if (!link) return;
      // Don't hijack the Birdeye link — only the strategy-filter triggers.
      if (t && t.tagName === 'A' && t.getAttribute('href')) return;
      e.preventDefault();
      const id = link.getAttribute('data-filter-strategy');
      const current = document.body.dataset.activeStrategy || '';
      setStrategyFilter(current === id ? '' : id);
    });

    // ── Top-3 sticky comparison strip ────────────────────────────────────────
    // After /api/strategy-percentiles + /api/edge-decay land, render a 1-line
    // strip showing top-3 strategies by median net % with their decay flag.
    function populateTop3Strip() {
      const strip = document.getElementById('top3-strip');
      if (!strip) return;
      Promise.all([
        fetch('/api/strategy-percentiles').then(function (r) { return r.json(); }),
        fetch('/api/edge-decay').then(function (r) { return r.json(); }),
      ]).then(function (results) {
        const sp = results[0];
        const ed = results[1];
        if (!sp || !Array.isArray(sp.rows) || sp.rows.length === 0) return;
        const decayBy = {};
        if (ed && Array.isArray(ed.rows)) {
          ed.rows.forEach(function (r) { decayBy[r.strategy_id] = r.flag; });
        }
        // Sort by net.median desc, take top 3.
        const ranked = sp.rows.slice().filter(function (r) {
          return r.net_return_pct && r.net_return_pct.median != null && r.n_closed >= 5;
        }).sort(function (a, b) { return b.net_return_pct.median - a.net_return_pct.median; }).slice(0, 3);
        if (ranked.length === 0) return;
        const flagColors = { 'DECAYING': '#7f1d1d', 'STRENGTHENING': '#065f46', 'STABLE': '#334155', 'LOW-N': '#334155' };
        const flagFg     = { 'DECAYING': '#f87171', 'STRENGTHENING': '#4ade80', 'STABLE': '#94a3b8', 'LOW-N': '#64748b' };
        const items = ranked.map(function (r) {
          const med = r.net_return_pct.median;
          const medColor = med > 0 ? '#22d3ee' : '#f87171';
          const flag = decayBy[r.strategy_id] || 'STABLE';
          const bg = flagColors[flag] || '#334155';
          const fg = flagFg[flag] || '#94a3b8';
          const sid = String(r.strategy_id).replace(/"/g, '&quot;');
          return '<div class="top3-item" data-filter-strategy="' + sid + '">' +
            '<span class="top3-strat">' + sid + '</span>' +
            '<span class="top3-med" style="color:' + medColor + '">' + (med > 0 ? '+' : '') + med + '%</span>' +
            '<span style="color:#64748b;font-size:10px">n=' + r.n_closed + '</span>' +
            '<span class="top3-flag" style="background:' + bg + '33;color:' + fg + ';border:1px solid ' + bg + '">' + flag + '</span>' +
            '</div>';
        }).join('<span style="color:#334155">·</span>');
        strip.innerHTML = items;
        strip.removeAttribute('hidden');
      }).catch(function () { /* fail silently — strip stays hidden */ });
    }

    // Auto-hide top3 strip on scroll-down, reveal on scroll-up.
    let lastScrollY = 0;
    function handleStripScroll() {
      const strip = document.getElementById('top3-strip');
      if (!strip || strip.hasAttribute('hidden')) return;
      const y = window.scrollY;
      if (y > lastScrollY && y > 60) {
        strip.classList.add('is-hidden');
      } else {
        strip.classList.remove('is-hidden');
      }
      lastScrollY = y;
    }
    window.addEventListener('scroll', handleStripScroll, { passive: true });

    // Bootstrap: read ?strategy= from URL on load, fetch lazy panels, init sortables.
    (function () {
      const params = new URLSearchParams(window.location.search);
      const initial = params.get('strategy') || '';
      if (initial) applyStrategyFilter(initial);
      // Existing server-rendered sortable tables.
      document.querySelectorAll('table.sortable').forEach(initSortable);
      loadAllLazyPanels();
      populateTop3Strip();
    })();
  </script>`;

  // Convert generated_at to Central time
  const generatedCT = new Date(data.generated_at).toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: true, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // Heavy panels are now lazy-loaded — each placeholder fetches its own
  // /api/<panel>?format=html fragment after the cheap shell renders. See the
  // loadLazyPanel() function in the inline JS for the implementation.
  // Wrapped in <details open> so users can collapse panels they don't need —
  // particularly useful on mobile where vertical real estate is precious.
  // The fragment ships its own .card wrapper — the lazy-panel <section> is
  // intentionally not .card to avoid a double background / nested padding.
  const lazyPanel = (id: string, endpoint: string, label: string) => `
    <details class="panel-collapsible" open>
      <summary>${label}</summary>
      <div class="panel-body">
        <section class="lazy-panel" data-lazy-panel="${id}" data-endpoint="${endpoint}" data-label="${label}" data-state="loading">
          <div class="skeleton-rows" aria-busy="true">
            <div class="skeleton-row"></div>
            <div class="skeleton-row" style="width:88%"></div>
            <div class="skeleton-row" style="width:72%"></div>
          </div>
        </section>
      </div>
    </details>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trading Dashboard</title>
<style>${STYLES}
  .card{background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px}
  .card-title{font-size:14px;font-weight:600;color:#94a3b8;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em}
  .table{width:100%;border-collapse:collapse;font-size:12px}
  .table th{text-align:left;padding:6px 8px;color:#64748b;border-bottom:1px solid #334155;font-weight:500}
  .table td{padding:5px 8px;border-bottom:1px solid #1e293b;vertical-align:top}
  .table tr:hover td{background:#1e3a5f22}
  /* Click-to-filter strategy */
  .filter-link{cursor:pointer;text-decoration:none;border-bottom:1px dashed transparent;transition:border-color .15s}
  .filter-link:hover{border-bottom-color:#a78bfa}
  body[data-active-strategy] .filter-link[data-filter-strategy]{font-weight:600}
  .is-hidden-by-filter{display:none !important}
  /* Aggregate panels (those that don't recompute per strategy): dim and show
     a banner above the title when a filter is active. Banner sits in normal
     flow so it never overlaps the panel title (mobile or desktop). */
  .aggregate-overlay{display:none;background:#7f1d1d33;color:#fca5a5;border:1px solid #7f1d1d;padding:3px 10px;border-radius:3px;font-size:10px;font-weight:600;margin-bottom:10px;width:fit-content}
  body[data-active-strategy] .card[data-aggregate]{opacity:.55}
  body[data-active-strategy] .card[data-aggregate] .aggregate-overlay{display:block}
  /* Sticky filter pill — visible only when a strategy filter is active */
  .filter-pill{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:8px;background:#1e3a8a;color:#dbeafe;border:1px solid #2563eb;border-radius:0 0 6px 6px;padding:6px 12px;margin:0 0 12px;font-size:12px;font-weight:600}
  .filter-pill button{background:#1d4ed8;color:#fff;border:none;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;font-weight:600}
  .filter-pill button:hover{background:#1e40af}
  .filter-pill[hidden]{display:none}
  /* Lazy-panel skeletons — only the loading state shows skeleton chrome.
     Once loaded, the fragment's own .card wrapper provides all visual chrome
     (no double background/padding/border). */
  .lazy-panel[data-state="loading"]{display:block;padding:8px 4px}
  .lazy-panel[data-state="loading"] .skeleton-rows{display:block}
  .lazy-panel[data-state="loading"] .skeleton-row{height:18px;background:linear-gradient(90deg,#1e293b 0%,#334155 50%,#1e293b 100%);background-size:200% 100%;border-radius:3px;margin:8px 0;animation:skeleton-shimmer 1.4s ease-in-out infinite}
  @keyframes skeleton-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  /* Sticky top-3 strategy comparison strip */
  .top3-strip{position:sticky;top:0;z-index:8;background:#0f172a;border-bottom:1px solid #334155;padding:6px 12px;margin:0 -16px 12px;display:flex;gap:12px;flex-wrap:wrap;font-size:12px;transition:transform .25s ease}
  .top3-strip.is-hidden{transform:translateY(-100%)}
  .top3-strip[hidden]{display:none}
  .top3-item{display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 8px;border-radius:4px;transition:background .15s}
  .top3-item:hover{background:#1e293b}
  .top3-strat{color:#a78bfa;font-family:monospace;font-weight:600}
  .top3-med{font-weight:600}
  .top3-flag{font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600}
  /* Mint quick-actions */
  .mint-cell{display:inline-flex;align-items:center;gap:4px;font-family:monospace;font-size:11px}
  .mint-cell a{color:#cbd5e1;text-decoration:none;border-bottom:1px dashed transparent;transition:border-color .15s}
  .mint-cell a:hover{border-bottom-color:#60a5fa;color:#fff}
  .mint-copy{background:transparent;border:none;color:#64748b;cursor:pointer;padding:1px 4px;font-size:11px;border-radius:3px}
  .mint-copy:hover{background:#334155;color:#dbeafe}
  .mint-copy.copied{color:#4ade80}
  /* Mobile (≤640px) */
  @media (max-width: 640px) {
    .container{padding:8px}
    .card{padding:10px;margin-bottom:10px;border-radius:6px}
    .card-title{font-size:12px;margin-bottom:8px}
    h1{font-size:15px !important}
    .table{font-size:11px}
    .table th, .table td{padding:4px 6px}
    .skips-grid{grid-template-columns:1fr !important}
    /* Stacked-card tables: opt-in via .responsive */
    .table.responsive thead{display:none}
    .table.responsive, .table.responsive tbody, .table.responsive tr{display:block;width:100%}
    .table.responsive tr{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px;margin-bottom:8px}
    .table.responsive tr[data-strategy]:hover td{background:transparent}
    .table.responsive td{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border:none;font-size:11px;gap:8px}
    .table.responsive td::before{content:attr(data-label);color:#64748b;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0}
    .table.responsive td:empty, .table.responsive td:first-child{font-weight:600}
    /* Filter pill more compact */
    .filter-pill{padding:5px 10px;font-size:11px;margin-bottom:8px}
    .top3-strip{padding:4px 8px;gap:6px;font-size:11px;margin:0 -8px 8px}
    .top3-item{padding:1px 4px}
    /* Collapse padding inside <details> on mobile */
    details summary{padding:8px 10px}
  }
  /* Collapsible panel chrome (<details> wrapping a .card or .lazy-panel).
     The summary acts as the panel header — duplicate inner .card-title is
     hidden so the description span (sibling) keeps showing without the
     redundant title text in front of it. */
  details.panel-collapsible{margin-bottom:12px;background:#1e293b;border-radius:8px;overflow:hidden}
  details.panel-collapsible > summary{cursor:pointer;list-style:none;padding:12px 16px;font-size:14px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between;align-items:center}
  details.panel-collapsible > summary::-webkit-details-marker{display:none}
  details.panel-collapsible > summary::after{content:'▼';font-size:11px;color:#64748b;transition:transform .15s;margin-left:8px}
  details.panel-collapsible[open] > summary::after{transform:rotate(180deg)}
  details.panel-collapsible[open] > summary{border-bottom:1px solid #334155}
  details.panel-collapsible > .panel-body{padding:0 16px 16px}
  details.panel-collapsible > .panel-body > .lazy-panel > .card,
  details.panel-collapsible > .panel-body > .card{margin-bottom:0;background:transparent;padding:12px 0 0;border-radius:0}
  /* Hide the inner card-title — but only the leading text node, not the
     description span. We use font-size:0 on the title and restore it on the
     child <span>, leaving the description visible without the redundant
     "PANEL NAME — " prefix. */
  details.panel-collapsible .card > .card-title{font-size:0;text-transform:none;letter-spacing:0;margin-bottom:8px;color:#64748b}
  details.panel-collapsible .card > .card-title > span{font-size:11px;font-weight:400;color:#64748b;text-transform:none;letter-spacing:0}
</style></head><body>
<nav><span class="title">Graduation Arb Research</span>${navHtml}</nav>
<div class="container">
  <div class="top3-strip" id="top3-strip" hidden></div>
  <div class="filter-pill" id="filter-pill" hidden>
    <span>Filtered:</span>
    <span class="filter-pill-label" style="font-family:monospace"></span>
    <button onclick="setStrategyFilter('')">✕ Clear</button>
  </div>
  <h1 style="font-size:18px;color:#60a5fa;margin:0 0 4px">Trading Dashboard
    <span style="font-size:13px;color:${modeColor};margin-left:8px">${modeLabel}</span>
    <span style="font-size:12px;color:#64748b;margin-left:8px">${strategies.length} strateg${strategies.length === 1 ? 'y' : 'ies'}</span>
    <button onclick="location.reload()" style="margin-left:12px;background:#334155;color:#94a3b8;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:11px">Refresh</button>
  </h1>
  <p style="color:#64748b;font-size:11px;margin:0 0 16px">Manual refresh · Generated ${generatedCT} CT</p>
  ${tabsHtml}
  ${execTabsHtml}
  ${presetsHtml}
  ${newFormHtml}
  ${editorHtml}
  ${openHtml}
  ${perfHtml}
  ${execModeHtml}
  ${ssrHtml}
  ${lazyPanel('strategy-percentiles', '/api/strategy-percentiles?format=html', 'Per-Strategy Distribution')}
  ${lazyPanel('edge-decay', '/api/edge-decay?format=html', 'Edge-Decay Tracker')}
  ${lazyPanel('counterfactual', '/api/counterfactual?format=html', 'Counterfactual — Filter + TP/SL')}
  ${lazyPanel('loss-postmortem', '/api/loss-postmortem?format=html', 'Loss Postmortem')}
  ${lazyPanel('journal', '/api/journal?format=html', 'Strategy Journal')}
  ${tradesHtml}
  ${skipsHtml}
</div>
${js}
</body></html>`;
}

// ── PEAK ANALYSIS PAGE ───────────────────────────────────────────────
// Diagnostic-only surface for max_relret_0_300. The metric is look-ahead
// (only known at T+300), so peak-filters are intentionally absent from the
// filter leaderboards. This page exposes the data for TP calibration,
// exit-timing calibration, and filter-quality scoring.

export function renderPeakAnalysisHtml(data: any): string {
  const d = data;

  const headerCards = `
    <div class="grid">
      <div class="card">
        <h2>Sample size</h2>
        <div class="stat"><span class="label">Total (entry-gated)</span><span class="value">${d.n_total}</span></div>
        <div class="stat"><span class="label">Baseline (vel&lt;20 + top5&lt;10%)</span><span class="value">${d.n_baseline}</span></div>
      </div>
      <div class="card">
        <h2>Recommended TP</h2>
        ${d.recommended_tp
          ? `<div class="stat"><span class="label">TP %</span><span class="value blue">${d.recommended_tp.tp_pct}%</span></div>
             <div class="stat"><span class="label">Expected return / trade</span><span class="value ${d.recommended_tp.expected_return_pct >= 0 ? 'green' : 'red'}">${d.recommended_tp.expected_return_pct >= 0 ? '+' : ''}${d.recommended_tp.expected_return_pct}%</span></div>
             <div class="desc">Model: if peak ≥ TP, exit at TP × 0.9 (gap); else exit at T+300. Cost from per-token round_trip_slippage_pct.</div>`
          : '<div class="n-insuf">No baseline rows yet.</div>'}
      </div>
      <div class="card" style="grid-column:1 / -1;background:#2a1810;border-color:#7c2d12">
        <h2 class="red">⚠ Look-ahead disclaimer</h2>
        <div class="desc">${d.disclaimer}</div>
      </div>
    </div>
  `;

  // Panel A: CDF
  const cdfRows = d.cdf.map((r: any) => `
    <tr>
      <td>≥ +${r.threshold_pct}%</td>
      <td>${r.all_reach_pct.toFixed(1)}%</td>
      <td>${r.baseline_reach_pct.toFixed(1)}%</td>
      <td class="${r.baseline_reach_pct - r.all_reach_pct > 0 ? 'green' : r.baseline_reach_pct - r.all_reach_pct < 0 ? 'red' : ''}">
        ${(r.baseline_reach_pct - r.all_reach_pct > 0 ? '+' : '') + (r.baseline_reach_pct - r.all_reach_pct).toFixed(1)}pp
      </td>
    </tr>`).join('');
  const panelA = `
    <div class="card">
      <h2>Panel A — Peak CDF</h2>
      <div class="desc">What fraction of tokens' peak-from-entry crosses each threshold. Baseline vs ALL cohort.
        If baseline has a higher reach rate at +30% than at +50%, drop TP to where hit-rate × TP peaks (see Panel D).</div>
      <table>
        <thead><tr><th>Peak threshold</th><th>ALL reach %</th><th>Baseline reach %</th><th>Baseline vs ALL</th></tr></thead>
        <tbody>${cdfRows}</tbody>
      </table>
    </div>
  `;

  // Panel B: peak-time histogram
  const histRows = d.peak_time_histogram.map((r: any) => `
    <tr>
      <td>${r.bin}</td>
      <td>${r.all_count}</td>
      <td>${r.all_pct.toFixed(1)}%</td>
      <td>${r.baseline_count}</td>
      <td>${r.baseline_pct.toFixed(1)}%</td>
    </tr>`).join('');
  const panelB = `
    <div class="card">
      <h2>Panel B — Peak time histogram</h2>
      <div class="desc">When does the peak occur? If most peaks cluster at 60-120s, maxHoldSeconds=180 is wasting the tail.
        If peaks are late (240-300s), the 300s observation window may be cutting winners off.</div>
      <table>
        <thead><tr><th>Peak time bin</th><th>ALL n</th><th>ALL %</th><th>Baseline n</th><th>Baseline %</th></tr></thead>
        <tbody>${histRows}</tbody>
      </table>
    </div>
  `;

  // Panel C: per-filter peak-bucket table
  const thresholds = (d.cdf as any[]).map(c => c.threshold_pct);
  const thresholdHeaders = thresholds.map(t => `<th>≥+${t}%</th>`).join('');
  let lastGroup = '';
  const perFilterRows = d.per_filter.map((r: any) => {
    const groupHeader = r.group !== lastGroup
      ? `<tr class="row-group-header"><td colspan="${6 + thresholds.length}">${r.group}</td></tr>`
      : '';
    lastGroup = r.group;
    const reachCells = thresholds.map(t => {
      const v = r.pct_reach[String(t)];
      return `<td>${v == null ? '—' : v.toFixed(1) + '%'}</td>`;
    }).join('');
    const nClass = r.n < 30 ? 'row-low-n' : r.n >= 100 ? 'row-strong-n' : '';
    return groupHeader + `
      <tr class="${nClass}">
        <td><strong>${r.filter}</strong></td>
        <td>${r.n}</td>
        <td>${r.p25_peak == null ? '—' : r.p25_peak.toFixed(1) + '%'}</td>
        <td>${r.median_peak == null ? '—' : r.median_peak.toFixed(1) + '%'}</td>
        <td>${r.p75_peak == null ? '—' : r.p75_peak.toFixed(1) + '%'}</td>
        <td class="${r.avg_final_return != null && r.avg_final_return > 0 ? 'green' : r.avg_final_return != null && r.avg_final_return < 0 ? 'red' : ''}">
          ${r.avg_final_return == null ? '—' : (r.avg_final_return > 0 ? '+' : '') + r.avg_final_return.toFixed(2) + '%'}
        </td>
        ${reachCells}
      </tr>`;
  }).join('');
  const panelC = `
    <div class="card">
      <h2>Panel C — Per-filter peak bucket</h2>
      <div class="desc">For each early-only filter, the peak distribution of its matching rows. Use this as a quality
        score: a filter whose rows have higher median_peak and higher reach% at +30-50% is producing tokens that actually move.
        avg_final_return = avg pct_t300-from-entry (the tradable outcome, no TP/SL applied).</div>
      <table>
        <thead><tr>
          <th>Filter</th><th>n</th><th>p25 peak</th><th>median peak</th><th>p75 peak</th><th>avg final ret</th>
          ${thresholdHeaders}
        </tr></thead>
        <tbody>${perFilterRows}</tbody>
      </table>
    </div>
  `;

  // Panel D: suggested TP
  const tpRows = d.suggested_tp.map((r: any) => {
    const isRecommended = d.recommended_tp && r.tp_pct === d.recommended_tp.tp_pct;
    return `
      <tr class="${isRecommended ? 'row-baseline' : ''}">
        <td>${r.tp_pct}%${isRecommended ? ' ★' : ''}</td>
        <td>${r.hit_rate_pct.toFixed(1)}%</td>
        <td class="${r.avg_nonhit_return_pct > 0 ? 'green' : r.avg_nonhit_return_pct < 0 ? 'red' : ''}">
          ${(r.avg_nonhit_return_pct > 0 ? '+' : '') + r.avg_nonhit_return_pct.toFixed(2)}%
        </td>
        <td class="${r.expected_return_pct > 0 ? 'green' : 'red'}"><strong>
          ${(r.expected_return_pct > 0 ? '+' : '') + r.expected_return_pct.toFixed(2)}%
        </strong></td>
      </tr>`;
  }).join('');
  const panelD = `
    <div class="card">
      <h2>Panel D — Suggested TP (baseline cohort)</h2>
      <div class="desc">For each TP level, the expected per-trade return if we swapped today's 50% TP for it, keeping
        the baseline filter (vel&lt;20 + top5&lt;10%). Model: hit_rate × (TP × 0.9) + (1 − hit_rate) × avg_nonhit_T300 − avg_cost.
        Ignores SL — treat the EV peak as a directional signal, not an absolute prediction. ★ = argmax.</div>
      <table>
        <thead><tr><th>TP %</th><th>Hit rate</th><th>Avg non-hit return</th><th>Expected return / trade</th></tr></thead>
        <tbody>${tpRows}</tbody>
      </table>
    </div>
  `;

  const body = headerCards + panelA + panelB + panelC + panelD;
  return shell('Peak Analysis', '/peak-analysis', body, d);
}

// ── EXIT-SIM PAGE ────────────────────────────────────────────────────

export function renderExitSimHtml(data: any): string {
  const d = data;

  const fmtPct = (v: number | null | undefined): string => {
    if (v === null || v === undefined) return '<span class="yellow">—</span>';
    const cls = v > 0 ? 'green' : v < 0 ? 'red' : '';
    const sign = v > 0 ? '+' : '';
    return `<span class="${cls}">${sign}${v.toFixed(2)}%</span>`;
  };

  const fmtWr = (v: number | null | undefined): string => {
    if (v === null || v === undefined) return '<span class="yellow">—</span>';
    const cls = v >= 60 ? 'green' : v >= 50 ? 'yellow' : 'red';
    return `<span class="${cls}">${v.toFixed(1)}%</span>`;
  };

  const exitBreakdown = (bd: any): string => {
    if (!bd) return '';
    const parts: string[] = [];
    for (const k of Object.keys(bd)) if (bd[k] > 0) parts.push(`${k}:${bd[k]}`);
    return parts.join(' · ');
  };

  // Baseline + universe header
  const bs = d.baseline_static;
  const matrixBanner = `
    <div class="card" style="border-left:3px solid #2563eb">
      <div class="desc">
        <strong>Single-universe view.</strong> This page evaluates all 5 dynamic-exit strategies
        only on <code>${d.universe.label}</code>. To see which of the top 20 filter combos gains
        the most from dynamic exits, jump to <a href="/exit-sim-matrix" style="color:#60a5fa"><strong>/exit-sim-matrix</strong></a>.
      </div>
    </div>
  `;
  const headerCards = `
    <div class="grid">
      <div class="card">
        <h2>Universe</h2>
        <div class="stat"><span class="label">Label</span><span class="value">${d.universe.label}</span></div>
        <div class="stat"><span class="label">n rows (post-gate)</span><span class="value">${d.universe.n_rows}</span></div>
      </div>
      <div class="card">
        <h2>Static baseline (10% SL / 50% TP)</h2>
        <div class="stat"><span class="label">Avg return</span><span class="value">${fmtPct(bs.avg_return_pct)}</span></div>
        <div class="stat"><span class="label">Win rate</span><span class="value">${fmtWr(bs.win_rate_pct)}</span></div>
        <div class="stat"><span class="label">n</span><span class="value">${bs.n}</span></div>
        <div class="desc">Exit mix: ${exitBreakdown(bs.exit_reason_breakdown)}</div>
      </div>
    </div>
  `;

  // Momentum reversal grid
  const mr = d.strategies.momentum_reversal;
  const mrRows = (mr.grid as any[])
    .slice()
    .sort((a, b) => (b.avg_return_pct ?? -Infinity) - (a.avg_return_pct ?? -Infinity))
    .map((c) => {
      const isBest = mr.best && c.params.drop_from_hwm_pct === mr.best.params.drop_from_hwm_pct
        && c.params.min_hwm_pct === mr.best.params.min_hwm_pct;
      const beatsBaseline = c.avg_return_pct != null && bs.avg_return_pct != null && c.avg_return_pct > bs.avg_return_pct;
      return `
        <tr class="${isBest ? 'row-baseline' : ''}">
          <td>${c.params.drop_from_hwm_pct}%${isBest ? ' ★' : ''}</td>
          <td>${c.params.min_hwm_pct}%</td>
          <td>${c.n}</td>
          <td><strong>${fmtPct(c.avg_return_pct)}</strong></td>
          <td>${fmtWr(c.win_rate_pct)}</td>
          <td class="${beatsBaseline ? 'green' : ''}">${beatsBaseline ? 'YES' : '—'}</td>
          <td><span class="desc">${exitBreakdown(c.exit_reason_breakdown)}</span></td>
        </tr>`;
    })
    .join('');

  const momentumCard = `
    <div class="card">
      <h2>Strategy 1 — Momentum reversal</h2>
      <div class="desc">Exit when price drops <strong>drop_from_hwm</strong>% from the high-water mark in a single
        checkpoint, but only if HWM is at least <strong>min_hwm</strong>% above entry. Fixed 10% floor SL.
        Grid sorted by avg return. ★ = optimum (gated by n≥30).
      </div>
      <table>
        <thead><tr>
          <th>Drop from HWM</th><th>Min HWM above entry</th><th>n</th>
          <th>Avg return</th><th>Win rate</th><th>Beats baseline?</th><th>Exit mix</th>
        </tr></thead>
        <tbody>${mrRows}</tbody>
      </table>
    </div>
  `;

  // Generic strategy-grid card builder
  const paramCols = (c: any, keys: string[]): string =>
    keys.map((k) => `<td>${c.params[k]}${typeof c.params[k] === 'number' && k.endsWith('_pct') ? '%' : ''}</td>`).join('');

  const gridCard = (
    title: string, desc: string, strat: any, paramKeys: { key: string; label: string }[],
  ): string => {
    const isBest = (c: any) =>
      strat.best && paramKeys.every(({ key }) => c.params[key] === strat.best.params[key]);
    const rows = (strat.grid as any[])
      .slice()
      .sort((a, b) => (b.avg_return_pct ?? -Infinity) - (a.avg_return_pct ?? -Infinity))
      .map((c) => {
        const beatsBaseline = c.avg_return_pct != null && bs.avg_return_pct != null && c.avg_return_pct > bs.avg_return_pct;
        const best = isBest(c);
        return `
          <tr class="${best ? 'row-baseline' : ''}">
            ${paramCols(c, paramKeys.map((p) => p.key))}
            <td>${c.n}${best ? ' ★' : ''}</td>
            <td><strong>${fmtPct(c.avg_return_pct)}</strong></td>
            <td>${fmtWr(c.win_rate_pct)}</td>
            <td class="${beatsBaseline ? 'green' : ''}">${beatsBaseline ? 'YES' : '—'}</td>
            <td><span class="desc">${exitBreakdown(c.exit_reason_breakdown)}</span></td>
          </tr>`;
      })
      .join('');
    const headerCols = paramKeys.map((p) => `<th>${p.label}</th>`).join('');
    return `
      <div class="card">
        <h2>${title}</h2>
        <div class="desc">${desc}</div>
        <table>
          <thead><tr>${headerCols}<th>n</th><th>Avg return</th><th>Win rate</th><th>Beats baseline?</th><th>Exit mix</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  };

  const va = d.strategies.vol_adaptive;
  const scaleOutCard = gridCard(
    'Strategy 2 — Scale-out / partial exits',
    'Sell <strong>size_pct</strong> of position at first checkpoint where price ≥ <strong>first_tp</strong>%. ' +
    'Runner trails <strong>runner_trail</strong>% below its post-partial HWM. Fixed 10% floor SL. ' +
    'Cost applied once. ★ = optimum (n≥30).',
    d.strategies.scale_out,
    [
      { key: 'first_tp_pct', label: 'First TP' },
      { key: 'size_pct', label: 'Size %' },
      { key: 'runner_trail_pct', label: 'Runner trail' },
    ],
  );

  const volCard = `
    <div class="card">
      <h2>Strategy 3 — Volatility-adaptive trailing</h2>
      <div class="desc">Trail distance = <strong>k × path_smoothness_0_30</strong>. Activates once price ≥ entry.
        Rows missing <code>path_smoothness_0_30</code> are skipped: ${va.rows_with_vol}/${d.universe.n_rows} usable.
        ★ = optimum (n≥30).
      </div>
      <table>
        <thead><tr><th>k</th><th>n</th><th>Avg return</th><th>Win rate</th><th>Beats baseline?</th><th>Exit mix</th></tr></thead>
        <tbody>
          ${(va.grid as any[])
            .slice()
            .sort((a, b) => (b.avg_return_pct ?? -Infinity) - (a.avg_return_pct ?? -Infinity))
            .map((c) => {
              const best = va.best && c.params.k === va.best.params.k;
              const beatsBaseline = c.avg_return_pct != null && bs.avg_return_pct != null && c.avg_return_pct > bs.avg_return_pct;
              return `
                <tr class="${best ? 'row-baseline' : ''}">
                  <td>${c.params.k}${best ? ' ★' : ''}</td>
                  <td>${c.n}</td>
                  <td><strong>${fmtPct(c.avg_return_pct)}</strong></td>
                  <td>${fmtWr(c.win_rate_pct)}</td>
                  <td class="${beatsBaseline ? 'green' : ''}">${beatsBaseline ? 'YES' : '—'}</td>
                  <td><span class="desc">${exitBreakdown(c.exit_reason_breakdown)}</span></td>
                </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  const td = d.strategies.time_decayed_tp;
  const timeCard = `
    <div class="card">
      <h2>Strategy 5 — Time-decayed TP ladder</h2>
      <div class="desc">TP target shrinks with elapsed seconds since entry (T+30). Four preset curves:
        aggressive · linear · exponential · conservative. Fixed 10% floor SL. ★ = optimum (n≥30).
      </div>
      <table>
        <thead><tr><th>Preset</th><th>Ladder</th><th>n</th><th>Avg return</th><th>Win rate</th><th>Beats baseline?</th><th>Exit mix</th></tr></thead>
        <tbody>
          ${(td.grid as any[])
            .slice()
            .sort((a, b) => (b.avg_return_pct ?? -Infinity) - (a.avg_return_pct ?? -Infinity))
            .map((c) => {
              const best = td.best && c.params.preset === td.best.params.preset;
              const beatsBaseline = c.avg_return_pct != null && bs.avg_return_pct != null && c.avg_return_pct > bs.avg_return_pct;
              const ladder = JSON.parse(c.params.ladder)
                .map((s: any) => `${s.seconds}s→${s.tpPct}%`).join(', ');
              return `
                <tr class="${best ? 'row-baseline' : ''}">
                  <td>${c.params.preset}${best ? ' ★' : ''}</td>
                  <td><span class="desc">${ladder}</span></td>
                  <td>${c.n}</td>
                  <td><strong>${fmtPct(c.avg_return_pct)}</strong></td>
                  <td>${fmtWr(c.win_rate_pct)}</td>
                  <td class="${beatsBaseline ? 'green' : ''}">${beatsBaseline ? 'YES' : '—'}</td>
                  <td><span class="desc">${exitBreakdown(c.exit_reason_breakdown)}</span></td>
                </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  const wl = d.strategies.whale_liq;
  const whaleDesc =
    'Exit early on adverse pool signals: <strong>liq_drop</strong>% drop in pool SOL from entry ' +
    'OR a single sell swap of ≥ <strong>whale_sell</strong> SOL. Fixed 10% SL + 50% TP still active — ' +
    'whale/liq triggers are ADDED on top of the baseline. ' +
    `Rows with entry liquidity captured: ${wl.rows_with_data}/${d.universe.n_rows}. ★ = optimum (n≥30).`;
  const whaleCard = (() => {
    if (!wl.grid || wl.grid.length === 0 || wl.rows_with_data === 0) {
      return `
        <div class="card">
          <h2>Strategy 4 — Whale-sell / liquidity drop</h2>
          <div class="desc">
            <span class="yellow">COLLECTING</span> — 0 rows have entry liquidity / swap data yet.
            ${wl.rows_with_data === 0 ? 'Waiting for new graduations after the 2026-04-20 data-collection rollout.' : ''}
          </div>
        </div>
      `;
    }
    const rowsHtml = (wl.grid as any[])
      .slice()
      .sort((a, b) => (b.avg_return_pct ?? -Infinity) - (a.avg_return_pct ?? -Infinity))
      .map((c) => {
        const best = wl.best
          && c.params.liq_drop_pct === wl.best.params.liq_drop_pct
          && c.params.whale_sell_sol === wl.best.params.whale_sell_sol;
        const beatsBaseline = c.avg_return_pct != null && bs.avg_return_pct != null && c.avg_return_pct > bs.avg_return_pct;
        return `
          <tr class="${best ? 'row-baseline' : ''}">
            <td>${c.params.liq_drop_pct}%${best ? ' ★' : ''}</td>
            <td>${c.params.whale_sell_sol} SOL</td>
            <td>${c.n}</td>
            <td><strong>${fmtPct(c.avg_return_pct)}</strong></td>
            <td>${fmtWr(c.win_rate_pct)}</td>
            <td class="${beatsBaseline ? 'green' : ''}">${beatsBaseline ? 'YES' : '—'}</td>
            <td><span class="desc">${exitBreakdown(c.exit_reason_breakdown)}</span></td>
          </tr>`;
      })
      .join('');
    return `
      <div class="card">
        <h2>Strategy 4 — Whale-sell / liquidity drop</h2>
        <div class="desc">${whaleDesc}</div>
        <table>
          <thead><tr><th>Liq drop</th><th>Whale sell</th><th>n</th><th>Avg return</th><th>Win rate</th><th>Beats baseline?</th><th>Exit mix</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  })();

  const body = matrixBanner + headerCards + momentumCard + scaleOutCard + volCard + timeCard + whaleCard;
  return shell('Exit Strategy Simulator', '/exit-sim', body, d);
}

// ── WALLET REP ANALYSIS PAGE ─────────────────────────────────────────

export function renderWalletRepAnalysisHtml(data: any): string {
  const d = data;
  const repFilters: Array<{ name: string; description: string }> = d.rep_filters ?? [];

  const fmtSim = (v: number | null): string => {
    if (v === null || v === undefined) return '<span class="yellow">—</span>';
    const cls = v > 0 ? 'green' : v < 0 ? 'red' : '';
    return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
  };

  const fmtDelta = (v: number | null, n: number): string => {
    if (v === null || v === undefined) {
      return n < (d.notes?.min_n_for_valid_delta ?? 20)
        ? `<span class="n-insuf">n=${n}</span>`
        : '<span class="yellow">—</span>';
    }
    const cls = v > 0.3 ? 'green' : v < -0.3 ? 'red' : 'yellow';
    const sign = v >= 0 ? '+' : '';
    return `<span class="${cls}"><strong>${sign}${v.toFixed(2)}pp</strong></span>`;
  };

  const fmtRetention = (v: number | null): string => {
    if (v === null || v === undefined) return '—';
    const cls = v >= 70 ? 'green' : v >= 40 ? 'yellow' : 'red';
    return `<span class="${cls}">${v.toFixed(1)}%</span>`;
  };

  const cov = d.coverage ?? null;
  const coverageCard = cov ? `
    <div class="card">
      <h2>Reputation column coverage</h2>
      <div class="desc">
        How many entry-gated labeled rows currently carry <code>creator_prior_*</code> values.
        Coverage of <code>creator_prior_token_count</code> is what the rep filters actually depend on —
        if it's near 100% the data <em>is</em> being captured, and any low cell n in the matrix below is
        real data scarcity (most pump.fun graduations come from first-time creators who have no priors in
        the DB), not a collection bug.
      </div>
      <table>
        <tbody>
          <tr><td>Total entry-gated labeled rows</td><td><strong>${cov.total_labeled_rows}</strong></td></tr>
          <tr><td>creator_wallet_address populated</td><td><strong>${cov.with_creator_wallet}</strong> (${cov.creator_wallet_coverage_pct}%)</td></tr>
          <tr><td>creator_prior_token_count populated</td><td><strong>${cov.with_prior_count}</strong> (${cov.prior_count_coverage_pct}%)</td></tr>
          <tr><td>… of those, with prior_count ≥ 1 (known_dev)</td><td><strong>${cov.with_prior_count_ge_1}</strong></td></tr>
          <tr><td>… of those, with prior_count ≥ 3 (repeat_dev_3plus)</td><td><strong>${cov.with_prior_count_ge_3}</strong></td></tr>
        </tbody>
      </table>
    </div>
  ` : '';

  // ── Population view: each rep filter applied standalone to the full
  //    entry-gated population (no combo intersection). Primary signal = Δ
  //    dump rate vs baseline (negative = filter knocks dumps out).
  const pop = d.population_view ?? null;
  const fmtRate = (v: number | null): string => {
    if (v === null || v === undefined) return '—';
    return `${v.toFixed(1)}%`;
  };
  const fmtDeltaRate = (v: number | null, invert = false): string => {
    if (v === null || v === undefined) return '—';
    // For dump-rate Δ: negative = good (less dumps), so invert color.
    const good = invert ? v < -0.3 : v > 0.3;
    const bad = invert ? v > 0.3 : v < -0.3;
    const cls = good ? 'green' : bad ? 'red' : 'yellow';
    const sign = v >= 0 ? '+' : '';
    return `<span class="${cls}"><strong>${sign}${v.toFixed(2)}pp</strong></span>`;
  };
  const fmtOptRet = (v: number | null): string => {
    if (v === null || v === undefined) return '<span class="yellow">—</span>';
    const cls = v > 0 ? 'green' : v < 0 ? 'red' : '';
    return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
  };

  const populationCard = pop ? `
    <div class="card">
      <h2>Population view — each rep filter standalone (no combo intersection)</h2>
      <div class="desc">
        Each row is a wallet-rep filter applied to the <strong>full entry-gated labeled population</strong>,
        no combo filter layered on. Answers "if I drop this rep filter on top of <em>any</em> existing strategy,
        does it knock out more dumps than pumps?" Sorted by Δ dump rate ascending — the first row is the filter
        that reduces dump rate the most vs the unfiltered baseline. Negative Δ on dump rate is good (fewer dumps);
        positive Δ on pump rate / opt avg ret is good (lifts winners / lifts return).
        <strong>Retention</strong> is what fraction of the baseline n the filter keeps — a filter that drops dump
        rate by 5pp but cuts n by 80% is rarely worth it.
      </div>
      <table>
        <thead>
          <tr>
            <th>Rep filter</th>
            <th>Condition</th>
            <th>n</th>
            <th>Retention</th>
            <th>Pump rate</th>
            <th>Dump rate</th>
            <th>Δ Dump rate</th>
            <th>Δ Pump rate</th>
            <th>Raw avg ret</th>
            <th>Δ Raw avg ret</th>
            <th>Opt avg ret</th>
            <th>Δ Opt avg ret</th>
            <th>Opt TP/SL</th>
          </tr>
        </thead>
        <tbody>
          <tr class="row-baseline">
            <td><strong>baseline (no filter)</strong></td>
            <td><span class="desc">${pop.baseline.description}</span></td>
            <td><strong>${pop.baseline.n}</strong></td>
            <td>—</td>
            <td>${fmtRate(pop.baseline.pump_rate_pct)}</td>
            <td>${fmtRate(pop.baseline.dump_rate_pct)}</td>
            <td>—</td>
            <td>—</td>
            <td>${fmtOptRet(pop.baseline.raw_avg_ret_pct)}</td>
            <td>—</td>
            <td>${fmtOptRet(pop.baseline.opt_avg_ret)}</td>
            <td>—</td>
            <td>${pop.baseline.opt_tp ?? '—'} / ${pop.baseline.opt_sl ?? '—'}</td>
          </tr>
          ${(pop.rows as any[]).map((r) => `
            <tr>
              <td><strong>${r.rep_filter}</strong></td>
              <td><span class="desc">${r.description}</span></td>
              <td>${r.n}</td>
              <td>${fmtRetention(r.n_retention_pct)}</td>
              <td>${fmtRate(r.pump_rate_pct)}</td>
              <td>${fmtRate(r.dump_rate_pct)}</td>
              <td>${fmtDeltaRate(r.delta_dump_rate_pp, true)}</td>
              <td>${fmtDeltaRate(r.delta_pump_rate_pp)}</td>
              <td>${fmtOptRet(r.raw_avg_ret_pct)}</td>
              <td>${fmtDeltaRate(r.delta_raw_avg_ret_pp)}</td>
              <td>${fmtOptRet(r.opt_avg_ret)}</td>
              <td>${fmtDeltaRate(r.delta_opt_avg_ret_pp)}</td>
              <td>${r.opt_tp ?? '—'} / ${r.opt_sl ?? '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  const summaryCard = `
    <div class="card">
      <h2>Rep Filter Leaderboard — avg impact across the top 20 combos</h2>
      <div class="desc">
        For each wallet-rep filter, we layer it on top of each of the top 20 combos from
        <code>/api/best-combos</code> and measure the change in <strong>per-combo opt TP/SL</strong>
        sim return (matches Panel 6 <code>top_pairs</code>; the fixed 10%SL/50%TP framework was retired
        2026-04-21). Deltas are only counted when the filtered cell has
        n ≥ ${d.notes?.min_n_for_valid_delta ?? 30} (same as <code>SIM_MIN_N_FOR_OPTIMUM</code> — below
        that, no opt is published). <strong>Combos w/ any n</strong> shows how many of the 20 combos have
        at least 1 row passing the rep filter — useful when "Evaluated" reads 0 but data is being captured.
        Ranked by mean Δ (best first).
      </div>
      <table>
        <thead>
          <tr>
            <th>Rep filter</th>
            <th>Condition</th>
            <th>Mean Δ pp</th>
            <th>Median Δ pp</th>
            <th>Combos improved</th>
            <th>Combos worsened</th>
            <th>Evaluated (n≥${d.notes?.min_n_for_valid_delta ?? 30})</th>
            <th>Combos w/ any n</th>
            <th>Mean n retention</th>
          </tr>
        </thead>
        <tbody>
          ${(d.summary as any[]).map((s, idx) => {
            const best = idx === 0 && s.mean_delta_pp !== null && s.mean_delta_pp > 0;
            return `
            <tr class="${best ? 'row-baseline' : ''}">
              <td><strong>${s.rep_filter}${best ? ' ★' : ''}</strong></td>
              <td><span class="desc">${s.description}</span></td>
              <td>${fmtDelta(s.mean_delta_pp, s.combos_evaluated >= 1 ? 999 : 0)}</td>
              <td>${fmtDelta(s.median_delta_pp, s.combos_evaluated >= 1 ? 999 : 0)}</td>
              <td class="green">${s.combos_improved}</td>
              <td class="red">${s.combos_worsened}</td>
              <td>${s.combos_evaluated} / ${d.rows.length}</td>
              <td>${s.combos_with_any_n ?? '—'} / ${d.rows.length}</td>
              <td>${fmtRetention(s.mean_n_retention_pct)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  const repCols = repFilters.map(r => `<th title="${r.description}">${r.name}<br><span class="desc" style="font-weight:400">Δ pp</span></th>`).join('');

  const matrixCard = `
    <div class="card">
      <h2>Matrix — top 20 combos × wallet-rep filters</h2>
      <div class="desc">
        Each cell shows the per-combo opt sim-return delta (percentage points) vs the base combo
        when the rep filter is layered on. Cell hover shows filtered n + opt TP/SL.
        <span class="n-insuf">Grey "n=X"</span> cells are below the n ≥ ${d.notes?.min_n_for_valid_delta ?? 30}
        threshold (= <code>SIM_MIN_N_FOR_OPTIMUM</code>) — the rows exist but there aren't enough of them
        to publish an opt TP/SL.
      </div>
      <table>
        <thead>
          <tr>
            <th style="min-width:220px">Combo</th>
            <th>Base n</th>
            <th>Base opt%</th>
            ${repCols}
          </tr>
        </thead>
        <tbody>
          ${(() => {
            // Baseline row at the top: no combo applied. Pulls from
            // population_view so each rep cell shows the rep filter's
            // standalone Δ vs the entry-gated baseline.
            if (!pop) return '';
            const popByName: Record<string, any> = {};
            for (const r of (pop.rows as any[])) popByName[r.rep_filter] = r;
            const cells = repFilters.map(rep => {
              const r = popByName[rep.name];
              if (!r) return '<td>—</td>';
              const title = `n=${r.n} (retention ${r.n_retention_pct ?? '—'}%) · opt ${r.opt_avg_ret ?? '—'}% @ tp${r.opt_tp ?? '—'}/sl${r.opt_sl ?? '—'} · wr ${r.opt_win_rate ?? '—'}% · dump_rate ${r.dump_rate_pct ?? '—'}% (Δ ${r.delta_dump_rate_pp ?? '—'}pp)`;
              return `<td title="${title}">${fmtDelta(r.delta_opt_avg_ret_pp, r.n)}</td>`;
            }).join('');
            return `
            <tr class="row-baseline">
              <td><strong>(no combo — entry-gated baseline)</strong></td>
              <td>${pop.baseline.n}</td>
              <td>${fmtSim(pop.baseline.opt_avg_ret)}</td>
              ${cells}
            </tr>`;
          })()}
          ${(d.rows as any[]).map((row) => {
            const cells = repFilters.map(rep => {
              const cell = row.cells[rep.name];
              if (!cell) return '<td>—</td>';
              const title = `n=${cell.n} (retention ${cell.n_retention_pct ?? '—'}%) · opt ${cell.opt_avg_ret ?? '—'}% @ tp${cell.opt_tp ?? '—'}/sl${cell.opt_sl ?? '—'} · wr ${cell.opt_win_rate ?? '—'}%`;
              return `<td title="${title}">${fmtDelta(cell.delta_opt_ret_pp, cell.n)}</td>`;
            }).join('');
            return `
            <tr>
              <td><strong>${row.filter_spec}</strong></td>
              <td>${row.base.n}</td>
              <td>${fmtSim(row.base.opt_avg_ret)}</td>
              ${cells}
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  const notesCard = `
    <div class="card">
      <h2>How to read</h2>
      <div class="desc">
        <strong>Δ pp</strong> = filtered combo sim return minus base combo sim return, in percentage points.<br>
        Positive (green) means the wallet-rep filter improves profitability on that combo.<br>
        Negative (red) means it hurts (usually because it drops too many winners alongside losers).<br>
        <strong>n retention</strong> = filtered sample size as a percentage of the base combo's n. A rep filter
        that improves Δ but cuts n by 80% is a lot less useful than one that improves Δ at 50%+ retention.<br><br>
        <strong>Rep source:</strong> creator wallet reputation only, using
        <code>creator_prior_token_count</code>, <code>creator_prior_rug_rate</code>,
        <code>creator_prior_avg_return</code>, and <code>creator_last_token_age_hours</code>
        from <code>graduation_momentum</code>.
      </div>
    </div>
  `;

  const body = coverageCard + populationCard + summaryCard + matrixCard + notesCard;
  return shell('Wallet Rep Analysis', '/wallet-rep-analysis', body, d);
}

// ── EXIT-SIM MATRIX PAGE ─────────────────────────────────────────────
// Top 20 filter combos × 5 dynamic-exit strategies. Each cell = best-cell
// Δ vs that combo's own static 10%SL/50%TP baseline. Answers "which
// combo lifts most from dynamic exits?".

export function renderExitSimMatrixHtml(data: any): string {
  const d = data;

  const fmtPct = (v: number | null | undefined): string => {
    if (v == null) return '<span class="yellow">—</span>';
    const cls = v > 0 ? 'green' : v < 0 ? 'red' : '';
    const sign = v > 0 ? '+' : '';
    return `<span class="${cls}">${sign}${v.toFixed(2)}%</span>`;
  };

  const fmtDelta = (v: number | null | undefined): string => {
    if (v == null) return '<span class="yellow">—</span>';
    const cls = v > 0.3 ? 'green' : v < -0.3 ? 'red' : 'yellow';
    const sign = v >= 0 ? '+' : '';
    return `<span class="${cls}"><strong>${sign}${v.toFixed(2)}pp</strong></span>`;
  };

  const strategyLabels: Record<string, string> = {
    momentum_reversal: 'Mom. reversal',
    scale_out: 'Scale-out',
    vol_adaptive: 'Vol. trail',
    time_decayed_tp: 'Time-decay TP',
    whale_liq: 'Whale / liq',
  };

  const overviewCard = `
    <div class="card">
      <h2>Exit Strategy × Combo Matrix</h2>
      <div class="desc">
        Each row is one of the top 20 filter combos from <code>/api/best-combos</code>.
        For each combo we (1) find its own best static (SL × TP) cell across a 4×4 grid,
        (2) re-run the full 5-strategy dynamic-exit grid, and (3) report the best dynamic
        cell's Δ vs the combo's own OPTIMAL static baseline — not the global 10/50 default.
        <br><br>
        <strong>Sort order:</strong> by best Δ across all 5 strategies, descending.
        Combos near the top gain the most from dynamic exits on top of their own optimal
        static tuning; combos at the bottom are already at their optimum (or have too-thin
        grids to rank).
      </div>
    </div>
  `;

  const matrixCard = (() => {
    if (!d.rows || d.rows.length === 0) {
      return `
        <div class="card">
          <h2>Matrix</h2>
          <div class="desc"><span class="yellow">No combos found</span> — is <code>/api/best-combos</code> empty?</div>
        </div>`;
    }

    const strategyCols = ['momentum_reversal', 'scale_out', 'vol_adaptive', 'time_decayed_tp', 'whale_liq'];

    const headerCells = strategyCols
      .map((s) => `<th>${strategyLabels[s]}</th>`)
      .join('');

    const rowsHtml = (d.rows as any[]).map((r, i) => {
      const strategyByName = new Map<string, any>();
      for (const c of r.strategies) strategyByName.set(c.strategy, c);

      const strategyCells = strategyCols.map((name) => {
        const c = strategyByName.get(name);
        if (!c || c.delta_vs_static_pp == null) {
          return `<td><span class="desc">n<${d.min_n_per_cell}</span></td>`;
        }
        const isBest = r.best_strategy === name;
        return `
          <td class="${isBest ? 'row-baseline' : ''}">
            ${fmtDelta(c.delta_vs_static_pp)}
            <div class="desc">${fmtPct(c.best_avg_return_pct)} · n=${c.best_n}${isBest ? ' ★' : ''}</div>
          </td>`;
      }).join('');

      const optParams = (r.static_optimal_sl_pct != null && r.static_optimal_tp_pct != null)
        ? `<div class="desc">${r.static_optimal_sl_pct}SL / ${r.static_optimal_tp_pct}TP</div>`
        : '';

      return `
        <tr>
          <td>${i + 1}</td>
          <td><code>${r.filter_spec}</code></td>
          <td>${r.n_rows}</td>
          <td>${fmtPct(r.static_10_50_return_pct)}</td>
          <td><strong>${fmtPct(r.static_optimal_return_pct)}</strong>${optParams}</td>
          ${strategyCells}
          <td>${fmtDelta(r.best_delta_pp)}</td>
        </tr>`;
    }).join('');

    return `
      <div class="card">
        <h2>Matrix — top 20 combos × 5 strategies</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Combo</th>
              <th>n</th>
              <th>Static 10/50</th>
              <th>Opt. Static</th>
              ${headerCells}
              <th>Best Δ</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
  })();

  const notesCard = `
    <div class="card">
      <h2>How to read</h2>
      <div class="desc">
        <strong>Static 10/50</strong>: return at the global 10%SL/50%TP default — sanity-check
        column so you can spot any drift from /api/best-combos' leaderboard value.<br>
        <strong>Opt. Static</strong>: the best cell in a 10×12 (SL × TP) grid mirroring
        Panel 6's (SL ∈ 3–30, TP ∈ 10–150). This is the FAIR baseline — each combo has its
        own natural TP/SL pair, and comparing every combo against a fixed 10/50 undersells
        combos 10/50 wasn't tuned for.<br><br>
        Each strategy cell shows <strong>Δ vs Opt. Static</strong> in pp (top), then the best
        dynamic-cell's raw avg return and n (bottom). ★ = the winning strategy for that row.<br>
        <span class="green">Green</span> = Δ > +0.3 pp (meaningful lift over opt. static).
        <span class="yellow">Yellow</span> = Δ within ±0.3 pp (noise).
        <span class="red">Red</span> = Δ < -0.3 pp (dynamic exit hurts vs this combo's own optimum).<br><br>
        <code>n&lt;${d.min_n_per_cell}</code> means that strategy's grid has no cell with enough samples
        for this combo to rank — wait for more data.<br><br>
        <strong>Why n differs from Panel 6:</strong> this matrix enforces the live-trading
        entry gate (<code>pct_t30 ∈ [5%, 100%]</code>) — a real bot only enters positions that
        are modestly up at T+30. Panel 6 explores all labeled rows regardless of entry state.
        Same combo, different universes by design. Opt. (SL, TP) values should be comparable;
        raw returns will differ.
      </div>
    </div>
  `;

  const body = overviewCard + matrixCard + notesCard;
  return shell('Exit Strategy Matrix', '/exit-sim-matrix', body, d);
}

// ── PIPELINE PAGE ────────────────────────────────────────────────────────────

export function renderPipelineHtml(data: any): string {
  const grads: any[] = data.grads || [];
  const ss = data.session_stats;
  const activeCount: number = data.active_strategy_count || 0;

  const fmt  = (v: any, dec = 1) => v == null ? '—' : Number(v).toFixed(dec);
  const fmtP = (v: any) => v == null ? '—' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)}%`;

  const chip = (text: string, color: string) =>
    `<span style="background:${color}22;color:${color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold">${text}</span>`;

  const statusChip = (s: string) => {
    if (s === 'TRADED')   return chip('TRADED',   '#22c55e');
    if (s === 'FILTERED') return chip('FILTERED', '#f59e0b');
    return chip('NO EVAL', '#f87171');
  };

  const labelChip = (l: string | null) => {
    if (!l) return '<span style="color:#475569">—</span>';
    const c = l === 'PUMP' ? '#22c55e' : l === 'DUMP' ? '#f87171' : '#94a3b8';
    return `<span style="color:${c}">${l}</span>`;
  };

  // Session funnel cards
  const fCard = (label: string, val: any, color: string, note?: string) => `
    <div style="background:#1e293b;border-radius:6px;padding:12px 16px;min-width:120px;flex:1">
      <div style="color:${color};font-size:22px;font-weight:bold;line-height:1">${val ?? '—'}</div>
      <div style="color:#94a3b8;font-size:11px;margin-top:4px">${label}</div>
      ${note ? `<div style="color:#475569;font-size:10px;margin-top:2px">${note}</div>` : ''}
    </div>`;

  const funnelHtml = ss ? `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
      ${fCard('Verified Grads',        ss.verified_graduations, '#60a5fa', 'listener')}
      ${fCard('Observations Started',  ss.observations_started,  '#22d3ee', 'price collector')}
      ${fCard('Stale / No Eval',       ss.stale_graduations,     '#f87171', 'arrived > T+25')}
      ${fCard('T+30 Fired',            ss.t30_callbacks_fired,   '#a3e635', 'strategies ran')}
      ${fCard('T+30 Timeouts',         ss.t30_timeouts,          '#f59e0b', 'pool fetch failed')}
    </div>
  ` : `<div style="color:#64748b;margin-bottom:20px">No session stats (listener not running or just restarted)</div>`;

  const rows = grads.map(g => {
    // Pool died = T+30 was reached (strategies evaluated) but T+300 never arrived
    // and the token is old enough that it should have completed by now (>6 min).
    const gradMs = g.grad_time ? new Date(g.grad_time + 'Z').getTime() : null;
    const minsOld = gradMs ? (Date.now() - gradMs) / 60000 : 0;
    const t30Reached = g.pct_t30 != null || g.skip_count > 0 || g.trade_count > 0;
    const poolDied = t30Reached && g.pct_t300 == null && minsOld > 6;

    const noEvalNote = g.status === 'NO_EVAL'
      ? `<span style="color:#475569;font-size:10px"> stale or T+30 timeout</span>`
      : '';
    const poolDiedNote = poolDied
      ? `<span style="background:#33415522;color:#64748b;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px" title="Pool liquidity drained before T+300 — token dumped hard, no 5-min data. Not a bug.">pool dead</span>`
      : '';
    const reasons = g.skip_reasons
      ? g.skip_reasons.split(',').map((r: string) =>
          `<span style="color:#94a3b8;font-size:10px;margin-right:4px">${escHtml(r.trim())}</span>`
        ).join('')
      : (g.status === 'NO_EVAL' ? `<span style="color:#475569;font-size:10px">not evaluated</span>` : '—');

    return `<tr style="border-bottom:1px solid #1e293b">
      <td style="color:#60a5fa;font-weight:bold">#${g.id}</td>
      <td style="white-space:nowrap">${g.mint ? `<span style="display:inline-flex;align-items:center;gap:3px"><a href="https://dexscreener.com/solana/${g.mint}" target="_blank" title="${g.mint}" style="font-family:monospace;font-size:10px;color:#64748b;text-decoration:none">${g.mint.slice(0,8)}…</a><button onclick="navigator.clipboard.writeText('${g.mint}').then(()=>{this.textContent='✓';setTimeout(()=>{this.textContent='⎘'},1200)})" title="Copy mint address" style="background:none;border:none;cursor:pointer;color:#475569;font-size:11px;padding:0 2px;line-height:1">⎘</button></span>` : '—'}</td>
      <td style="color:#475569;font-size:11px">${g.grad_time ? g.grad_time.replace('T',' ').slice(0,19) : '—'}</td>
      <td style="text-align:right">${fmt(g.vel)}</td>
      <td style="text-align:right">${fmt(g.top5)}</td>
      <td style="text-align:right">${fmt(g.dev_pct)}</td>
      <td style="text-align:right">${fmtP(g.pct_t30)}</td>
      <td style="text-align:right">${fmtP(g.pct_t300)}</td>
      <td>${labelChip(g.label)}</td>
      <td>${statusChip(g.status)}${noEvalNote}${poolDiedNote}</td>
      <td>${reasons}</td>
      <td style="text-align:center;color:${g.trade_count > 0 ? '#22c55e' : '#475569'}">${g.trade_count}</td>
      <td style="text-align:center;color:#94a3b8">${g.skip_count}</td>
    </tr>`;
  }).join('');

  const body = `
    <h2 style="margin:0 0 4px;color:#60a5fa">Graduation Pipeline</h2>
    <p style="margin:0 0 20px;color:#64748b">
      Session funnel: graduation → price observation → T+30 → strategy evaluation → trade/skip.<br>
      Active strategies: <strong style="color:#e2e8f0">${activeCount}</strong> —
      so each graduation should produce ${activeCount} trade or skip records when it passes T+30.
    </p>

    ${funnelHtml}

    <div style="background:#172033;border:1px solid #334155;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#64748b">
      <strong style="color:#94a3b8">Status key:</strong>
      ${chip('TRADED','#22c55e')} at least 1 strategy entered &nbsp;·&nbsp;
      ${chip('FILTERED','#f59e0b')} all ${activeCount} strategies ran and rejected (see Skip Reasons) &nbsp;·&nbsp;
      ${chip('NO EVAL','#f87171')} price collector rejected before strategies ran — stale arrival (&gt;T+25) or T+30 pool-fetch timeout &nbsp;·&nbsp;
      <span style="background:#33415522;color:#64748b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold">pool dead</span> T+30 fired but pool drained before T+300 — token dumped hard, not a bug
    </div>

    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:#475569;font-size:11px;text-align:left;border-bottom:2px solid #334155;padding-bottom:4px">
        <th style="padding:6px 8px">ID</th>
        <th style="padding:6px 8px">Mint</th>
        <th style="padding:6px 8px">Grad Time (UTC)</th>
        <th style="padding:6px 8px;text-align:right">vel</th>
        <th style="padding:6px 8px;text-align:right">top5%</th>
        <th style="padding:6px 8px;text-align:right">dev%</th>
        <th style="padding:6px 8px;text-align:right">pct_t30</th>
        <th style="padding:6px 8px;text-align:right">pct_t300</th>
        <th style="padding:6px 8px">Label</th>
        <th style="padding:6px 8px">Status</th>
        <th style="padding:6px 8px">Skip Reasons</th>
        <th style="padding:6px 8px;text-align:center">Trades</th>
        <th style="padding:6px 8px;text-align:center">Skips</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;

  return shell('Graduation Pipeline', '/pipeline', body, data);
}

// ── DAILY REPORT PAGE ────────────────────────────────────────────────────
//
// Reads computeDailyReport(db) data and renders the cross-session memory
// page: lessons-learned memo, open action items, today's narrative + auto
// stats, winners/losers drill-down, anomalies, recommendations, and
// day-over-day / week-over-week history. Designed to be the first thing a
// fresh Claude session reads at the start of every day.

function escapeHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdownLite(s: string | null | undefined): string {
  // Minimal markdown — just enough for narrative readability without
  // pulling in a parser. Handles paragraphs, **bold**, *italic*, `code`,
  // lists. Untrusted content is escaped first.
  if (!s) return '';
  const escaped = escapeHtml(s);
  const lines = escaped.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${trimmed.replace(/^[-*]\s+/, '')}</li>`);
    } else if (trimmed === '') {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('');
    } else if (/^#{1,3}\s+/.test(trimmed)) {
      if (inList) { out.push('</ul>'); inList = false; }
      const level = (trimmed.match(/^#+/) || ['#'])[0].length;
      const tag = `h${Math.min(level + 2, 6)}`;
      out.push(`<${tag}>${trimmed.replace(/^#+\s+/, '')}</${tag}>`);
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${trimmed}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function pctSigned(val: number | null | undefined, digits = 1): string {
  if (val == null || Number.isNaN(val)) return '—';
  const cls = val > 0 ? 'green' : val < 0 ? 'red' : '';
  const sign = val > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${val.toFixed(digits)}%</span>`;
}

function deltaPp(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return '—';
  const cls = val > 0 ? 'green' : val < 0 ? 'red' : '';
  const sign = val > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${val.toFixed(1)}pp</span>`;
}

function severityBadge(sev: 'low' | 'med' | 'high'): string {
  const color = sev === 'high' ? '#7f1d1d' : sev === 'med' ? '#7c2d12' : '#1e3a5f';
  const fg = sev === 'high' ? '#fca5a5' : sev === 'med' ? '#fed7aa' : '#93c5fd';
  return `<span class="badge" style="background:${color};color:${fg};text-transform:uppercase">${sev}</span>`;
}

function statusBadge(status: string): string {
  const map: Record<string, [string, string]> = {
    PROPOSED: ['#1e3a5f', '#93c5fd'],
    EXECUTED: ['#166534', '#4ade80'],
    DEFERRED: ['#422006', '#facc15'],
    REJECTED: ['#3f1212', '#fca5a5'],
    HEALTHY: ['#166534', '#4ade80'],
    NO_DATA: ['#1f2937', '#94a3b8'],
  };
  const [bg, fg] = map[status] ?? ['#262640', '#94a3b8'];
  return `<span class="badge" style="background:${bg};color:${fg}">${escapeHtml(status)}</span>`;
}

interface ReportTradeRow {
  id: number;
  graduation_id: number;
  mint: string;
  strategy_id: string | null;
  exit_reason: string | null;
  net_return_pct: number | null;
  net_profit_sol: number | null;
  held_seconds: number | null;
}

function renderTradeTable(trades: ReportTradeRow[], emptyMsg: string): string {
  if (!trades || trades.length === 0) {
    return `<div style="color:#64748b;font-style:italic;padding:8px 0">${emptyMsg}</div>`;
  }
  const rows = trades.map(t => `<tr>
    <td>${t.graduation_id}</td>
    <td><code style="font-size:11px">${escapeHtml((t.mint || '').slice(0, 8))}…</code></td>
    <td>${escapeHtml(t.strategy_id ?? '—')}</td>
    <td>${pctSigned(t.net_return_pct, 1)}</td>
    <td style="text-align:right">${t.net_profit_sol != null ? t.net_profit_sol.toFixed(4) : '—'}</td>
    <td>${escapeHtml(t.exit_reason ?? '—')}</td>
    <td style="text-align:right">${t.held_seconds != null ? `${t.held_seconds}s` : '—'}</td>
  </tr>`).join('');
  return `<table>
    <thead><tr>
      <th>Grad</th><th>Mint</th><th>Strategy</th>
      <th>Net %</th><th style="text-align:right">SOL</th>
      <th>Exit</th><th style="text-align:right">Held</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderActionItems(
  items: Array<{ id: string; kind: string; target_id?: string; summary: string; status: string; from_date?: string }>,
  activeStrategyIds?: Set<string>,
): string {
  if (!items || items.length === 0) {
    return `<div style="color:#64748b;font-style:italic;padding:8px 0">No open action items.</div>`;
  }
  // Target IDs may be comma-separated lists (e.g. "v10-best-double,v9shadow-vel20-top5").
  // An item is "stale" only when every listed target is absent from the live
  // strategies snapshot AND the item is still PROPOSED — that's the v17/v18
  // bug class where the kill already happened but the action item lags.
  const isStale = (item: { target_id?: string; status: string }): boolean => {
    if (!activeStrategyIds || item.status !== 'PROPOSED') return false;
    const targets = (item.target_id ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (targets.length === 0) return false;
    return targets.every(t => !activeStrategyIds.has(t));
  };

  const rows = items.map(i => {
    const stale = isStale(i);
    const staleBadge = stale
      ? ` <span class="badge" style="background:#3f1212;color:#fca5a5;font-size:10px" title="Target absent from current strategies.json — likely already removed">stale: target removed</span>`
      : '';
    return `<tr${stale ? ' style="background:#1a0c0c"' : ''}>
      <td>${statusBadge(i.status)}${staleBadge}</td>
      <td><span class="badge" style="background:#262640;color:#a5b4fc">${escapeHtml(i.kind)}</span></td>
      <td>${escapeHtml(i.target_id ?? '')}</td>
      <td>${escapeHtml(i.summary)}</td>
      <td style="color:#64748b;font-size:11px">${escapeHtml(i.from_date ?? '')}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr>
      <th>Status</th><th>Kind</th><th>Target</th><th>Summary</th><th>From</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Render a compact SVG line chart for a per-strategy daily history series.
 * Used inside the By-Strategy expand row. Values aligned left→right by index
 * (oldest→newest). null values are skipped.
 */
function renderMiniTimeseries(
  values: Array<number | null>,
  label: string,
  color: string,
  fmt: (v: number) => string = v => v.toFixed(2),
): string {
  const W = 220;
  const H = 56;
  const PAD = 18;
  const points = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v != null);
  if (points.length < 2) {
    return `<div style="display:inline-block;width:${W}px;height:${H + 16}px;margin:4px 8px 0 0;padding:6px 8px;border:1px solid #2a2a3e;border-radius:4px;color:#64748b;font-size:10px">${escapeHtml(label)}: history accumulating</div>`;
  }
  const vs = points.map(p => p.v);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  const range = maxV - minV || 1;
  const xStep = (W - PAD * 2) / Math.max(values.length - 1, 1);
  const yScale = (v: number) => PAD + (1 - (v - minV) / range) * (H - PAD * 2);
  const pts = points.map(p => `${(PAD + p.i * xStep).toFixed(1)},${yScale(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1].v;
  return `<div style="display:inline-block;width:${W}px;margin:4px 8px 0 0;padding:4px 6px;border:1px solid #2a2a3e;border-radius:4px;background:#13131f">
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8">
      <span>${escapeHtml(label)}</span>
      <span style="color:${color};font-weight:600">${escapeHtml(fmt(last))}</span>
    </div>
    <svg width="${W - 12}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>
  </div>`;
}

/** Inline pill/chip used in the Roster Changes and Weekly Aggregates panels. */
function rosterChip(label: string, bg: string, fg: string, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="badge" style="background:${bg};color:${fg};margin:2px 4px 2px 0;display:inline-block"${titleAttr}>${escapeHtml(label)}</span>`;
}

function renderRecommendations(recs: any): string {
  if (!recs || typeof recs !== 'object') {
    return `<div style="color:#64748b;font-style:italic;padding:8px 0">No structured recommendations yet — add via report-upsert.recommendations.</div>`;
  }
  const sections: Array<[string, string, string]> = [
    ['kill', 'Kill', '#7f1d1d'],
    ['promote', 'Promote', '#166534'],
    ['watch', 'Watch', '#422006'],
    ['create_new', 'Create New', '#1e3a5f'],
  ];
  const out: string[] = [];
  for (const [key, label, color] of sections) {
    const arr = recs[key];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const items = arr.map((it: any) => {
      if (typeof it === 'string') return `<li>${escapeHtml(it)}</li>`;
      const id = it.strategy_id || it.id || '';
      const reason = it.reason || it.hypothesis || it.note || '';
      return `<li><strong>${escapeHtml(id)}</strong> — ${escapeHtml(reason)}</li>`;
    }).join('');
    out.push(`<h3 style="color:${color}">${label} (${arr.length})</h3><ul>${items}</ul>`);
  }
  if (out.length === 0) {
    return `<div style="color:#64748b;font-style:italic;padding:8px 0">No recommendations in this report.</div>`;
  }
  return out.join('');
}

export function renderReportHtml(data: any): string {
  const todayAuto = data.today_auto || {};
  const todayReport = data.today_report;
  const recentReports: any[] = data.recent_reports || [];
  const lessons: any[] = data.lessons || [];
  const openItems: any[] = data.open_action_items || [];
  const weekly: any[] = data.weekly_aggregates || [];
  const anomalies: any[] = todayAuto.anomalies_auto || [];
  const rosterDiff = data.roster_diff_vs_yesterday || { added: [], removed: [], toggled_off: [], toggled_on: [] };
  const todaySnap: any[] = todayAuto.by_strategy_daily_snapshot || [];
  const activeSnap: any[] = todayAuto.active_strategies_snapshot || [];
  const activeStrategyIds = new Set<string>(activeSnap.map((s: any) => s.strategy_id));

  // ── Header ──
  const verdict = todayAuto.diagnose_verdict || 'NO_DATA';
  const profit = todayAuto.today_net_profit_sol;
  const profitClass = profit > 0 ? 'green' : profit < 0 ? 'red' : '';
  const activeCount = todayAuto.active_strategy_count;
  const activeCountYest = todayAuto.active_strategy_count_yesterday;
  const activeDelta = (typeof activeCount === 'number' && typeof activeCountYest === 'number')
    ? activeCount - activeCountYest : null;
  const activeDeltaText = activeDelta != null && activeDelta !== 0
    ? ` <span style="color:${activeDelta > 0 ? '#86efac' : '#fca5a5'};font-size:11px">(${activeDelta > 0 ? '+' : ''}${activeDelta})</span>` : '';
  const bleeder = todayAuto.worst_bleeder;
  const bleederText = bleeder
    ? `<span style="font-size:12px">${escapeHtml(bleeder.label.slice(0, 28))}<br><span class="red" style="font-weight:600">${bleeder.total_net_sol_lifetime.toFixed(3)} SOL</span></span>`
    : `<span style="color:#64748b">—</span>`;
  const headerHtml = `<div class="card">
    <h2>${escapeHtml(todayAuto.date || 'Daily Report')}</h2>
    <div class="desc">Cross-session memory for the trading bot. today_auto recomputes every render; narrative + recommendations come from /daily-report Claude runs. Day boundary: 06:00 America/Chicago.</div>
    <div class="grid">
      <div class="stat"><span class="label">Diagnose</span><span class="value">${statusBadge(verdict)}</span></div>
      <div class="stat"><span class="label">Active strategies</span><span class="value">${activeCount ?? '—'}${activeDeltaText} <span style="color:#64748b;font-size:12px">(yest ${activeCountYest ?? '—'})</span></span></div>
      <div class="stat"><span class="label">Trades today</span><span class="value">${todayAuto.n_trades ?? 0} <span style="color:#64748b">(yest ${todayAuto.n_trades_yesterday ?? 0})</span></span></div>
      <div class="stat"><span class="label">Graduations today</span><span class="value">${todayAuto.n_graduations ?? 0} <span style="color:#64748b">(yest ${todayAuto.n_graduations_yesterday ?? 0})</span></span></div>
      <div class="stat"><span class="label">Net P&amp;L (SOL)</span><span class="value ${profitClass}">${profit != null ? (profit > 0 ? '+' : '') + profit.toFixed(4) : '—'}</span></div>
      <div class="stat"><span class="label">Worst bleeder (≥30 trades)</span><span class="value">${bleederText}</span></div>
      <div class="stat"><span class="label">Generated by</span><span class="value">${escapeHtml(todayReport?.generated_by ?? 'auto-stats only')}</span></div>
      <div class="stat"><span class="label">Active lessons</span><span class="value">${lessons.length}</span></div>
    </div>
    ${verdict !== 'HEALTHY' && verdict !== 'NO_DATA'
      ? `<div style="margin-top:8px;padding:10px;background:#3f1212;border:1px solid #7f1d1d;border-radius:4px;color:#fca5a5"><strong>Next action:</strong> ${escapeHtml(todayAuto.diagnose_next_action || '')}</div>`
      : ''}
  </div>`;

  // ── Strategy Roster Changes Since Yesterday ──
  // Surfaces toggle-offs / removals so a glance shows what the operator
  // (or the bot) changed since the prior /daily-report snapshot. Hidden on
  // the first day of rollout when there's no prior snapshot to diff against.
  const rosterEmpty = rosterDiff.added.length === 0 && rosterDiff.removed.length === 0
    && rosterDiff.toggled_off.length === 0 && rosterDiff.toggled_on.length === 0;
  const rosterPanelVisible = recentReports.length > 0;
  const rosterChips = (entries: any[], bg: string, fg: string) =>
    entries.map(e => rosterChip(e.label || e.strategy_id, bg, fg, e.strategy_id)).join('');
  const rosterHtml = rosterPanelVisible
    ? `<div class="card">
        <h2>Strategy Roster Changes Since Yesterday</h2>
        <div class="desc">Diff against the prior /daily-report snapshot. Use this to catch toggle-offs and removals before reading recommendations.</div>
        ${rosterEmpty
          ? `<div style="color:#64748b;font-style:italic">No roster changes since yesterday.</div>`
          : `<div style="display:flex;flex-wrap:wrap;gap:16px">
              ${rosterDiff.added.length > 0 ? `<div><div style="color:#86efac;font-size:11px;margin-bottom:4px">Added (${rosterDiff.added.length})</div>${rosterChips(rosterDiff.added, '#14532d', '#86efac')}</div>` : ''}
              ${rosterDiff.removed.length > 0 ? `<div><div style="color:#fca5a5;font-size:11px;margin-bottom:4px">Removed (${rosterDiff.removed.length})</div>${rosterChips(rosterDiff.removed, '#7f1d1d', '#fca5a5')}</div>` : ''}
              ${rosterDiff.toggled_on.length > 0 ? `<div><div style="color:#93c5fd;font-size:11px;margin-bottom:4px">Toggled On (${rosterDiff.toggled_on.length})</div>${rosterChips(rosterDiff.toggled_on, '#1e3a5f', '#93c5fd')}</div>` : ''}
              ${rosterDiff.toggled_off.length > 0 ? `<div><div style="color:#fdba74;font-size:11px;margin-bottom:4px">Toggled Off (${rosterDiff.toggled_off.length})</div>${rosterChips(rosterDiff.toggled_off, '#422006', '#fdba74')}</div>` : ''}
            </div>`}
      </div>`
    : '';

  // ── Promotion Readiness Top 5 ──
  // Surfaced high so a glance at /report tells you which strategies are
  // closest to clearing the SOL-accumulation bar. Lifetime data; bar +
  // composite score live in computeDailyReport (daily-report.ts).
  const readinessRows = todayAuto.promotion_readiness_top5 || [];
  const readinessHtml = `<div class="card">
    <h2>Promotion Readiness — Top 5 Closest to Bar</h2>
    <div class="desc">Composite 0–100 score against the SOL bar (n≥100 · drop_top3&gt;0 · total≥0.5 SOL · monthly≥3.75 SOL). Lifetime data, not today-only. Source: leave-one-out-pnl.json.</div>
    ${readinessRows.length === 0
      ? `<div style="color:#64748b;font-style:italic">No enabled strategies with closed trades yet.</div>`
      : `<table><thead><tr>
          <th>Strategy</th>
          <th style="text-align:right">Score</th>
          <th style="text-align:right">N</th>
          <th style="text-align:right">Net SOL</th>
          <th style="text-align:right">Drop top1</th>
          <th style="text-align:right">Drop top3</th>
          <th style="text-align:right">SOL/mo</th>
          <th style="text-align:right">WR</th>
          <th style="text-align:center">Gates</th>
        </tr></thead><tbody>
          ${readinessRows.map((r: any) => {
            const g = r.gates || {};
            const gateCell = (label: string, ok: boolean) =>
              `<span style="display:inline-block;margin:0 2px;padding:1px 4px;border-radius:3px;font-size:10px;background:${ok ? '#14532d' : '#3f1212'};color:${ok ? '#86efac' : '#fca5a5'}">${label}</span>`;
            const gates = gateCell('n', g.n_trades_ge_100)
              + gateCell('drop3', g.drop_top3_positive)
              + gateCell('SOL', g.total_net_sol_ge_0_5)
              + gateCell('mo', g.monthly_run_rate_ge_3_75);
            const promotableBadge = r.promotable
              ? ` <span style="color:#4ade80;font-size:10px">★ promotable</span>`
              : '';
            const cls = (v: number | null | undefined): string =>
              v == null ? '' : v > 0 ? 'green' : v < 0 ? 'red' : '';
            const fmt = (v: number | null | undefined, d = 3): string =>
              v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);
            const raw = r.raw || {};
            return `<tr>
              <td>${escapeHtml(r.label)}${promotableBadge}<br><span style="color:#64748b;font-size:10px">${escapeHtml(r.execution_mode)}</span></td>
              <td style="text-align:right;font-weight:600">${(r.readiness_score ?? 0).toFixed(0)}</td>
              <td style="text-align:right">${raw.n_trades ?? 0}</td>
              <td style="text-align:right" class="${cls(raw.total_net_sol)}">${fmt(raw.total_net_sol)}</td>
              <td style="text-align:right" class="${cls(raw.total_net_sol_drop_top1)}">${fmt(raw.total_net_sol_drop_top1)}</td>
              <td style="text-align:right" class="${cls(raw.total_net_sol_drop_top3)}">${fmt(raw.total_net_sol_drop_top3)}</td>
              <td style="text-align:right" class="${cls(raw.monthly_run_rate_sol)}">${fmt(raw.monthly_run_rate_sol, 2)}</td>
              <td style="text-align:right">${raw.win_rate_pct != null ? raw.win_rate_pct.toFixed(0) + '%' : '—'}</td>
              <td style="text-align:center">${gates}</td>
            </tr>`;
          }).join('')}
        </tbody></table>`}
  </div>`;

  // ── Lessons learned ──
  const lessonsHtml = lessons.length > 0
    ? `<div class="card">
        <h2>Lessons Learned (institutional memory)</h2>
        <div class="desc">Long-running insights confirmed across many sessions. Edit with lesson-upsert / lesson-archive.</div>
        ${lessons.map(l => `<details style="border:1px solid #333;border-radius:4px;margin:6px 0;padding:8px 12px">
          <summary style="cursor:pointer;color:#a5b4fc;font-weight:600">${escapeHtml(l.title)}</summary>
          <div style="margin-top:8px;color:#cbd5e1">${renderMarkdownLite(l.body)}</div>
        </details>`).join('')}
      </div>`
    : `<div class="card">
        <h2>Lessons Learned (institutional memory)</h2>
        <div class="desc">Empty. Push lesson-upsert via strategy-commands.json to seed institutional memory.</div>
      </div>`;

  // ── Open Action Items (unified panel) ──
  // Single consolidated panel combining Claude's proposals + auto-detected
  // anomalies. Each row has inline Dismiss + Edit buttons. The old separate
  // "Recommendations" and "Anomalies & Alerts" panels are removed — they
  // overlapped in meaning and made the page noisy.
  const unifiedItems: any[] = data.unified_action_items || [];
  const renderUnifiedRow = (item: any): string => {
    const kindColors: Record<string, [string, string]> = {
      kill: ['#7f1d1d', '#fca5a5'],
      promote: ['#14532d', '#86efac'],
      watch: ['#422006', '#fdba74'],
      create_new: ['#1e3a5f', '#93c5fd'],
      fix: ['#3b2106', '#fcd34d'],
      update: ['#262640', '#a5b4fc'],
      anomaly: ['#1e1b4b', '#c4b5fd'],
      edge_decay: ['#1e1b4b', '#c4b5fd'],
      exit_mix_shift: ['#1e1b4b', '#c4b5fd'],
      strict_filter: ['#1e1b4b', '#c4b5fd'],
      graduation_rate_drop: ['#3f1212', '#fca5a5'],
      bot_error: ['#3f1212', '#fca5a5'],
    };
    const [kbg, kfg] = kindColors[item.kind] ?? ['#262640', '#a5b4fc'];
    const statusBg = item.source === 'anomaly' ? '#1e1b4b' : undefined;
    const staleBadge = item.stale
      ? ` <span class="badge" style="background:#3f1212;color:#fca5a5;font-size:10px" title="Target absent from strategies.json — likely already removed">stale</span>`
      : '';
    const rowBg = item.stale ? 'background:#1a0c0c;' : item.source === 'anomaly' ? 'background:#0e0d1f;' : '';
    // Inline rows carry the full text payload via data attributes so the
    // copy buttons can grab a plain-text representation without re-parsing
    // the cell DOM. Format mirrors what an operator would paste into an AI
    // session — kind • target • summary, one item per block.
    const copyText = `[${item.kind}] ${item.target_id ?? '—'}: ${item.summary}`;
    return `<tr data-item-id="${escapeHtml(item.id)}" data-item-source="${item.source}" data-item-date="${escapeHtml(item.from_date ?? '')}" data-item-text="${escapeHtml(copyText)}" style="${rowBg}">
      <td>${statusBadge(item.status)}${staleBadge}</td>
      <td><span class="badge" style="background:${kbg};color:${kfg}">${escapeHtml(item.kind)}</span></td>
      <td style="font-family:monospace;font-size:11px">${escapeHtml(item.target_id ?? '')}</td>
      <td class="ai-summary" contenteditable="false">${escapeHtml(item.summary)}</td>
      <td style="color:#64748b;font-size:11px">${escapeHtml(item.from_date ?? (item.source === 'anomaly' ? 'auto' : ''))}</td>
      <td style="white-space:nowrap">
        <button class="ai-copy-btn" type="button" style="background:#1e1b4b;color:#c4b5fd;border:1px solid #312e81;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px;margin-right:4px" title="Copy this item">Copy</button>
        ${item.source === 'claude'
          ? `<button class="ai-edit-btn" type="button" style="background:#262640;color:#a5b4fc;border:1px solid #3a3a5a;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px;margin-right:4px">Edit</button>`
          : ''}
        <button class="ai-dismiss-btn" type="button" style="background:#3f1212;color:#fca5a5;border:1px solid #7f1d1d;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px">Dismiss</button>
      </td>
    </tr>`;
  };
  const actionItemsHtml = `<div class="card">
    <h2>Open Action Items <span id="ai-count" style="font-size:12px;color:#64748b;font-weight:400">(${unifiedItems.length})</span></h2>
    <div class="desc">Claude proposals + auto-detected anomalies in one table. Click <em>Dismiss</em> to mark a proposal EXECUTED (or suppress an anomaly for 24h). Click <em>Edit</em> to inline-edit a proposal's kind / target / summary. <em>Copy</em> grabs an item as plain text for an AI session. Red rows = target absent from strategies.json (likely already removed).</div>
    ${unifiedItems.length === 0
      ? `<div style="color:#64748b;font-style:italic;padding:8px 0">No open action items.</div>`
      : `<div style="margin-bottom:8px;display:flex;gap:8px">
          <button id="ai-copy-all-btn" type="button" style="background:#1e1b4b;color:#c4b5fd;border:1px solid #312e81;border-radius:3px;padding:4px 10px;cursor:pointer;font-size:12px">Copy all</button>
          <button id="ai-clear-all-btn" type="button" style="background:#3f1212;color:#fca5a5;border:1px solid #7f1d1d;border-radius:3px;padding:4px 10px;cursor:pointer;font-size:12px">Dismiss all</button>
          <span id="ai-bulk-status" style="color:#64748b;font-size:11px;align-self:center"></span>
        </div>
        <table id="action-items-table"><thead><tr>
          <th>Status</th><th>Kind</th><th>Target</th><th>Summary</th><th>From</th><th>Actions</th>
        </tr></thead><tbody>${unifiedItems.map(renderUnifiedRow).join('')}</tbody></table>
        <script>
          (function(){
            var table = document.getElementById('action-items-table');
            if (!table) return;
            var KIND_OPTIONS = ['kill','promote','watch','create_new','fix','update'];
            function copyToClipboard(text, statusEl){
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function(){
                  if (statusEl) { statusEl.textContent = 'copied ' + text.length + ' chars'; setTimeout(function(){ statusEl.textContent = ''; }, 2000); }
                }).catch(function(){ fallbackCopy(text, statusEl); });
              } else {
                fallbackCopy(text, statusEl);
              }
            }
            function fallbackCopy(text, statusEl){
              var ta = document.createElement('textarea');
              ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              try { document.execCommand('copy'); if (statusEl) statusEl.textContent = 'copied (fallback)'; } catch(_){ alert('Copy failed; select manually.'); }
              document.body.removeChild(ta);
              if (statusEl) setTimeout(function(){ statusEl.textContent = ''; }, 2000);
            }
            function dismiss(row, opts){
              opts = opts || {};
              var id = row.getAttribute('data-item-id');
              var source = row.getAttribute('data-item-source');
              var date = row.getAttribute('data-item-date');
              var url = source === 'anomaly'
                ? '/api/anomaly/dismiss'
                : '/api/action-item/' + encodeURIComponent(date) + '/' + encodeURIComponent(id) + '/dismiss';
              var body = source === 'anomaly'
                ? { id: id }
                : { status: 'EXECUTED' };
              return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                .then(function(r){
                  if (r.ok) { row.style.opacity = '0.3'; row.style.textDecoration = 'line-through'; return true; }
                  if (!opts.silent) alert('Dismiss failed: ' + r.status);
                  return false;
                })
                .catch(function(e){ if (!opts.silent) alert('Dismiss error: ' + e); return false; });
            }
            function startEdit(row){
              var id = row.getAttribute('data-item-id');
              var date = row.getAttribute('data-item-date');
              var summaryCell = row.querySelector('td.ai-summary');
              var kindCell = row.cells[1];
              summaryCell.contentEditable = 'true';
              summaryCell.style.background = '#1e1b4b';
              summaryCell.focus();
              // Replace kind badge with select
              var currentKind = kindCell.textContent.trim();
              kindCell.innerHTML = '<select style="background:#13131f;color:#cbd5e1;border:1px solid #3a3a5a;border-radius:3px">' +
                KIND_OPTIONS.map(function(k){ return '<option value="' + k + '"' + (k === currentKind ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>';
              // Swap Edit button → Save
              var btn = row.querySelector('.ai-edit-btn');
              btn.textContent = 'Save';
              btn.classList.remove('ai-edit-btn');
              btn.classList.add('ai-save-btn');
              btn.onclick = function(){ saveEdit(row, id, date); };
            }
            function saveEdit(row, id, date){
              var summaryCell = row.querySelector('td.ai-summary');
              var kindCell = row.cells[1];
              var newSummary = summaryCell.textContent.trim();
              var sel = kindCell.querySelector('select');
              var newKind = sel ? sel.value : '';
              fetch('/api/action-item/' + encodeURIComponent(date) + '/' + encodeURIComponent(id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: newKind, summary: newSummary })
              }).then(function(r){
                if (r.ok) { location.reload(); } else { alert('Save failed: ' + r.status); }
              }).catch(function(e){ alert('Save error: ' + e); });
            }
            var bulkStatus = document.getElementById('ai-bulk-status');
            table.addEventListener('click', function(e){
              var target = e.target;
              if (!target.classList) return;
              if (target.classList.contains('ai-dismiss-btn')) {
                dismiss(target.closest('tr'));
              } else if (target.classList.contains('ai-edit-btn')) {
                startEdit(target.closest('tr'));
              } else if (target.classList.contains('ai-copy-btn')) {
                var row = target.closest('tr');
                copyToClipboard(row.getAttribute('data-item-text') || '', bulkStatus);
              }
            });
            // Copy all open items as a bulleted list, ready to paste into an
            // AI session. Skips rows already marked dismissed (opacity 0.3).
            var copyAllBtn = document.getElementById('ai-copy-all-btn');
            if (copyAllBtn) copyAllBtn.addEventListener('click', function(){
              var rows = Array.from(table.querySelectorAll('tbody tr'))
                .filter(function(r){ return r.style.opacity !== '0.3'; });
              var text = rows.map(function(r){ return '- ' + (r.getAttribute('data-item-text') || ''); }).join('\\n');
              copyToClipboard(text, bulkStatus);
            });
            // Dismiss all — fires sequentially, updates status as it goes.
            // Claude proposals → EXECUTED, anomalies → 24h suppression.
            var clearAllBtn = document.getElementById('ai-clear-all-btn');
            if (clearAllBtn) clearAllBtn.addEventListener('click', function(){
              if (!confirm('Dismiss every open action item? Claude proposals will be marked EXECUTED; anomalies suppressed for 24h.')) return;
              var rows = Array.from(table.querySelectorAll('tbody tr'))
                .filter(function(r){ return r.style.opacity !== '0.3'; });
              if (rows.length === 0) { bulkStatus.textContent = 'nothing to dismiss'; return; }
              clearAllBtn.disabled = true;
              bulkStatus.textContent = 'dismissing 0 / ' + rows.length;
              var done = 0;
              rows.reduce(function(p, row){
                return p.then(function(){
                  return dismiss(row, { silent: true }).then(function(){
                    done += 1;
                    bulkStatus.textContent = 'dismissing ' + done + ' / ' + rows.length;
                  });
                });
              }, Promise.resolve()).then(function(){
                bulkStatus.textContent = 'dismissed ' + done + ' / ' + rows.length;
                clearAllBtn.disabled = false;
              });
            });
          })();
        </script>`}
  </div>`;

  // ── Today's narrative ──
  const narrativeHtml = `<div class="card">
    <h2>Today's Narrative</h2>
    <div class="desc">Free-form Claude commentary for ${escapeHtml(todayAuto.date || '')}. Pushed via report-upsert.</div>
    ${todayReport?.narrative
      ? `<div style="color:#cbd5e1;line-height:1.5">${renderMarkdownLite(todayReport.narrative)}</div>`
      : `<div style="color:#64748b;font-style:italic">No narrative yet today. Run /daily-report.</div>`}
    ${todayReport?.updates && todayReport.updates.length > 0
      ? `<h3>Updates</h3><ul>${todayReport.updates.map((u: any) => `<li><span style="color:#64748b;font-size:11px">${new Date(u.at * 1000).toISOString()}</span> — ${escapeHtml(u.note)}</li>`).join('')}</ul>`
      : ''}
  </div>`;

  // ── By-strategy snapshot ──
  // Composite readiness score is the headline metric (per CLAUDE.md: median
  // is a distribution-shape diagnostic, not an evaluation primary). Each
  // strategy_id can appear twice — once per execution_mode (paper / shadow) —
  // because leave-one-out partitions by both. The "key" attribute on each
  // row encodes the composite (strategy_id|mode) so the time-series expand
  // panel and the inline sort handler can disambiguate.
  // Build per-(strategy, mode) history series (oldest → newest) for the
  // expand-row mini-charts. recent_reports is most-recent-first, so reverse.
  const modeKey2 = (sid: string, mode: string | undefined): string => `${sid}|${mode ?? 'paper'}`;
  const historyByKey = new Map<string, any[]>();
  // Mode-blind fallback index: legacy snapshots (written before the 2026-05-14
  // mode-aware fix) didn't carry execution_mode. When the composite-key
  // lookup misses for a strategy/mode that exists today, fall through to the
  // strategy_id-only key so the chart still picks up historical data.
  const historyByStrategyOnly = new Map<string, any[]>();
  const orderedDays2 = [...recentReports].reverse();
  for (const day of orderedDays2) {
    const dayStats = day?.summary?.by_strategy_daily;
    if (!Array.isArray(dayStats)) continue;
    for (const stat of dayStats) {
      const k = modeKey2(stat.strategy_id, stat.execution_mode);
      const series = historyByKey.get(k) || [];
      series.push({ date: day.date, ...stat });
      historyByKey.set(k, series);

      const sidOnly = stat.strategy_id;
      const sidSeries = historyByStrategyOnly.get(sidOnly) || [];
      sidSeries.push({ date: day.date, ...stat });
      historyByStrategyOnly.set(sidOnly, sidSeries);
    }
  }
  for (const t of todaySnap) {
    const k = modeKey2(t.strategy_id, t.execution_mode);
    const series = historyByKey.get(k) || [];
    series.push({ date: todayAuto.date, ...t });
    historyByKey.set(k, series);
  }
  // Resolve a strategy's series with the mode-blind fallback applied.
  const resolveHistory = (sid: string, mode: string | undefined): any[] => {
    const exact = historyByKey.get(modeKey2(sid, mode));
    if (exact && exact.length > 1) return exact;
    const fallback = historyByStrategyOnly.get(sid);
    if (fallback && fallback.length > (exact?.length ?? 0)) return fallback;
    return exact ?? [];
  };

  const fmtSigned = (v: number | null | undefined, d = 3): string =>
    v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);
  const cls = (v: number | null | undefined): string =>
    v == null ? '' : v > 0 ? 'green' : v < 0 ? 'red' : '';
  const modeChip = (mode: string): string => {
    const colors: Record<string, [string, string]> = {
      shadow: ['#1e3a5f', '#93c5fd'],
      paper: ['#262640', '#a5b4fc'],
      live: ['#14532d', '#86efac'],
    };
    const [bg, fg] = colors[mode] ?? ['#262640', '#94a3b8'];
    return `<span class="badge" style="background:${bg};color:${fg};font-size:10px;margin-left:4px">${escapeHtml(mode)}</span>`;
  };

  // Active strategies only — disabled/retired strategies (still tracked in
  // leave-one-out for postmortem) belong in /trading or the archived view,
  // not in the day-over-day comparison panel.
  const sortedSnap = todaySnap
    .filter((s: any) => s.enabled)
    .slice()
    .sort((a: any, b: any) => (b.readiness_score ?? -Infinity) - (a.readiness_score ?? -Infinity));

  const decayChip = (flag: string | null | undefined): string => {
    if (!flag || flag === 'STABLE' || flag === 'LOW-N') return '';
    const [bg, fg, label] = flag === 'DECAYING'
      ? ['#3f1212', '#fca5a5', '↓ DECAY']
      : ['#14532d', '#86efac', '↑ STRENGTH'];
    return ` <span class="badge" style="background:${bg};color:${fg};font-size:10px" title="edge-decay flag — folded into the composite score as ${flag === 'DECAYING' ? '−15' : '+5'} points">${label}</span>`;
  };

  const byStrategyRows = sortedSnap.map((s: any) => {
    const k = modeKey2(s.strategy_id, s.execution_mode);
    const promotableBadge = s.promotable
      ? ` <span style="color:#4ade80;font-size:10px" title="all four SOL-bar gates clear">★</span>` : '';
    const series = resolveHistory(s.strategy_id, s.execution_mode);
    const charts = series.length > 1 ? `
      ${renderMiniTimeseries(series.map(p => p.readiness_score ?? null), 'Readiness', '#a5b4fc', v => v.toFixed(0))}
      ${renderMiniTimeseries(series.map(p => p.n_trades_lifetime ?? null), 'N (lifetime)', '#93c5fd', v => v.toFixed(0))}
      ${renderMiniTimeseries(series.map(p => p.total_net_sol_lifetime ?? null), 'Net SOL (lifetime)', '#86efac', v => (v > 0 ? '+' : '') + v.toFixed(3))}
      ${renderMiniTimeseries(series.map(p => p.total_net_sol_drop_top3 ?? null), 'Drop3 SOL', '#fdba74', v => (v > 0 ? '+' : '') + v.toFixed(3))}
    ` : `<div style="color:#64748b;font-size:11px;padding:8px">History accumulating — run the backfill (npx ts-node src/api/backfill-snapshot.ts) or wait for a few /daily-report cycles.</div>`;
    // Compact multi-value cells: stack today / yest / high / low as small
    // labeled rows inside each cell. data-sort-* attributes drive the
    // sortable JS — sort is by today's value when sorted by Score column,
    // and by lifetime/all-time when those columns are clicked.
    const scoreCell = `
      <div style="display:flex;flex-direction:column;gap:1px;text-align:right;font-size:11px;line-height:1.3">
        <div><span style="color:#64748b">tdy</span> <strong style="font-size:13px">${s.readiness_score != null ? s.readiness_score.toFixed(0) : '—'}</strong></div>
        <div><span style="color:#64748b">yst</span> ${s.readiness_score_yesterday != null ? s.readiness_score_yesterday.toFixed(0) : '—'}</div>
        <div><span style="color:#86efac">hi</span> ${s.readiness_score_alltime_high != null ? s.readiness_score_alltime_high.toFixed(0) : '—'}</div>
        <div><span style="color:#fca5a5">lo</span> ${s.readiness_score_alltime_low != null ? s.readiness_score_alltime_low.toFixed(0) : '—'}</div>
      </div>`;
    const nCell = `
      <div style="display:flex;flex-direction:column;gap:1px;text-align:right;font-size:11px;line-height:1.3">
        <div><span style="color:#64748b">tdy</span> <strong style="font-size:13px">${s.n_trades_today ?? 0}</strong></div>
        <div><span style="color:#64748b">yst</span> ${s.n_trades_yesterday ?? 0}</div>
        <div><span style="color:#94a3b8">all</span> ${s.n_trades_lifetime ?? 0}</div>
      </div>`;
    return `<tr class="strat-row" data-strategy-key="${escapeHtml(k)}"
        data-sort-score-today="${s.readiness_score ?? -1}"
        data-sort-score-yest="${s.readiness_score_yesterday ?? -1}"
        data-sort-score-high="${s.readiness_score_alltime_high ?? -1}"
        data-sort-score-low="${s.readiness_score_alltime_low ?? -1}"
        data-sort-n-today="${s.n_trades_today ?? 0}"
        data-sort-n-yest="${s.n_trades_yesterday ?? 0}"
        data-sort-n-life="${s.n_trades_lifetime ?? 0}"
        data-sort-netsol-today="${s.net_sol_today ?? 0}"
        data-sort-netsol-life="${s.total_net_sol_lifetime ?? 0}"
        data-sort-drop3="${s.total_net_sol_drop_top3 ?? 0}"
        data-sort-monthly="${s.monthly_run_rate_sol ?? 0}"
        style="cursor:pointer">
      <td>${escapeHtml(s.label)}${modeChip(s.execution_mode || 'paper')}${promotableBadge}${decayChip(s.edge_flag)}<br><span style="color:#64748b;font-size:10px">${escapeHtml(s.strategy_id)}</span></td>
      <td>${scoreCell}</td>
      <td>${nCell}</td>
      <td style="text-align:right" class="${cls(s.net_sol_today)}">${fmtSigned(s.net_sol_today, 3)}</td>
      <td style="text-align:right" class="${cls(s.total_net_sol_lifetime)}">${fmtSigned(s.total_net_sol_lifetime, 3)}</td>
      <td style="text-align:right" class="${cls(s.total_net_sol_drop_top3)}">${fmtSigned(s.total_net_sol_drop_top3, 3)}</td>
      <td style="text-align:right" class="${cls(s.monthly_run_rate_sol)}">${fmtSigned(s.monthly_run_rate_sol, 2)}</td>
    </tr>
    <tr class="strat-detail" data-strategy-key="${escapeHtml(k)}" style="display:none">
      <td colspan="7" style="background:#0f0f17;padding:8px 12px">${charts}</td>
    </tr>`;
  }).join('');

  // Sortable header — clicking a column header sorts the table by the
  // data-sort-* attribute on each row. Detail rows stay paired with their
  // parent via a "follow your sibling" reorder. Clicking again reverses.
  const sortableHeader = `<thead><tr>
    <th data-sort-key="label" style="cursor:pointer">Strategy [mode] ▾</th>
    <th data-sort-key="score-today" data-default-desc="1" style="text-align:right;cursor:pointer">Score (tdy/yst/hi/lo) ▾</th>
    <th data-sort-key="n-today" data-default-desc="1" style="text-align:right;cursor:pointer">N (tdy/yst/all) ▾</th>
    <th data-sort-key="netsol-today" data-default-desc="1" style="text-align:right;cursor:pointer">Net SOL today</th>
    <th data-sort-key="netsol-life" data-default-desc="1" style="text-align:right;cursor:pointer">Net SOL life</th>
    <th data-sort-key="drop3" data-default-desc="1" style="text-align:right;cursor:pointer">Drop3 SOL</th>
    <th data-sort-key="monthly" data-default-desc="1" style="text-align:right;cursor:pointer">SOL/mo</th>
  </tr></thead>`;

  const byStrategyHtml = `<div class="card">
    <h2>By Strategy (today vs yesterday)</h2>
    <div class="desc">Composite readiness score is the headline metric (median is a diagnostic only — see CLAUDE.md). Score and N cells show today / yesterday / all-time high / all-time low. Click any column to sort. Click any row to expand a per-strategy history chart.</div>
    ${sortedSnap.length > 0
      ? `<table id="strat-table">${sortableHeader}<tbody>${byStrategyRows}</tbody></table>
        <script>
          (function(){
            var table = document.getElementById('strat-table');
            if (!table) return;
            var tbody = table.tBodies[0];
            // Expand-row toggle
            tbody.querySelectorAll('tr.strat-row').forEach(function(row){
              row.addEventListener('click', function(){
                var key = row.getAttribute('data-strategy-key');
                var detail = tbody.querySelector('tr.strat-detail[data-strategy-key="' + key + '"]');
                if (detail) detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
              });
            });
            // Sortable columns — pair each .strat-row with its .strat-detail
            // sibling, sort the pair array, re-append in order.
            function getPairs() {
              var rows = Array.from(tbody.querySelectorAll('tr.strat-row'));
              return rows.map(function(r){
                var key = r.getAttribute('data-strategy-key');
                var d = tbody.querySelector('tr.strat-detail[data-strategy-key="' + key + '"]');
                return { row: r, detail: d };
              });
            }
            var sortState = { key: 'score-today', dir: 'desc' };
            function applySort(){
              var pairs = getPairs();
              var k = sortState.key;
              pairs.sort(function(a, b){
                var va, vb;
                if (k === 'label') {
                  va = a.row.cells[0].textContent.trim().toLowerCase();
                  vb = b.row.cells[0].textContent.trim().toLowerCase();
                  return sortState.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                }
                va = parseFloat(a.row.getAttribute('data-sort-' + k) || '0');
                vb = parseFloat(b.row.getAttribute('data-sort-' + k) || '0');
                if (isNaN(va)) va = -1e18;
                if (isNaN(vb)) vb = -1e18;
                return sortState.dir === 'asc' ? va - vb : vb - va;
              });
              pairs.forEach(function(p){ tbody.appendChild(p.row); tbody.appendChild(p.detail); });
            }
            table.querySelectorAll('th[data-sort-key]').forEach(function(th){
              th.addEventListener('click', function(){
                var k = th.getAttribute('data-sort-key');
                if (sortState.key === k) {
                  sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
                } else {
                  sortState.key = k;
                  sortState.dir = th.getAttribute('data-default-desc') ? 'desc' : 'asc';
                }
                applySort();
              });
            });
          })();
        </script>`
      : `<div style="color:#64748b;font-style:italic">No active strategies with snapshot data yet.</div>`}
  </div>`;

  // ── Winners / Losers ──
  const winnersHtml = `<div class="card">
    <h2>Winners / Losers (top 5 each, today)</h2>
    <div class="desc">Top gross-return trades. Use for outlier inspection — single +700% trades have misled us before.</div>
    <h3 class="green">Top Winners</h3>
    ${renderTradeTable(todayAuto.winners || [], 'No winning trades today.')}
    <h3 class="red">Top Losers</h3>
    ${renderTradeTable(todayAuto.losers || [], 'No losing trades today.')}
  </div>`;

  // Anomalies and Recommendations panels removed — they're folded into the
  // unified Open Action Items table above.

  // ── Recent Reports (last 3) ──
  // Refocused on Net SOL + readiness composite per operator request. # Killed
  // Since Last is computed by diffing adjacent active_strategies_snapshots —
  // null when either side's snapshot is missing (pre-rollout rows).
  const recentTrimmed = recentReports.slice(0, 3);
  const killCountForRow = (idx: number): number | null => {
    // recent[idx] is "more recent". Compare its snapshot against recent[idx+1].
    const newer = recentReports[idx]?.summary?.active_strategies_snapshot;
    const older = recentReports[idx + 1]?.summary?.active_strategies_snapshot;
    if (!Array.isArray(newer) || !Array.isArray(older)) return null;
    const newerIds = new Map(newer.map((s: any) => [s.strategy_id, s]));
    let removed = 0;
    for (const s of older) {
      const cur = newerIds.get(s.strategy_id);
      if (!cur) removed++;
      else if (s.enabled && !cur.enabled) removed++;
    }
    return removed;
  };
  const historyHtml = `<div class="card">
    <h2>Recent Reports (last ${recentTrimmed.length})</h2>
    <div class="desc">Day-over-day summary. Focused on Net SOL + composite readiness — median is no longer a primary header.</div>
    ${recentTrimmed.length === 0
      ? `<div style="color:#64748b;font-style:italic">No prior reports yet.</div>`
      : `<table><thead><tr>
          <th>Date</th>
          <th style="text-align:right">Net SOL</th>
          <th style="text-align:right">Avg Score</th>
          <th style="text-align:right"># Promotable</th>
          <th style="text-align:right"># Killed Since Last</th>
          <th>By</th><th>Narrative</th>
        </tr></thead><tbody>
          ${recentTrimmed.map((r, i) => {
            const netSol = r.summary?.net_profit_sol;
            const avgScore = r.summary?.avg_readiness_score;
            const nPromo = r.summary?.n_promotable;
            const killed = killCountForRow(i);
            return `<tr>
              <td>${escapeHtml(r.date)}</td>
              <td style="text-align:right" class="${cls(netSol)}">${netSol == null ? '—' : (netSol > 0 ? '+' : '') + netSol.toFixed(3)}</td>
              <td style="text-align:right">${avgScore == null ? '—' : avgScore.toFixed(1)}</td>
              <td style="text-align:right">${nPromo == null ? '—' : nPromo}</td>
              <td style="text-align:right${killed != null && killed > 0 ? ';color:#fca5a5' : ''}">${killed == null ? '—' : killed}</td>
              <td style="color:#94a3b8">${escapeHtml(r.generated_by ?? '—')}</td>
              <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((r.narrative || '').slice(0, 120))}${(r.narrative || '').length > 120 ? '…' : ''}</td>
            </tr>`;
          }).join('')}
        </tbody></table>`}
  </div>`;

  // ── Weekly aggregates ──
  // Net SOL is the headline (median demoted). Top 3 by Score is a lifetime
  // metric so it repeats across weeks; Bottom 3 by Net SOL is per-week and
  // surfaces the biggest bleeders for that window specifically.
  const weeklyHtml = `<div class="card">
    <h2>Weekly Aggregates (last ${weekly.length} weeks)</h2>
    <div class="desc">ISO week buckets ending Sunday. Headline: portfolio Net SOL. Top 3 by Score is lifetime (same across weeks); Bottom 3 by Net SOL is per-week.</div>
    ${weekly.length === 0
      ? `<div style="color:#64748b;font-style:italic">No data yet.</div>`
      : (() => {
          const rows = weekly.map((w, i) => {
            const prev = weekly[i + 1];
            const deltaSol = w.net_profit_sol != null && prev?.net_profit_sol != null
              ? +(w.net_profit_sol - prev.net_profit_sol).toFixed(3) : null;
            const top3 = (w.top3_by_score || [])
              .map((r: any) => rosterChip(`${r.label} (${r.score.toFixed(0)})`, '#1e3a5f', '#93c5fd', r.strategy_id))
              .join('') || `<span style="color:#64748b;font-size:11px">—</span>`;
            const bottom3 = (w.bottom3_by_net_sol || [])
              .map((r: any) => rosterChip(`${r.label} (${(r.net_sol > 0 ? '+' : '') + r.net_sol.toFixed(2)})`, '#7f1d1d', '#fca5a5', r.strategy_id))
              .join('') || `<span style="color:#64748b;font-size:11px">no losers</span>`;
            return `<tr>
              <td>${escapeHtml(w.iso_week)}</td>
              <td style="color:#94a3b8;font-size:11px">${escapeHtml(w.start_date)} → ${escapeHtml(w.end_date)}</td>
              <td style="text-align:right">${w.n_trades}</td>
              <td style="text-align:right" class="${cls(w.net_profit_sol)}">${w.net_profit_sol != null ? (w.net_profit_sol > 0 ? '+' : '') + w.net_profit_sol.toFixed(3) : '—'}</td>
              <td style="text-align:right" class="${cls(deltaSol)}">${deltaSol == null ? '—' : (deltaSol > 0 ? '+' : '') + deltaSol.toFixed(3)}</td>
              <td>${top3}</td>
              <td>${bottom3}</td>
            </tr>`;
          }).join('');
          return `<table><thead><tr>
            <th>Week</th><th>Range</th>
            <th style="text-align:right">N</th>
            <th style="text-align:right">Net SOL</th>
            <th style="text-align:right">Δ vs prev</th>
            <th>Top 3 by Score</th>
            <th>Bottom 3 by Net SOL</th>
          </tr></thead><tbody>${rows}</tbody></table>`;
        })()}
  </div>`;

  const body = headerHtml
    + readinessHtml
    + actionItemsHtml
    + lessonsHtml
    + narrativeHtml
    + byStrategyHtml
    + winnersHtml
    + historyHtml
    + weeklyHtml
    + rosterHtml; // Roster Changes pinned at the bottom per operator request.

  return shell('Daily Report', '/report', body, data);
}
