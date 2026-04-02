/**
 * HTML rendering utilities for thesis and filter-analysis endpoints.
 * Produces clean, readable HTML with cards and tables while preserving
 * the raw JSON for copy-paste to AI assistants.
 */

const NAV_LINKS = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/thesis', label: 'Thesis' },
  { path: '/filter-analysis', label: 'Filters' },
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
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .badge-pump{background:#166534;color:#4ade80}.badge-dump{background:#7f1d1d;color:#ef4444}
  .badge-stable{background:#422006;color:#facc15}
  .json-toggle{background:#262640;border:1px solid #333;border-radius:6px;margin-top:16px;overflow:hidden}
  .json-toggle summary{padding:10px 14px;cursor:pointer;color:#94a3b8;font-size:12px;user-select:none}
  .json-toggle summary:hover{background:#334155}
  .json-toggle pre{margin:0;padding:12px;white-space:pre-wrap;word-break:break-all;font-size:11px;max-height:600px;overflow-y:auto;background:#111}
  .section-sep{border:none;border-top:1px solid #333;margin:20px 0}
`;

function nav(currentPath: string): string {
  return NAV_LINKS.map(l =>
    l.path === currentPath
      ? `<a class="nav-active">${l.label}</a>`
      : `<a href="${l.path}">${l.label}</a>`
  ).join('');
}

function wr(val: number | null, threshold = 50): string {
  if (val === null) return '<span class="yellow">—</span>';
  const cls = val >= threshold ? 'green' : val >= 40 ? 'yellow' : 'red';
  return `<span class="${cls}">${val}%</span>`;
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
  const statusColor = d.bot_status === 'RUNNING' ? 'green' : d.bot_status === 'STALLED' ? 'yellow' : 'red';

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
        <div class="stat"><span class="label">Best Filter WR</span><span class="value">${wr(sc.best_filter?.win_rate)}</span></div>
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
        <div class="stat"><span class="label">Win Rate</span><span class="value">${wr(t30.win_rate_pct)}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Sample (n)</span><span class="value">${t30.n}</span></div>
        <div class="stat"><span class="label">PUMP / DUMP</span><span class="value"><span class="green">${t30.pump}</span> / <span class="red">${t30.dump}</span></span></div>
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
      <td>${t.has_pool ? '<span class="green">Yes</span>' : '<span class="red">No</span>'}</td>
    </tr>`).join('');

  const last10 = `
  <div class="card">
    <h2>Last 10 Graduations</h2>
    <div class="desc">Most recent graduations with their metrics and outcomes.</div>
    <table>
      <tr><th>Mint</th><th>Label</th><th>SOL</th><th>Holders</th><th>Top5%</th><th>T+60</th><th>T+300</th><th>Pool</th></tr>
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

  const body = header + verdict + scorecard + t30Signal + trajectory + last10 + quality;
  return shell('Thesis — Graduation Arb Research', '/thesis', body, data);
}

// ── FILTER ANALYSIS PAGE ──────────────────────────────────────────────

function filterTable(title: string, desc: string, rows: any[], showAvgT300 = true): string {
  if (!rows || rows.length === 0) return '';
  const t300Header = showAvgT300 ? '<th>Avg T+300</th>' : '';
  const tableRows = rows.map((r: any) => {
    const t300Cell = showAvgT300 ? `<td>${pct(r.avg_t300_pct)}</td>` : '';
    return `<tr>
      <td>${r.filter || r.strategy || r.bucket || '—'}</td>
      <td>${r.n}</td><td class="green">${r.pump ?? '—'}</td><td class="red">${r.dump ?? '—'}</td>
      <td>${wr(r.win_rate_pct)}</td>${t300Cell}
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
      <td class="${r.ev_positive ? 'ev-pos' : 'ev-neg'}">${r.avg_return_pct > 0 ? '+' : ''}${r.avg_return_pct}%</td>
      <td>${r.ev_positive ? '<span class="green">YES</span>' : '<span class="red">NO</span>'}</td>
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

export function renderFilterHtml(data: any): string {
  const d = data;

  const sections = [
    filterTable('T+30 Entry Filters',
      'Core momentum gate: only enter tokens showing positive momentum at T+30. This is the primary entry signal for the trading bot.',
      d.t30_entry_filters),

    filterTable('Velocity Sweet Spot & Combo Filters',
      'bc_velocity = how fast the bonding curve filled (SOL/min). Sweet spot is 5-20 sol/min — too slow means dead, too fast means bot rush. These combos stack velocity with other proven signals.',
      (d.combination_filters || []).filter((r: any) =>
        r.filter.includes('velocity') || r.filter.includes('liquidity')
      )),

    filterTable('Traditional Combo Filters',
      'Stacked filters using holder count, SOL raised, top5 wallet concentration, bc_age, and dev wallet %. These were the original signal tests.',
      (d.combination_filters || []).filter((r: any) =>
        !r.filter.includes('velocity') && !r.filter.includes('liquidity')
      )),

    filterTable('BC Age Filters',
      'bc_age = time the token spent on the bonding curve before graduating. Older tokens may have more organic holder bases.',
      d.bc_age_filters),

    filterTable('Holder Filters',
      'holder_count = number of unique holders at graduation (capped at 19 due to RPC limit of top-20 accounts minus infrastructure). More holders suggests organic interest.',
      d.holder_filters),

    filterTable('SOL Raised Filters',
      'total SOL raised on the bonding curve. Real graduations need ~85 SOL. Post-cleanup, nearly all tokens are in the 80-86 range.',
      d.sol_raised_filters),

    filterTable('Top5 Wallet Filters',
      'top5_wallet_pct = percentage of supply held by top 5 wallets. Lower concentration may indicate more distributed (organic) holding.',
      d.top5_filters),
  ];

  // Distributions
  const distSections = [
    filterTable('BC Velocity Distribution',
      'Win rate by bonding curve fill speed. The 5-20 sol/min range consistently outperforms. Very slow (<5) and very fast (50+) both underperform.',
      d.bc_velocity_distribution, false),

    filterTable('SOL Raised Distribution',
      'Win rate by SOL raised bucket. After cleanup, data is concentrated in the 80-86 SOL range (real graduations).',
      d.sol_raised_distribution, false),

    filterTable('BC Age Distribution',
      'Win rate by how long the token was on the bonding curve. <1h tends to perform best.',
      d.bc_age_distribution, false),
  ];

  // Stop-loss
  const slSections = [
    slTable('Stop-Loss: Basic T+30 Ranges',
      'Enter at T+30, exit at T+300 or when stop-loss triggers. Uses granular checkpoints (T+40 through T+240) for accurate stop detection.',
      d.stop_loss_simulation?.basic || d.stop_loss_simulation?.results),

    slTable('Stop-Loss: Velocity Combos',
      'Same stop-loss simulation but applied to the velocity-filtered cohort. Does the high win rate survive after accounting for stop-loss hits?',
      d.stop_loss_simulation?.velocity_combos),

    slTable('Stop-Loss: Stacked Combos',
      'Multi-signal filters with stop-losses. These represent the most refined trading bot strategies.',
      d.stop_loss_simulation?.stacked_combos),
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
        <td>${l.avg_slippage_05sol}%</td><td>${l.avg_bc_velocity ?? '—'} sol/min</td>
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
        <tr><th>Label</th><th>n</th><th>Volatility</th><th>Liquidity</th><th>Slippage (0.5 SOL)</th><th>BC Velocity</th></tr>
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
        <td>${pct(c.avg_return_from_t30_pct)}</td>
        <td>${c.profitable_rate_pct}%</td>
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
    drawdownSection + tradingSection + econSection;

  return shell('Filter Analysis — Graduation Arb Research', '/filter-analysis', body, data);
}
