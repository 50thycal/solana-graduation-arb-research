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
  { path: '/price-path', label: 'Price Path' },
  { path: '/tokens?label=PUMP&min_sol=80', label: 'Tokens' },
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

  // Scorecard
  const sc = d.scorecard;
  const scorecard = `
  <div class="card">
    <h2>Thesis Scorecard</h2>
    <div class="desc">Core thesis: "Post-graduation PumpFun token momentum is tradeable." PUMP = >+10% at T+300, DUMP = <-10%. Win rate = PUMP / total labeled.</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Total Labeled</span><span class="value">${sc.total_labeled}</span></div>
        <div class="stat"><span class="label">PUMP</span><span class="value green">${sc.PUMP}</span></div>
        <div class="stat"><span class="label">DUMP</span><span class="value red">${sc.DUMP}</span></div>
        <div class="stat"><span class="label">STABLE</span><span class="value yellow">${sc.STABLE}</span></div>
        <div class="stat"><span class="label">Raw Win Rate</span><span class="value">${wr(sc.raw_win_rate_pct)}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Best Filter</span><span class="value blue">${sc.best_filter?.name || '—'}</span></div>
        <div class="stat"><span class="label">Best Filter T+30 Profit%</span><span class="value">${wr(sc.best_filter?.t30_profitable_rate ?? sc.best_filter?.win_rate)}</span></div>
        <div class="stat"><span class="label">Sample Size</span><span class="value">${sc.best_filter?.sample_size || '—'}</span></div>
        <div class="stat"><span class="label">Unlabeled</span><span class="value">${sc.unlabeled}</span></div>
        <div class="stat"><span class="label">Samples to 30</span><span class="value">${sc.samples_remaining}</span></div>
      </div>
    </div>
  </div>`;

  // Verdict
  const verdict = `
  <div class="card" style="border-color:#2563eb">
    <h2>Thesis Verdict</h2>
    <div style="font-size:14px;padding:8px 0;color:#e2e8f0">${d.thesis_verdict}</div>
  </div>`;

  // T+30 momentum signal
  const t30 = d.t30_momentum_signal;
  const t30Signal = `
  <div class="card">
    <h2>T+30 Momentum Signal</h2>
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

  const body = header + verdict + scorecard + t30Signal + trajectory + last10 + quality + pathSummary;
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
      'The only positive-EV strategies. SL: 20% adverse gap. TP: 10% adverse gap. SL checked first (conservative). Round-trip slippage on all exits.',
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
const SL_GAP = 0.20;
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
      if (cpv <= slLevel) { exit = -(slPct * (1 + SL_GAP)); break; }
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

export function renderFilterV2Html(data: any): string {
  const panel1 = data.panel1;
  const baseline: FilterV2Row = panel1.baseline;
  const filters: FilterV2Row[] = panel1.filters || [];
  const lowN = panel1.flags?.low_n_threshold ?? 20;
  const strongN = panel1.flags?.strong_n_threshold ?? 100;

  // Group filters by family for visual grouping
  const groups = new Map<string, FilterV2Row[]>();
  for (const f of filters) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group)!.push(f);
  }

  const baselineRow = v2RowHtml(baseline, lowN, strongN, true);

  const groupRows: string[] = [];
  for (const [groupName, rows] of groups) {
    groupRows.push(`<tr class="row-group-header"><td colspan="7">${groupName}</td></tr>`);
    for (const r of rows) groupRows.push(v2RowHtml(r, lowN, strongN, false));
  }

  const tableHtml = `
  <table id="panel1-table">
    <thead>
      <tr>
        <th class="sortable" onclick="sortPanel1(0,'str')">Filter <span class="arrow">⇅</span></th>
        <th class="sortable" onclick="sortPanel1(1,'num')">n (applicable) <span class="arrow">⇅</span></th>
        <th class="sortable" onclick="sortPanel1(2,'num')">PUMP <span class="arrow">⇅</span></th>
        <th class="sortable" onclick="sortPanel1(3,'num')">DUMP <span class="arrow">⇅</span></th>
        <th class="sortable" onclick="sortPanel1(4,'num')">STABLE <span class="arrow">⇅</span></th>
        <th class="sortable" onclick="sortPanel1(5,'num')">Win % <span class="arrow">⇅</span></th>
        <th class="sortable" onclick="sortPanel1(6,'num')">PUMP:DUMP <span class="arrow">⇅</span></th>
      </tr>
    </thead>
    <tbody>
      ${baselineRow}
      ${groupRows.join('\n      ')}
    </tbody>
  </table>`;

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
  </div>`;

  const panel1Html = `
  <div class="card">
    <h2>Panel 1 — ${panel1.title}</h2>
    <div class="desc">${panel1.description}</div>
    ${tableHtml}
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

    const groups4 = new Map<string, FilterV2Panel4Row[]>();
    for (const f of filters4) {
      if (!groups4.has(f.group)) groups4.set(f.group, []);
      groups4.get(f.group)!.push(f);
    }

    // Baseline is always row index 0; filter rows start at index 1
    const baselineRow4 = v2Panel4RowHtml(baseline4, lowN4, strongN4, 0, true);
    const groupRows4: string[] = [];
    let rowIdx = 1;
    for (const [groupName, rows] of groups4) {
      groupRows4.push(`<tr class="row-group-header"><td colspan="10">${groupName}</td></tr>`);
      for (const r of rows) {
        groupRows4.push(v2Panel4RowHtml(r, lowN4, strongN4, rowIdx, false));
        rowIdx++;
      }
    }

    const tpOptions = tpLevels.map(v => `<option value="${v}"${v === defaultTp ? ' selected' : ''}>${v}%</option>`).join('');
    const slOptions = slLevels.map(v => `<option value="${v}"${v === defaultSl ? ' selected' : ''}>${v}%</option>`).join('');

    const controls = `
    <div class="p4-controls">
      <label>TP %: <select id="p4-tp" onchange="onPanel4Change()">${tpOptions}</select></label>
      <label>SL %: <select id="p4-sl" onchange="onPanel4Change()">${slOptions}</select></label>
      <span class="desc">SL gap 20% · TP gap 10% · cost: per-token round_trip_slippage_pct (3% fallback)</span>
    </div>`;

    const table4Html = `
    <table id="panel4-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel4(0,'str')">Filter <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(1,'num')">n <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(2,'num')">Sel Avg Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(3,'num')">Sel Med Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(4,'num')">Sel Win % <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(5,'num')">Sel vs Base <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(6,'num')">Opt TP <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(7,'num')">Opt SL <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(8,'num')">Opt Avg Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel4(9,'num')">Opt Win % <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${baselineRow4}
        ${groupRows4.join('\n        ')}
      </tbody>
    </table>`;

    const legend4 = `
    <div class="desc" style="margin-top:10px">
      <strong>Entry:</strong> T+30 (PumpSwap pool price). <strong>Exits scanned:</strong> pct_t40, pct_t50, pct_t60, pct_t90, pct_t120, pct_t150, pct_t180, pct_t240 (SL checked first at each checkpoint, then TP). <strong>Fall-through:</strong> pct_t300.
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
      <strong>URL:</strong> current TP/SL selection is mirrored to the URL hash (<code>#p4=tp30,sl10</code>) so reloads and shared links preserve the view.
      <br>
      <em>Sort by <strong>Opt Avg Ret</strong> descending to surface the best static per-filter optima. Sort by <strong>Sel Avg Ret</strong> descending to surface the best filters at the currently-selected TP/SL.</em>
    </div>`;

    panel4Html = `
    <div class="card">
      <h2>Panel 4 — ${panel4.title}</h2>
      <div class="desc">${panel4.description}</div>
      ${controls}
      ${table4Html}
      ${legend4}
    </div>`;

    // Client data payload — flat arrays for compact encoding
    const clientRows = [
      { combos: baseline4.combos },
      ...filters4.map(f => ({ combos: f.combos })),
    ];
    panel4DataScript = `
  <script>
    window.__PANEL_4 = ${JSON.stringify({
      tp_levels: tpLevels,
      sl_levels: slLevels,
      default_tp: defaultTp,
      default_sl: defaultSl,
      rows: clientRows,
    })};
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

    const topPairsRows = topPairs.length === 0
      ? '<tr><td colspan="8" style="color:#64748b;text-align:center"><em>No two-filter intersections meet the criteria (n ≥ 30 and lift &gt; 0). Collect more data.</em></td></tr>'
      : topPairs.map(p => {
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

    const topPairsTable = `
    <h3 style="margin-top:20px;color:#e2e8f0;font-size:14px">Top 20 two-filter intersections (n ≥ 30, lift &gt; 0, sorted by Opt Avg Ret)</h3>
    <table id="panel6-pairs-table">
      <thead>
        <tr>
          <th class="sortable" onclick="sortPanel6Pairs(0,'str')">Filter A <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel6Pairs(1,'str')">Filter B <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel6Pairs(2,'num')">n <span class="arrow">⇅</span></th>
          <th>Opt TP/SL</th>
          <th class="sortable" onclick="sortPanel6Pairs(4,'num')">Opt Avg Ret <span class="arrow">⇅</span></th>
          <th class="sortable" onclick="sortPanel6Pairs(5,'num')">Opt Win % <span class="arrow">⇅</span></th>
          <th>Singles (A / B)</th>
          <th class="sortable" onclick="sortPanel6Pairs(7,'num')">Lift <span class="arrow">⇅</span></th>
        </tr>
      </thead>
      <tbody>
        ${topPairsRows}
      </tbody>
    </table>`;

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
  function sortPanel1(col, type) { v2GenericSort('panel1-table', col, type); }
  function sortPanel2(col, type) { v2GenericSort('panel2-table', col, type); }
  function sortPanel3(col, type) { v2GenericSort('panel3-table', col, type); }
  function sortPanel4(col, type) { v2GenericSort('panel4-table', col, type); }
  function sortPanel5(col, type) { v2GenericSort('panel5-table', col, type); }
  function sortPanel7(col, type) { v2GenericSort('panel7-table', col, type); }

  // Panel 6 top-pairs table has NO baseline row — use a simpler sort that treats
  // every row as data.
  function sortPanel6Pairs(col, type) {
    var table = document.getElementById('panel6-pairs-table');
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
  function updatePanel4(tp, sl) {
    if (!window.__PANEL_4) return;
    var P = window.__PANEL_4;
    var ti = P.tp_levels.indexOf(tp);
    var si = P.sl_levels.indexOf(sl);
    if (ti === -1 || si === -1) return;
    var idx = ti * P.sl_levels.length + si;
    var baselineAvg = P.rows[0].combos.avg_ret[idx];
    var table = document.getElementById('panel4-table');
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
  function onPanel4Change() {
    var tpSel = document.getElementById('p4-tp');
    var slSel = document.getElementById('p4-sl');
    if (!tpSel || !slSel) return;
    var tp = parseFloat(tpSel.value);
    var sl = parseFloat(slSel.value);
    updatePanel4(tp, sl);
    try { history.replaceState(null, '', '#p4=tp' + tp + ',sl' + sl); } catch (e) {}
  }
  function readPanel4Hash() {
    if (!window.__PANEL_4) return;
    var P = window.__PANEL_4;
    var tp = P.default_tp;
    var sl = P.default_sl;
    var m = (location.hash || '').match(/p4=tp([0-9.]+),sl([0-9.]+)/);
    if (m) {
      var ht = parseFloat(m[1]);
      var hs = parseFloat(m[2]);
      if (P.tp_levels.indexOf(ht) !== -1) tp = ht;
      if (P.sl_levels.indexOf(hs) !== -1) sl = hs;
    }
    var tpSel = document.getElementById('p4-tp');
    var slSel = document.getElementById('p4-sl');
    if (tpSel) tpSel.value = String(tp);
    if (slSel) slSel.value = String(sl);
    updatePanel4(tp, sl);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readPanel4Hash);
  } else {
    readPanel4Hash();
  }
  </script>`;

  const body = panel1Html + panel2Html + panel3Html + panel4Html + panel5Html + panel6Html + panel7Html + panel4DataScript + sortScript;
  return shell('Filter Analysis V2', '/filter-analysis-v2', body, data);
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
    <div class="desc">If we entered at each 5s snapshot instead of T+30, how does avg return change? Gate: +5% to +100% from open. Costs: 20% SL gap, 10% TP gap, round-trip slippage. <b style="color:#60a5fa">Vel 5-20</b> = primary thesis filter (bc_velocity 5–20 sol/min).</div>
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
