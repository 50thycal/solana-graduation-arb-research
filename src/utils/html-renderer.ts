/**
 * HTML rendering utilities for the copy-trading dashboard pages
 * (/copy-trades, /live-training, /smart-money). Produces clean, readable HTML
 * with cards and tables while preserving the raw JSON for copy-paste to AI
 * assistants. The graduation-research renderers were removed in the
 * copy-trading refactor.
 */

import { ICON_HEAD_TAGS } from './app-icon';

const NAV_LINKS = [
  { path: '/copy-trades', label: 'Copy Trades' },
  { path: '/live-training', label: 'Live Training' },
  { path: '/smart-money', label: 'Smart Money' },
  { path: '/health', label: 'Health' },
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
  /* Mobile (≤640px): tighten chrome + make wide tables scroll within themselves
     instead of overflowing the page. table:not(.responsive) leaves the Trading
     Dashboard's stacked-card responsive tables untouched. */
  @media (max-width: 640px) {
    .container{padding:8px}
    nav{gap:4px;padding:6px 8px;flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch}
    nav a{padding:4px 9px;font-size:11px;white-space:nowrap}
    nav .title{font-size:12px;white-space:nowrap}
    .card{padding:10px;margin-bottom:10px}
    .card h2{font-size:14px}
    .card h3{font-size:12px}
    .grid{grid-template-columns:1fr;gap:8px}
    table:not(.responsive){display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
    th,td{padding:4px 6px;font-size:11px}
    .toolbar{gap:6px}
    .toolbar .timestamp{margin-left:0}
  }
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
${ICON_HEAD_TAGS}
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


function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderLiveTrainingHtml(data: any): string {
  const navHtml = nav('/live-training');
  const strategies: any[] = data.strategies || [];
  const hasLive = !!data.has_live_data;
  const generated = (data.generated_at || '').replace('T', ' ').replace(/\..*$/, ' UTC');

  // Live↔shadow mapping table (always shown — documents the maintained pairing).
  const mapping: Record<string, string> = data.mapping || {};
  const mappingRows = Object.keys(mapping).length
    ? Object.entries(mapping).map(([live, shadow]) =>
        `<tr><td style="font-family:monospace">${escHtml(live)}</td><td style="font-family:monospace;color:#a78bfa">${escHtml(shadow)}</td></tr>`,
      ).join('')
    : `<tr><td colspan="2" style="color:#64748b">No live→shadow pairs mapped yet.</td></tr>`;

  // Empty state — live trading hasn't produced any trades yet.
  const emptyState = !hasLive ? `
    <div class="card" style="border:1px solid #7f1d1d">
      <div class="card-title">No live trades yet</div>
      <p style="color:#94a3b8;font-size:12px;line-height:1.5;margin:0 0 8px">
        This page tracks strategies running in a live-money execution mode
        (<code>live_micro</code> / <code>live_full</code>). No such trades exist in the
        database yet, so the charts and metrics below are empty. They'll populate
        automatically once a live strategy starts trading.
      </p>
      <p style="color:#64748b;font-size:11px;margin:0">
        Live→shadow pairing is maintained in <code>LIVE_SHADOW_MAP</code>
        (<code>src/api/live-training-data.ts</code>). Add a row there when you launch a
        live strategy so its shadow twin shows up in the comparison section.
      </p>
    </div>` : '';

  // Strategy selector chips — multi-select. Default shows only currently-active
  // live strategies; retired/disabled ones (historical trades only) are tucked
  // behind a collapsed dropdown so the live set is visible off the bat.
  const activeStrats = strategies.filter((s: any) => s.active);
  const offStrats = strategies.filter((s: any) => !s.active);
  const activeTradeN = activeStrats.reduce((a: number, s: any) => a + (s.n_live || 0), 0);
  const chip = (s: any) => `
      <button class="lt-strat-chip" data-strat="${escHtml(s.id)}" type="button" title="${escHtml(s.label)}">
        <span class="lt-chk">✓ </span>${escHtml(s.label)} <span class="lt-chip-n">${s.n_live}</span>
        ${s.shadow_id ? '' : '<span class="lt-nopair" title="no shadow twin mapped">⚠</span>'}
      </button>`;
  const selectorChips = `
    <button class="lt-strat-chip lt-active" data-strat="" type="button">
      <span class="lt-chk">✓ </span>All Active <span class="lt-chip-n">${activeTradeN}</span>
    </button>
    ${activeStrats.map(chip).join('')}
    ${offStrats.length ? `
    <details class="lt-off-wrap">
      <summary>+ ${offStrats.length} retired / off</summary>
      <div class="lt-off-chips">${offStrats.map(chip).join('')}</div>
    </details>` : ''}`;

  // Inject the data object for client-side computation. Escape `<` so the JSON
  // can never break out of the <script> context.
  const ltJson = JSON.stringify(data).replace(/</g, '\\u003c');

  // Client beat interval for "The Analyst" stream (ms) — how often a new line
  // appears. Env-tunable (ROAST_BEAT_MS), floored at 3s so it can't be set to
  // hammer the /api/roast endpoint. Cost is also capped server-side by
  // ROAST_MIN_INTERVAL_MS regardless of this value.
  const anBeatMs = Math.max(3000, Number.parseInt(process.env.ROAST_BEAT_MS || '30000', 10) || 30000);

  const pageStyles = `
    .lt-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .lt-strat-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
    .lt-strat-chip{background:#334155;color:#94a3b8;border:1px solid #475569;border-radius:14px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px}
    .lt-strat-chip:hover{background:#3f4d61;color:#e2e8f0}
    .lt-strat-chip.lt-active{background:#2563eb;color:#fff;border-color:#2563eb;font-weight:600}
    .lt-chip-n{background:#0f172a44;border-radius:8px;padding:0 6px;font-size:10px}
    .lt-active .lt-chip-n{background:#0f172a66}
    .lt-nopair{color:#f59e0b;font-size:11px}
    .lt-off-wrap{display:inline-block}
    .lt-off-wrap>summary{list-style:none;cursor:pointer;background:#1e293b;color:#64748b;border:1px dashed #475569;border-radius:14px;padding:5px 12px;font-size:12px}
    .lt-off-wrap>summary::-webkit-details-marker{display:none}
    .lt-off-wrap>summary:hover{color:#94a3b8;border-color:#64748b}
    .lt-off-wrap[open]>summary{color:#94a3b8}
    .lt-off-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;width:100%}
    .lt-seg{display:inline-flex;border:1px solid #334155;border-radius:6px;overflow:hidden}
    .lt-seg button{background:#1e293b;color:#94a3b8;border:none;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit}
    .lt-seg button.lt-on{background:#2563eb;color:#fff;font-weight:600}
    .lt-controls label{color:#94a3b8;font-size:11px;display:inline-flex;align-items:center;gap:4px}
    .lt-controls select{background:#0f172a;color:#e2e8f0;border:1px solid #334155;padding:4px 8px;border-radius:4px;font-size:12px;cursor:pointer}
    .lt-chart-wrap{position:relative;background:#13131f;border-radius:8px;padding:6px}
    .lt-chart-wrap svg{display:block;width:100%;height:auto}
    .lt-tooltip{position:absolute;pointer-events:none;background:#0f172af2;border:1px solid #334155;border-radius:6px;padding:6px 9px;font-size:11px;color:#e2e8f0;z-index:5;display:none;white-space:nowrap;box-shadow:0 4px 12px #000a}
    .lt-tooltip b{color:#60a5fa}
    .lt-legend{display:flex;gap:16px;flex-wrap:wrap;margin:8px 2px 0;font-size:11px;color:#94a3b8}
    .lt-legend span{display:inline-flex;align-items:center;gap:5px}
    .lt-legend i{width:14px;height:3px;border-radius:2px;display:inline-block}
    .lt-hint{color:#64748b;font-size:10px;margin:6px 2px 0}
    .lt-metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
    .lt-metric{background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:8px 10px}
    .lt-metric .lab{color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
    .lt-metric .val{font-size:16px;font-weight:600;margin-top:2px}
    .lt-cmp-tbl{width:100%;border-collapse:collapse;border:1px solid #1e293b;border-radius:6px;overflow:hidden;table-layout:fixed}
    .lt-cmp-tbl th,.lt-cmp-tbl td{padding:6px 10px;border-bottom:1px solid #1e293b;font-size:12px;text-align:left;word-break:break-word}
    .lt-cmp-tbl thead th{background:#262640;color:#94a3b8;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
    .lt-cmp-tbl td.rl{color:#64748b}
    .lt-cmp-tbl tr.lt-cmp-delta td{background:#0f172a;font-weight:600;border-top:1px solid #334155}
    .lt-strat-chip.lt-active .lt-chk{display:inline}.lt-chk{display:none;font-size:10px}
    .lt-attrib{margin-top:12px;padding:10px 12px;background:#0f172a;border:1px solid #1e293b;border-radius:6px;font-size:11px;color:#94a3b8;line-height:1.7}
    .lt-attrib b{color:#cbd5e1}
    /* The Analyst — AI commentary stream */
    .an-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
    .an-ava{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#0e7490,#7c3aed);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#e0f2fe;flex:0 0 auto}
    .an-name{font-weight:700;color:#e2e8f0;font-size:14px;line-height:1}
    .an-sub{color:#64748b;font-size:10px;margin-top:2px}
    .an-pill{margin-left:auto;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:4px 10px;border-radius:12px;border:1px solid}
    .an-goal{font-size:11px;color:#94a3b8;background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:4px 9px;font-variant-numeric:tabular-nums}
    .an-goal b{color:#cbd5e1}
    .an-btn{background:#334155;color:#94a3b8;border:1px solid #475569;border-radius:4px;padding:4px 9px;font-size:11px;cursor:pointer;font-family:inherit}
    .an-btn:hover{color:#e2e8f0}
    .an-feed{background:#0b0b12;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;height:230px;overflow-y:auto;font-size:12.5px;line-height:1.5;scroll-behavior:smooth}
    .an-msg{margin:0 0 9px;animation:anfade .35s ease}
    .an-msg:last-child{margin-bottom:0}
    .an-ts{color:#475569;font-size:10px;font-variant-numeric:tabular-nums;margin-right:7px}
    .an-msg.t-bad .an-tx{color:#fca5a5}
    .an-msg.t-cold .an-tx{color:#fcd34d}
    .an-msg.t-ok .an-tx{color:#86efac}
    .an-msg.t-good .an-tx{color:#5eead4}
    .an-msg.t-wait .an-tx{color:#94a3b8}
    .an-typing{display:inline-flex;gap:3px;align-items:center;color:#64748b}
    .an-typing i{width:5px;height:5px;border-radius:50%;background:#64748b;display:inline-block;animation:anblink 1.1s infinite}
    .an-typing i:nth-child(2){animation-delay:.18s}.an-typing i:nth-child(3){animation-delay:.36s}
    @keyframes anblink{0%,60%,100%{opacity:.25}30%{opacity:1}}
    @keyframes anfade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @media (max-width:640px){.container{padding:8px}}
  `;

  const liveSection = hasLive ? `
    <div class="lt-strat-bar" id="lt-strat-bar">${selectorChips}</div>
    <p class="lt-hint" style="margin:-8px 2px 14px">Showing active live strategies by default · tap chips to combine · "All Active" resets · retired ones are under the dropdown.</p>

    <div class="card">
      <div class="card-title">Performance Chart</div>
      <div class="lt-controls">
        <div class="lt-seg" id="lt-type-seg">
          <button data-type="line" class="lt-on" type="button">Line</button>
          <button data-type="hist" type="button">Trade Histogram</button>
        </div>
        <label id="lt-metric-wrap">Metric
          <select id="lt-metric"></select>
        </label>
        <button id="lt-reset-zoom" type="button" style="background:#334155;color:#94a3b8;border:1px solid #475569;border-radius:4px;padding:5px 10px;font-size:11px;cursor:pointer;display:none">Reset zoom</button>
        <button id="lt-overlays" type="button" title="Toggle chart overlays (memes, ATH, drawdown, …)" style="margin-left:auto;background:#334155;color:#cbd5e1;border:1px solid #475569;border-radius:4px;padding:5px 12px;font-size:11px;cursor:pointer">Overlays</button>
        <button id="lt-copy-img" type="button" title="Copy the chart as a PNG (title + axes included) for sharing" style="background:#0e7490;color:#e0f2fe;border:1px solid #155e75;border-radius:4px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer">Copy image</button>
      </div>
      <div class="lt-chart-wrap" id="lt-primary-wrap">
        <div class="lt-tooltip" id="lt-primary-tip"></div>
      </div>
      <div class="lt-hint">Drag across the chart to zoom · hover to inspect a trade · double-click to reset · tap <b>Overlays</b> (or right-click) to toggle layers.</div>
    </div>

    <div class="card" id="lt-analyst-card">
      <div class="an-head">
        <div class="an-ava">AI</div>
        <div>
          <div class="an-name">The Analyst</div>
          <div class="an-sub">live commentary · goal: +3.75 SOL / month</div>
        </div>
        <span class="an-pill" id="an-pill" style="color:#94a3b8;border-color:#475569">booting</span>
        <span class="an-goal" id="an-goal">—</span>
        <select class="an-btn" id="an-persona" title="The Analyst's personality">
          <option value="quant">Deadpan Quant</option>
          <option value="hype">Hype Man</option>
          <option value="doomer">Permabear Doomer</option>
          <option value="zen">Zen Monk</option>
          <option value="drill">Drill Sergeant</option>
        </select>
        <button class="an-btn" id="an-now" type="button" title="Fire off a fresh take right now (skips the timer)">New take</button>
        <button class="an-btn" id="an-toggle" type="button">Pause</button>
        <button class="an-btn" id="an-recap" type="button" title="Generate a shareable recap card (title, stats, chart + an AI summary) and copy it to your clipboard">Recap card</button>
      </div>
      <div class="an-feed" id="lt-analyst-feed"></div>
    </div>

    <div class="card">
      <div class="card-title">Metrics Summary <span id="lt-metrics-scope" style="color:#64748b;font-weight:400;font-size:11px;text-transform:none;letter-spacing:0"></span></div>
      <div class="lt-metric-grid" id="lt-metrics"></div>
    </div>

    <div class="card">
      <div class="card-title">Execution Diagnostics <span style="color:#94a3b8;font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">— why live drifts from shadow</span></div>
      <p class="desc" style="color:#94a3b8;font-size:11px;margin:0 0 10px">
        Shadow books the price at the <b>instant</b> a TP/SL triggers (a zero-latency model). Live submits a real
        transaction that takes time to land — on tokens moving 100%+/sec, the price drifts during that window.
        That fill-timing drift, not slippage or fees, is what makes live swing from shadow per-trade.
      </p>
      <div class="lt-metric-grid" id="lt-diag"></div>
    </div>

    <div class="card">
      <div class="card-title">Live vs Shadow <span style="color:#64748b;font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">— matched on graduations both traded</span></div>
      <p class="desc" style="color:#94a3b8;font-size:11px;margin:0 0 10px">
        Each point is one graduation that <b>both</b> the live strategy and its shadow twin entered.
        Same token, same entry decision, different fill path — so the gap is pure execution (slippage, timing, fees).
      </p>
      <div id="lt-cmp-empty" style="display:none;color:#64748b;font-size:12px;padding:8px 0">
        No matched graduations for this selection. Either no shadow twin is mapped, or the live and shadow
        strategies haven't traded any of the same graduations yet.
      </div>
      <div id="lt-cmp-body" style="display:none">
        <div class="lt-chart-wrap" id="lt-cmp-wrap" style="margin-bottom:10px">
          <div class="lt-tooltip" id="lt-cmp-tip"></div>
        </div>
        <div class="lt-legend">
          <span><i style="background:#22d3ee"></i>Live (cumulative net SOL)</span>
          <span><i style="background:#a78bfa"></i>Shadow (cumulative net SOL)</span>
        </div>
        <div style="margin-top:14px;overflow-x:auto" id="lt-cmp-table"></div>
        <div class="lt-attrib" id="lt-cmp-attrib"></div>
        <div class="lt-attrib" id="lt-cmp-bench"></div>
        <div class="lt-attrib" id="lt-cmp-slipcap"></div>
        <details style="margin-top:12px">
          <summary style="cursor:pointer;color:#94a3b8;font-size:12px">Per-graduation pairs (<span id="lt-cmp-n">0</span>)</summary>
          <div style="overflow-x:auto;margin-top:8px">
            <table class="table" id="lt-cmp-pairs"><thead><tr>
              <th>Entry</th><th>Mint</th><th>Live %</th><th>Shadow %</th><th>Δ %</th>
              <th>Live slip%</th><th>Shadow slip%</th>
            </tr></thead><tbody></tbody></table>
          </div>
        </details>
      </div>
    </div>
  ` : '';

  const js = `<script>
(function(){
  var LT = ${ltJson};
  var AN_BEAT_MS = ${anBeatMs};
  // ── helpers ──
  function num(v){ return (v===null||v===undefined||isNaN(v))?null:v; }
  function f4(v){ v=num(v); return v===null?'—':(v>=0?'+':'')+v.toFixed(4); }
  function f4u(v){ v=num(v); return v===null?'—':v.toFixed(4); }
  function fpct(v,d){ v=num(v); if(v===null) return '—'; d=(d===undefined)?2:d; return (v>=0?'+':'')+v.toFixed(d)+'%'; }
  function fpctp(v,d){ v=num(v); if(v===null) return '—'; d=(d===undefined)?3:d; return v.toFixed(d)+'%'; }
  function fint(v){ v=num(v); return v===null?'—':String(Math.round(v)); }
  function fsec(v){ v=num(v); if(v===null) return '—'; if(v<60) return Math.round(v)+'s'; if(v<3600) return (v/60).toFixed(1)+'m'; return (v/3600).toFixed(1)+'h'; }
  function fts(s){ if(!s) return '—'; var d=new Date(s*1000); return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
  function shortMint(m){ return m? (m.slice(0,4)+'…'+m.slice(-4)) : '—'; }
  function colorClass(v){ v=num(v); return v===null?'':(v>0?'green':(v<0?'red':'')); }
  function rt(t){ var e=num(t.entry_slip_pct), x=num(t.exit_slip_pct); if(e===null&&x===null) return null; return (e||0)+(x||0); }

  // state.selected: array of live strategy_ids. Empty = "All Live" (aggregate).
  var state = { selected:[], type:'line', metric:'cum_sol', xView:null };

  // ── line-chart metric descriptors (computed from live trades) ──
  var LINE_METRICS = [
    {key:'cum_sol',   label:'Cumulative SOL P&L',          mode:'cum',    val:function(t){return num(t.net_profit_sol)||0;}, unit:'SOL', zero:true},
    {key:'cum_trades',label:'Cumulative Trades',           mode:'cum',    val:function(){return 1;}, unit:'', all:true},
    {key:'cum_closed',label:'Cumulative Closed Trades',    mode:'cum',    val:function(t){return t.status==='closed'?1:0;}, unit:'', all:true},
    {key:'cum_failed',label:'Cumulative Failed Trades',    mode:'cum',    val:function(t){return t.status==='failed'?1:0;}, unit:'', all:true},
    {key:'cum_fees',  label:'Cumulative Fees (SOL)',       mode:'cum',    val:function(t){return num(t.fees_sol)||0;}, unit:'SOL'},
    {key:'cum_jito',  label:'Cumulative Jito Tips (SOL)',  mode:'cum',    val:function(t){return num(t.jito_tip_sol)||0;}, unit:'SOL'},
    {key:'win_rate',  label:'Rolling Win Rate (%)',        mode:'winrate',unit:'%'},
    {key:'avg_pnl',   label:'Avg Profit / Trade (SOL)',    mode:'avgpnl', unit:'SOL', zero:true},
    {key:'ret_pct',   label:'Net Return / Trade (%)',      mode:'point',  val:function(t){return num(t.net_return_pct);}, unit:'%', zero:true},
    {key:'rt_slip',   label:'Round-trip Slippage / Trade (%)', mode:'point', val:function(t){return rt(t);}, unit:'%'},
    {key:'latency',   label:'Execution Latency (ms)',      mode:'point',  val:function(t){return num(t.tx_land_ms);}, unit:'ms'}
  ];
  var HIST_METRICS = [
    {key:'net_sol', label:'Net P&L per Trade (SOL)', val:function(t){return num(t.net_profit_sol);}, unit:'SOL'},
    {key:'net_pct', label:'Net Return per Trade (%)', val:function(t){return num(t.net_return_pct);}, unit:'%'}
  ];

  // Set of currently-active (enabled, live-mode) strategy ids. Empty selection
  // defaults to these so retired strategies don't pollute the at-a-glance view.
  var ACTIVE_SET={}, ACTIVE_LIST=[];
  (LT.strategies||[]).forEach(function(s){ if(s.active){ ACTIVE_SET[s.id]=true; ACTIVE_LIST.push(s.id); } });
  function liveTrades(){
    var all = LT.trades.live || [];
    if(state.selected.length){
      var sel={}; for(var i=0;i<state.selected.length;i++) sel[state.selected[i]]=true;
      return all.filter(function(t){return sel[t.strategy_id];});
    }
    // Default: active strategies only (fall back to all if none are active).
    if(!ACTIVE_LIST.length) return all;
    return all.filter(function(t){return ACTIVE_SET[t.strategy_id];});
  }

  // Build {points:[{x,y,t}], zero} for the current line metric.
  function buildLineSeries(metricKey){
    var m=null; for(var i=0;i<LINE_METRICS.length;i++){ if(LINE_METRICS[i].key===metricKey){m=LINE_METRICS[i];break;} }
    if(!m) m=LINE_METRICS[0];
    var ts = liveTrades().filter(function(t){return t.entry_ts!==null && t.entry_ts!==undefined;});
    ts = ts.slice().sort(function(a,b){return (a.entry_ts-b.entry_ts)||(a.id-b.id);});
    var pts=[];
    if(m.mode==='cum'){
      var acc=0;
      for(var i=0;i<ts.length;i++){ acc+=m.val(ts[i]); pts.push({x:ts[i].entry_ts,y:acc,t:ts[i]}); }
    } else if(m.mode==='winrate'){
      var w=0,c=0;
      for(var i=0;i<ts.length;i++){ if(ts[i].status==='closed'){ c++; if(num(ts[i].net_profit_sol)>0) w++; pts.push({x:ts[i].entry_ts,y:c?w/c*100:0,t:ts[i]}); } }
    } else if(m.mode==='avgpnl'){
      var sum=0,n=0;
      for(var i=0;i<ts.length;i++){ if(ts[i].status==='closed'){ sum+=num(ts[i].net_profit_sol)||0; n++; pts.push({x:ts[i].entry_ts,y:n?sum/n:0,t:ts[i]}); } }
    } else { // point
      for(var i=0;i<ts.length;i++){ var v=m.val(ts[i]); if(v!==null) pts.push({x:ts[i].entry_ts,y:v,t:ts[i]}); }
    }
    return {points:pts, zero:!!m.zero, unit:m.unit, label:m.label, kind:(m.mode==='point'?'point':'line')};
  }

  // Build histogram bars for current hist metric.
  function buildHist(metricKey){
    var m=null; for(var i=0;i<HIST_METRICS.length;i++){ if(HIST_METRICS[i].key===metricKey){m=HIST_METRICS[i];break;} }
    if(!m) m=HIST_METRICS[0];
    var ts = liveTrades().filter(function(t){return t.status==='closed' && m.val(t)!==null;});
    ts = ts.slice().sort(function(a,b){return ((a.entry_ts||0)-(b.entry_ts||0))||(a.id-b.id);});
    var bars=[];
    for(var i=0;i<ts.length;i++){ bars.push({i:i,y:m.val(ts[i]),t:ts[i]}); }
    return {bars:bars, unit:m.unit, label:m.label};
  }

  // ── generic SVG chart engine ──────────────────────────────────────────
  var W=900,H=340,PADL=60,PADR=16,PADT=14,PADB=34;
  var PW=W-PADL-PADR, PH=H-PADT-PADB;
  function svgEl(name,attrs){ var e=document.createElementNS('http://www.w3.org/2000/svg',name); for(var k in attrs){ e.setAttribute(k,attrs[k]); } return e; }
  function niceTicks(min,max,n){
    if(min===max){ min-=1; max+=1; }
    var span=max-min, step=Math.pow(10,Math.floor(Math.log(span/n)/Math.LN10));
    var err=n*step/span;
    if(err<=0.15) step*=10; else if(err<=0.35) step*=5; else if(err<=0.75) step*=2;
    var ticks=[], t=Math.ceil(min/step)*step;
    for(; t<=max+step*0.001; t+=step){ ticks.push(+t.toFixed(10)); }
    return ticks;
  }

  // ── chart overlay / meme annotation system ──────────────────────────────
  // Rotating caption pools so every screenshot looks fresh instead of the same
  // two phrases. Text-only, no emoji (operator preference). Pick is seeded by
  // the point so a given peak always shows the same line across re-renders.
  var MEME_UP=['we are so back','up only','number go up','to the moon','wagmi',
    'few understand','probably nothing','chart looking thicc','ascending',
    'green candles only','bullish','locked in','this is the signal','feels good man',
    'told you','generational wealth','one more leg up'];
  var MEME_DOWN=["it's so over",'down bad','this is fine','ngmi','rekt','pain',
    'who did this','it is what it is','exit liquidity','should have sold',
    'down astronomically','descending','financial damage','not great','copium',
    'temporary setback','character building'];
  function memePick(pool, seed){
    var h=Math.abs(Math.floor(seed))||1; h=(h*48271)%2147483647; return pool[h%pool.length];
  }
  // Toggleable overlay layers — persisted so chosen layers survive reloads
  // (handy for taking a series of consistent screenshots). Right-click the
  // chart to toggle. Only "memes" defaults on; the data-driven flags are
  // opt-in via the context menu.
  var ANNO_DEFAULTS={memes:true,ath:false,extremes:false,drawdown:false,
    streak:false,flip:false,watermark:false,nowbadge:false};
  function loadAnno(){ var d={}; for(var k in ANNO_DEFAULTS) d[k]=ANNO_DEFAULTS[k];
    try{ var s=JSON.parse(localStorage.getItem('lt-anno')||'{}'); for(var k in d) if(k in s) d[k]=!!s[k]; }catch(e){} return d; }
  function saveAnno(a){ try{ localStorage.setItem('lt-anno', JSON.stringify(a)); }catch(e){} }
  var ANNO=loadAnno();

  // makeChart(container, tooltip): returns { update(cfg) } where cfg describes
  // series. Handles line / point / hist, plus hover + drag-zoom.
  function makeChart(container, tip){
    var svg=svgEl('svg',{viewBox:'0 0 '+W+' '+H, preserveAspectRatio:'none'});
    container.insertBefore(svg, tip);
    var ctx={ cfg:null, xv:null, fullX:null, xToPx:null, yToPx:null, pxToX:null,
              isHist:false, brush:null, clientToSvgX:null, dragging:false, dragStartX:0 };

    // Right-click overlay menu — only built on charts that opt into annotations
    // (cfg.memes). Lets the operator toggle the fun/data layers on the live
    // chart for screenshots. Built lazily on first right-click.
    var annoMenu=null;
    function buildAnnoMenu(){
      if(annoMenu) return annoMenu;
      annoMenu=document.createElement('div');
      annoMenu.style.cssText='position:absolute;z-index:30;display:none;background:#0f172af7;border:1px solid #334155;border-radius:8px;padding:6px;font-size:11px;color:#e2e8f0;box-shadow:0 8px 24px #000b;min-width:184px';
      var head=document.createElement('div'); head.textContent='Chart overlays';
      head.style.cssText='font-weight:700;color:#94a3b8;padding:3px 6px 6px;text-transform:uppercase;letter-spacing:.04em;font-size:10px';
      annoMenu.appendChild(head);
      [['memes','Meme captions'],['ath','New ATH flag'],['extremes','Biggest win / loss'],
       ['drawdown','Max drawdown'],['streak','Win / loss streaks'],['flip','Flipped green / red'],
       ['watermark','High / low lines'],['nowbadge','Current P&L badge']].forEach(function(it){
        var lab=document.createElement('label');
        lab.style.cssText='display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:5px;cursor:pointer;white-space:nowrap';
        lab.onmouseenter=function(){lab.style.background='#1e293b';}; lab.onmouseleave=function(){lab.style.background='transparent';};
        var cb=document.createElement('input'); cb.type='checkbox'; cb.checked=!!ANNO[it[0]];
        cb.style.cssText='accent-color:#22d3ee;cursor:pointer'; cb.setAttribute('data-anno',it[0]);
        cb.onchange=function(){ ANNO[it[0]]=cb.checked; saveAnno(ANNO); draw(); };
        var sp=document.createElement('span'); sp.textContent=it[1];
        lab.appendChild(cb); lab.appendChild(sp); annoMenu.appendChild(lab);
      });
      container.appendChild(annoMenu);
      return annoMenu;
    }
    svg.addEventListener('contextmenu', function(ev){
      if(!ctx.cfg || !ctx.cfg.memes) return; // only the annotated primary chart
      ev.preventDefault();
      var menu=buildAnnoMenu();
      menu.querySelectorAll('input[data-anno]').forEach(function(cb){ cb.checked=!!ANNO[cb.getAttribute('data-anno')]; });
      var r=container.getBoundingClientRect();
      menu.style.display='block';
      var mw=menu.offsetWidth||184;
      menu.style.left=Math.max(0,Math.min(ev.clientX-r.left, container.clientWidth-mw))+'px';
      menu.style.top=Math.max(0,ev.clientY-r.top)+'px';
    });
    document.addEventListener('click', function(ev){ if(annoMenu && annoMenu.style.display==='block' && !annoMenu.contains(ev.target)) annoMenu.style.display='none'; });
    document.addEventListener('keydown', function(ev){ if(ev.key==='Escape' && annoMenu) annoMenu.style.display='none'; });
    // Mobile / no-right-click entry point: open the same overlay menu from a
    // button. Toggles open/closed; anchored top-right inside the chart.
    function toggleAnnoMenu(){
      if(!ctx.cfg || !ctx.cfg.memes) return;
      var menu=buildAnnoMenu();
      if(menu.style.display==='block'){ menu.style.display='none'; return; }
      menu.querySelectorAll('input[data-anno]').forEach(function(cb){ cb.checked=!!ANNO[cb.getAttribute('data-anno')]; });
      menu.style.display='block';
      var mw=menu.offsetWidth||184;
      menu.style.left=Math.max(8, container.clientWidth-mw-8)+'px';
      menu.style.top='8px';
    }

    // Drag-to-zoom: window-level listeners are bound ONCE per chart (not per
    // redraw) so they don't accumulate. They read live geometry off ctx, which
    // draw() refreshes on every render.
    window.addEventListener('mousemove', function(ev){
      if(!ctx.dragging || !ctx.brush || !ctx.clientToSvgX) return;
      var sx=ctx.clientToSvgX(ev.clientX);
      var a=Math.max(PADL,Math.min(ctx.dragStartX,sx)), b=Math.min(W-PADR,Math.max(ctx.dragStartX,sx));
      ctx.brush.setAttribute('x',a); ctx.brush.setAttribute('width',Math.max(0,b-a));
    });
    window.addEventListener('mouseup', function(ev){
      if(!ctx.dragging) return; ctx.dragging=false;
      if(ctx.brush) ctx.brush.setAttribute('opacity',0);
      var sx=ctx.clientToSvgX(ev.clientX); var a=Math.min(ctx.dragStartX,sx), b=Math.max(ctx.dragStartX,sx);
      if(b-a>8 && !ctx.isHist){ var xa=ctx.pxToX(a), xb=ctx.pxToX(b); ctx.xv=[xa,xb];
        document.getElementById('lt-reset-zoom').style.display='inline-block'; draw(); }
    });

    function draw(){
      while(svg.firstChild) svg.removeChild(svg.firstChild);
      var cfg=ctx.cfg; if(!cfg){ return; }
      var isHist = cfg.type==='hist';
      // x domain
      var xmin, xmax;
      if(isHist){ xmin=-0.5; xmax=Math.max(0.5,(cfg.bars.length-0.5)); }
      else {
        var xs=[]; cfg.series.forEach(function(s){ s.points.forEach(function(p){ xs.push(p.x); }); });
        if(!xs.length){ xmin=0;xmax=1; } else { xmin=Math.min.apply(null,xs); xmax=Math.max.apply(null,xs); }
        if(xmin===xmax){ xmin-=1; xmax+=1; }
      }
      var fullX=[xmin,xmax];
      var xv = ctx.xv || fullX;
      // y domain (over visible x for line; all bars for hist)
      var ys=[];
      if(isHist){ cfg.bars.forEach(function(b){ ys.push(b.y); }); ys.push(0); }
      else {
        cfg.series.forEach(function(s){ s.points.forEach(function(p){ if(p.x>=xv[0]-1e-9 && p.x<=xv[1]+1e-9) ys.push(p.y); }); });
        if(cfg.zero) ys.push(0);
      }
      if(!ys.length){ ys=[0,1]; }
      var ymin=Math.min.apply(null,ys), ymax=Math.max.apply(null,ys);
      if(ymin===ymax){ ymin-=1; ymax+=1; }
      var pad=(ymax-ymin)*0.08; ymin-=pad; ymax+=pad;

      var x0=isHist?fullX[0]:xv[0], x1=isHist?fullX[1]:xv[1];
      function xToPx(x){ return PADL + (x-x0)/(x1-x0)*PW; }
      function yToPx(y){ return PADT + (1-(y-ymin)/(ymax-ymin))*PH; }
      function pxToX(px){ return x0 + (px-PADL)/PW*(x1-x0); }
      ctx.xToPx=xToPx; ctx.yToPx=yToPx; ctx.pxToX=pxToX; ctx.xv=xv; ctx.fullX=fullX;

      // background
      svg.appendChild(svgEl('rect',{x:0,y:0,width:W,height:H,fill:'#13131f',rx:8}));
      // y grid + labels
      var yticks=niceTicks(ymin,ymax,5);
      yticks.forEach(function(ty){ var py=yToPx(ty);
        svg.appendChild(svgEl('line',{x1:PADL,y1:py,x2:W-PADR,y2:py,stroke:(Math.abs(ty)<1e-9?'#475569':'#262640'),'stroke-width':(Math.abs(ty)<1e-9?1.2:1)}));
        var lab=svgEl('text',{x:PADL-6,y:py+3,fill:'#64748b','font-size':10,'text-anchor':'end'}); lab.textContent=(Math.abs(ty)>=1000?(ty/1000).toFixed(1)+'k':(+ty.toFixed(4)).toString()); svg.appendChild(lab);
      });
      // x labels (time for line, index for hist)
      var xticks = isHist ? niceTicks(0,Math.max(1,cfg.bars.length-1),6).filter(function(v){return v>=0;}) : niceTicks(xv[0],xv[1],6);
      xticks.forEach(function(tx){ var px=xToPx(tx); if(px<PADL-1||px>W-PADR+1) return;
        svg.appendChild(svgEl('line',{x1:px,y1:PADT,x2:px,y2:PADT+PH,stroke:'#1e2030','stroke-width':1}));
        var lab=svgEl('text',{x:px,y:PADT+PH+14,fill:'#64748b','font-size':9,'text-anchor':'middle'});
        lab.textContent = isHist ? ('#'+Math.round(tx)) : fts(tx);
        svg.appendChild(lab);
      });

      // clip for line series
      var clipId='ltclip'+Math.random().toString(36).slice(2);
      var defs=svgEl('defs',{}); var cp=svgEl('clipPath',{id:clipId});
      cp.appendChild(svgEl('rect',{x:PADL,y:PADT,width:PW,height:PH})); defs.appendChild(cp); svg.appendChild(defs);

      if(isHist){
        var n=cfg.bars.length; var bw=Math.max(1,Math.min(18, PW/Math.max(1,n)*0.8));
        cfg.bars.forEach(function(b){ var px=xToPx(b.i); var py=yToPx(b.y); var pz=yToPx(0);
          var top=Math.min(py,pz), hh=Math.abs(pz-py);
          svg.appendChild(svgEl('rect',{x:px-bw/2,y:top,width:bw,height:Math.max(0.5,hh),fill:(b.y>=0?'#22c55e':'#ef4444'),opacity:0.85}));
        });
      } else {
        cfg.series.forEach(function(s){
          if(!s.points.length) return;
          if(cfg.kind==='point'){
            var g=svgEl('g',{'clip-path':'url(#'+clipId+')'});
            s.points.forEach(function(p){ g.appendChild(svgEl('circle',{cx:xToPx(p.x),cy:yToPx(p.y),r:2.4,fill:s.color,opacity:0.8})); });
            svg.appendChild(g);
          } else {
            var d=''; for(var i=0;i<s.points.length;i++){ d+=(i?'L':'M')+xToPx(s.points[i].x).toFixed(1)+' '+yToPx(s.points[i].y).toFixed(1)+' '; }
            var path=svgEl('path',{d:d,fill:'none',stroke:s.color,'stroke-width':1.8,'clip-path':'url(#'+clipId+')'});
            if(s.dashed) path.setAttribute('stroke-dasharray','5 4');
            svg.appendChild(path);
          }
        });
      }

      // fun: toggleable overlay annotations on the cumulative P&L line. The
      // base layer ("memes") stamps rotating captions on the dramatic peaks and
      // dips; the data-driven layers (ATH, biggest win/loss, drawdown, streaks,
      // flips, high/low lines, current badge) are opt-in via right-click menu.
      if(cfg.memes && !isHist && cfg.kind!=='point' && cfg.series.length){
        var mp=cfg.series[0].points.filter(function(p){return p.x>=xv[0]-1e-9 && p.x<=xv[1]+1e-9;});
        var isSol=(cfg.unit==='SOL');
        var annoG=svgEl('g',{'pointer-events':'none'});
        // Text labels are collected here, then de-overlapped + drawn at the end
        // so the memes yield to the data labels instead of stacking on them.
        var labels=[];
        function fmtVal(v){ return cfg.unit==='SOL'?(f4(v)+' SOL'):(cfg.unit==='%'?fpct(v):(cfg.unit==='ms'?fint(v)+' ms':fint(v))); }
        function inX(px){ return px>=PADL-1 && px<=W-PADR+1; }
        // record a label (auto-anchored away from the chart edges). dy<0 places
        // it above the point (and nudges upward on collision), dy>0 below. Higher
        // prio keeps its spot; lower-prio labels move out of the way.
        function labelAt(px,py,txt,fill,dy,size,prio,style){
          var anchor='middle'; if(px<PADL+40) anchor='start'; else if(px>W-PADR-40) anchor='end';
          labels.push({x:px,y:py+(dy||0),text:txt,fill:fill,size:(size||10),anchor:anchor,
            dir:((dy||0)<0?-1:1),prio:(prio==null?5:prio),style:(style||'italic')});
        }
        function dot(px,py,fill){ annoG.appendChild(svgEl('circle',{cx:px,cy:py,r:3,fill:fill,stroke:'#0f172a','stroke-width':1})); }

        // ── memes: rotating captions spread across the timeline's peaks/dips ──
        if(ANNO.memes && mp.length>=3){
          var turns=[];
          for(var i=1;i<mp.length-1;i++){ var a=mp[i-1].y,b=mp[i].y,c=mp[i+1].y;
            if(b>a&&b>=c) turns.push({p:mp[i],type:'peak',prom:Math.abs(b-(a+c)/2)});
            else if(b<a&&b<=c) turns.push({p:mp[i],type:'dip',prom:Math.abs(b-(a+c)/2)}); }
          // Take the most dramatic turns first, but skip any too close (in x) to
          // one already chosen — so captions land on DISTINCT peaks/valleys
          // spread along the chart instead of clustering at the global extremes.
          turns.sort(function(x,y){ return y.prom-x.prom; });
          var minGap=Math.max(95, PW/8), sel=[];
          for(var ti=0; ti<turns.length && sel.length<8; ti++){
            var tpx=xToPx(turns[ti].p.x); if(!inX(tpx)) continue;
            var ok=true; for(var si=0; si<sel.length; si++){ if(Math.abs(xToPx(sel[si].p.x)-tpx)<minGap){ ok=false; break; } }
            if(ok) sel.push(turns[ti]);
          }
          sel.sort(function(x,y){ return x.p.x-y.p.x; });
          sel.forEach(function(e,idx){ var isP=e.type==='peak';
            var px=xToPx(e.p.x), py=yToPx(e.p.y);
            var pool=isP?MEME_UP:MEME_DOWN;
            labelAt(px,py,memePick(pool, Math.round(e.p.x)+idx*7919),(isP?'#22c55e':'#ef4444'),(isP?-7:15),9.5,1);
          });
        }

        // ── new ATH flag: a marker at the curve's all-time high ──
        if(ANNO.ath && isSol && mp.length){
          var hi=mp[0]; for(var i=1;i<mp.length;i++){ if(mp[i].y>hi.y) hi=mp[i]; }
          var px=xToPx(hi.x), py=yToPx(hi.y);
          if(inX(px) && hi.y>0){ dot(px,py,'#facc15'); labelAt(px,py,'new ATH','#facc15',-8,9.5,6); }
        }

        // ── biggest win / biggest loss: tag the single best & worst trade ──
        if(ANNO.extremes && isSol && mp.length){
          var bestW=null,worstL=null;
          for(var i=0;i<mp.length;i++){ var d=num(mp[i].t&&mp[i].t.net_profit_sol); if(d===null) continue;
            if(d>0 && (!bestW || d>num(bestW.t.net_profit_sol))) bestW=mp[i];
            if(d<0 && (!worstL || d<num(worstL.t.net_profit_sol))) worstL=mp[i]; }
          if(bestW){ var pxw=xToPx(bestW.x),pyw=yToPx(bestW.y); if(inX(pxw)){ dot(pxw,pyw,'#22c55e'); labelAt(pxw,pyw,'biggest bag '+f4(num(bestW.t.net_profit_sol)),'#22c55e',-8,9.5,7); } }
          if(worstL){ var pxl=xToPx(worstL.x),pyl=yToPx(worstL.y); if(inX(pxl)){ dot(pxl,pyl,'#ef4444'); labelAt(pxl,pyl,'max pain '+f4(num(worstL.t.net_profit_sol)),'#ef4444',16,9.5,7); } }
        }

        // ── max drawdown: deepest peak→trough decline on the cumulative line ──
        if(ANNO.drawdown && isSol && mp.length>1){
          var pk=mp[0], ddPk=mp[0], ddTr=mp[0], maxDD=0;
          for(var i=1;i<mp.length;i++){ if(mp[i].y>pk.y) pk=mp[i];
            var dd=pk.y-mp[i].y; if(dd>maxDD){ maxDD=dd; ddPk=pk; ddTr=mp[i]; } }
          if(maxDD>0){ var pxp=xToPx(ddPk.x),pyp=yToPx(ddPk.y),pxt=xToPx(ddTr.x),pyt=yToPx(ddTr.y);
            if(inX(pxp)||inX(pxt)){
              annoG.appendChild(svgEl('line',{x1:pxp,y1:pyp,x2:pxt,y2:pyt,stroke:'#f97316','stroke-width':1.2,'stroke-dasharray':'4 3',opacity:0.9}));
              dot(pxp,pyp,'#f97316'); dot(pxt,pyt,'#f97316');
              labelAt((pxp+pxt)/2,Math.max(pyp,pyt),'max drawdown -'+f4u(maxDD)+' SOL','#f97316',16,9.5,6);
            }
          }
        }

        // ── win / loss streaks: longest consecutive run of green / red trades ──
        if(ANNO.streak && isSol && mp.length){
          function longestRun(want){ var bs=0,bi=-1,cs=0,ci=0;
            for(var i=0;i<mp.length;i++){ var d=num(mp[i].t&&mp[i].t.net_profit_sol);
              var hit=(d!==null)&&(want>0?d>0:d<0);
              if(hit){ if(cs===0) ci=i; cs++; if(cs>bs){bs=cs;bi=ci;} } else cs=0; }
            return bs>=3?{len:bs,end:mp[bi+bs-1]}:null; }
          var heater=longestRun(1), cold=longestRun(-1);
          if(heater){ var pxh=xToPx(heater.end.x),pyh=yToPx(heater.end.y); if(inX(pxh)){ labelAt(pxh,pyh,heater.len+'-trade heater','#22c55e',-8,9.5,4); } }
          if(cold){ var pxc=xToPx(cold.end.x),pyc=yToPx(cold.end.y); if(inX(pxc)){ labelAt(pxc,pyc,cold.len+'-trade ice age','#ef4444',16,9.5,4); } }
        }

        // ── flips: where cumulative crossed zero (into / out of profit) ──
        if(ANNO.flip && cfg.zero && mp.length>1){
          var flips=[];
          for(var i=1;i<mp.length;i++){ var a=mp[i-1].y,b=mp[i].y;
            if(a<0&&b>=0) flips.push({p:mp[i],up:true}); else if(a>=0&&b<0) flips.push({p:mp[i],up:false}); }
          flips.slice(0,6).forEach(function(fl){ var px=xToPx(fl.p.x),py=yToPx(fl.p.y); if(!inX(px)) return;
            dot(px,py,fl.up?'#22c55e':'#ef4444'); labelAt(px,py,fl.up?'flipped green':'flipped red',(fl.up?'#22c55e':'#ef4444'),(fl.up?-8:16),9,3); });
        }

        // ── high / low watermark lines across the visible window ──
        if(ANNO.watermark && mp.length){
          var hiW=mp[0],loW=mp[0]; for(var i=1;i<mp.length;i++){ if(mp[i].y>hiW.y) hiW=mp[i]; if(mp[i].y<loW.y) loW=mp[i]; }
          [[hiW,'high','#22c55e'],[loW,'low','#ef4444']].forEach(function(w){ var py=yToPx(w[0].y);
            annoG.appendChild(svgEl('line',{x1:PADL,y1:py,x2:W-PADR,y2:py,stroke:w[2],'stroke-width':0.8,'stroke-dasharray':'2 4',opacity:0.6}));
            labels.push({x:W-PADR-2,y:py-3,text:w[1]+' '+fmtVal(w[0].y),fill:w[2],size:9,anchor:'end',dir:-1,prio:8,style:'normal'}); });
        }

        // ── current P&L badge pinned to the last point ──
        if(ANNO.nowbadge && mp.length){
          var last=mp[mp.length-1]; var px=Math.min(xToPx(last.x),W-PADR-2), py=yToPx(last.y);
          var pos=last.y>=0; dot(px,py,pos?'#22c55e':'#ef4444');
          labels.push({x:px-6,y:py-7,text:'now '+fmtVal(last.y),fill:pos?'#22c55e':'#ef4444',size:10,anchor:'end',dir:-1,prio:10,style:'normal'});
        }

        // ── de-overlap pass: place high-priority labels first, then each
        // remaining label at the nearest clear slot — preferred direction first,
        // then the opposite — staying within the plot. ──
        function anBox(L,y){ if(y==null) y=L.y; var w=Math.max(8, L.text.length*L.size*0.6), h=L.size+3;
          var x0=(L.anchor==='start')?L.x:((L.anchor==='end')?L.x-w:L.x-w/2);
          return {x0:x0-1,x1:x0+w+1,y0:y-h,y1:y+3}; }
        function anHit(a,b){ return a.x0<b.x1 && a.x1>b.x0 && a.y0<b.y1 && a.y1>b.y0; }
        function anClear(box){ for(var i=0;i<placed.length;i++){ if(anHit(box,placed[i])) return false; } return true; }
        labels.sort(function(a,b){ return b.prio-a.prio; });
        var placed=[];
        labels.forEach(function(L){
          var base=L.y, dirs=[(L.dir<0?-1:1),(L.dir<0?1:-1)], best=null;
          for(var di=0; di<dirs.length && !best; di++){ var y=base;
            for(var tries=0; tries<22; tries++){ var b=anBox(L,y);
              if(b.y0>=PADT+2 && b.y1<=PADT+PH-2 && anClear(b)){ best={y:y,box:b}; break; }
              y += dirs[di]*(L.size+4); } }
          if(!best){ var y2=base, b2=anBox(L,y2);
            if(b2.y0<PADT+2) y2+=(PADT+2-b2.y0); else if(b2.y1>PADT+PH-2) y2-=(b2.y1-(PADT+PH-2));
            best={y:y2, box:anBox(L,y2)}; }
          L.y=best.y; placed.push(best.box);
          var t=svgEl('text',{x:L.x,y:L.y,fill:L.fill,'font-size':L.size,'font-weight':'bold','text-anchor':L.anchor});
          if(L.style==='italic') t.setAttribute('font-style','italic');
          t.textContent=L.text; annoG.appendChild(t);
        });

        svg.appendChild(annoG);
      }

      // interaction overlay
      var ov=svgEl('rect',{x:PADL,y:PADT,width:PW,height:PH,fill:'transparent',cursor:'crosshair'});
      svg.appendChild(ov);
      var guide=svgEl('line',{x1:0,y1:PADT,x2:0,y2:PADT+PH,stroke:'#60a5fa','stroke-width':1,opacity:0,'pointer-events':'none'});
      svg.appendChild(guide);
      var hoverDots=svgEl('g',{'pointer-events':'none'}); svg.appendChild(hoverDots);
      var brush=svgEl('rect',{x:0,y:PADT,width:0,height:PH,fill:'#60a5fa22',stroke:'#60a5fa','stroke-width':0.5,'pointer-events':'none',opacity:0}); svg.appendChild(brush);

      // viewport px ratio for tooltip placement
      function clientToSvgX(clientX){ var r=svg.getBoundingClientRect(); return (clientX-r.left)/r.width*W; }
      // expose live geometry to the once-bound window drag handlers
      ctx.isHist=isHist; ctx.brush=brush; ctx.clientToSvgX=clientToSvgX;
      function showTip(html, svgx){ var r=svg.getBoundingClientRect(); var leftPx=(svgx/W)*r.width; tip.innerHTML=html; tip.style.display='block';
        var tw=tip.offsetWidth; var lp=leftPx+12; if(lp+tw>r.width) lp=leftPx-tw-12; if(lp<0) lp=4; tip.style.left=lp+'px'; tip.style.top='10px'; }
      function hideTip(){ tip.style.display='none'; guide.setAttribute('opacity',0); while(hoverDots.firstChild) hoverDots.removeChild(hoverDots.firstChild); }

      ov.onmousemove=function(ev){ if(ctx.dragging){ return; }
        var sx=clientToSvgX(ev.clientX); var dataX=pxToX(sx);
        while(hoverDots.firstChild) hoverDots.removeChild(hoverDots.firstChild);
        if(isHist){
          var idx=Math.round(dataX); if(idx<0||idx>=cfg.bars.length){ hideTip(); return; }
          var b=cfg.bars[idx]; var px=xToPx(b.i);
          guide.setAttribute('x1',px); guide.setAttribute('x2',px); guide.setAttribute('opacity',0.6);
          hoverDots.appendChild(svgEl('circle',{cx:px,cy:yToPx(b.y),r:3.5,fill:(b.y>=0?'#22c55e':'#ef4444'),stroke:'#fff','stroke-width':1}));
          showTip('<b>#'+(idx+1)+'</b> '+shortMint(b.t.mint)+'<br>'+fts(b.t.entry_ts)+'<br>'+(cfg.unit==='SOL'?f4(b.y)+' SOL':fpct(b.y))+' · '+(b.t.exit_reason||'')+'<br>'+b.t.strategy_id, px);
        } else {
          // nearest point on first series by x
          var best=null,bestD=1e18,bestS=null;
          cfg.series.forEach(function(s){ for(var i=0;i<s.points.length;i++){ var d=Math.abs(s.points[i].x-dataX); if(d<bestD){bestD=d;best=s.points[i];bestS=s;} } });
          if(!best){ hideTip(); return; }
          var px=xToPx(best.x);
          guide.setAttribute('x1',px); guide.setAttribute('x2',px); guide.setAttribute('opacity',0.6);
          var html='<b>'+fts(best.x)+'</b>';
          cfg.series.forEach(function(s){ // find that series' point at same x (nearest)
            var sp=null,sd=1e18; for(var i=0;i<s.points.length;i++){ var d=Math.abs(s.points[i].x-best.x); if(d<sd){sd=d;sp=s.points[i];} }
            if(sp){ hoverDots.appendChild(svgEl('circle',{cx:xToPx(sp.x),cy:yToPx(sp.y),r:3.5,fill:s.color,stroke:'#fff','stroke-width':1}));
              var vstr=(cfg.unit==='SOL')?f4(sp.y)+' SOL':(cfg.unit==='%'?fpct(sp.y):(cfg.unit==='ms'?fint(sp.y)+' ms':fint(sp.y)));
              html+='<br><span style="color:'+s.color+'">■</span> '+(cfg.series.length>1?s.name+': ':'')+vstr;
              if(sp.t && sp.t.mint && cfg.series.length===1) html+='<br>'+shortMint(sp.t.mint)+' · '+(sp.t.exit_reason||sp.t.status);
            }
          });
          showTip(html, px);
        }
      };
      ov.onmouseleave=function(){ if(!ctx.dragging) hideTip(); };

      // drag-to-zoom: start here; window-level move/up handlers (bound once in
      // makeChart) read ctx for live geometry.
      ov.onmousedown=function(ev){ ctx.dragging=true; ctx.dragStartX=clientToSvgX(ev.clientX); brush.setAttribute('opacity',1); hideTip(); ev.preventDefault(); };
      svg.ondblclick=function(){ ctx.xv=null; document.getElementById('lt-reset-zoom').style.display='none'; draw(); };
    }

    // ── export the chart as a shareable PNG ─────────────────────────────────
    // Clones the live SVG, wraps it with a title / subtitle / axis titles /
    // footer so the image is self-explanatory on social media, rasterizes at 2x
    // for crisp output, then copies to clipboard (falling back to download).
    function renderBlob(){
      return new Promise(function(resolve, reject){
        var cfg=ctx.cfg; if(!cfg){ reject(new Error('no chart')); return; }
        var ML=26, MR=16, MT=62, MB=58;          // export margins around the W×H chart
        var EW=ML+W+MR, EH=MT+H+MB;
        var SVGNS='http://www.w3.org/2000/svg';
        var out=document.createElementNS(SVGNS,'svg');
        out.setAttribute('xmlns',SVGNS);
        out.setAttribute('width',EW); out.setAttribute('height',EH);
        out.setAttribute('viewBox','0 0 '+EW+' '+EH);
        out.setAttribute('font-family',"'Helvetica Neue',Helvetica,Arial,sans-serif");
        function t(x,y,txt,attrs){ var e=document.createElementNS(SVGNS,'text');
          e.setAttribute('x',x); e.setAttribute('y',y); for(var k in attrs) e.setAttribute(k,attrs[k]); e.textContent=txt; out.appendChild(e); }
        // backdrop
        var bg=document.createElementNS(SVGNS,'rect'); bg.setAttribute('width',EW); bg.setAttribute('height',EH); bg.setAttribute('fill','#0c0c14'); out.appendChild(bg);
        // title + subtitle
        t(ML, 28, cfg.title||'Performance Chart', {fill:'#f1f5f9','font-size':21,'font-weight':'700'});
        var sub='';
        if(cfg.type==='hist'){ sub=(cfg.bars?cfg.bars.length:0)+' trades'; }
        else { var pts=(cfg.series&&cfg.series[0])?cfg.series[0].points:[];
          var vr=ctx.xv||ctx.fullX||null;
          var vis=vr? pts.filter(function(p){return p.x>=vr[0]-1e-9 && p.x<=vr[1]+1e-9;}) : pts;
          if(vis.length) sub=fts(vis[0].x)+' – '+fts(vis[vis.length-1].x)+' · '+vis.length+' trades'; }
        if(cfg.scope) sub += (sub?'   ·   ':'')+cfg.scope;
        if(sub) t(ML, 48, sub, {fill:'#94a3b8','font-size':12});
        // clone the live chart body into a translated group
        var g=document.createElementNS(SVGNS,'g'); g.setAttribute('transform','translate('+ML+','+MT+')');
        for(var i=0;i<svg.childNodes.length;i++){ g.appendChild(svg.childNodes[i].cloneNode(true)); }
        out.appendChild(g);
        // axis titles
        var yTitle=cfg.unit==='SOL'?'SOL':(cfg.unit==='%'?'%':(cfg.unit==='ms'?'ms':'count'));
        var yt=document.createElementNS(SVGNS,'text'); var ycy=MT+PADT+PH/2;
        yt.setAttribute('transform','translate(13,'+ycy+') rotate(-90)'); yt.setAttribute('text-anchor','middle');
        yt.setAttribute('fill','#94a3b8'); yt.setAttribute('font-size',11); yt.textContent=yTitle; out.appendChild(yt);
        t(ML+PADL+PW/2, MT+H+18, cfg.type==='hist'?'Trade #':'Time', {fill:'#94a3b8','font-size':11,'text-anchor':'middle'});
        // footer
        t(ML, EH-9, 'Captured '+new Date().toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}), {fill:'#64748b','font-size':10});
        t(EW-MR, EH-9, 'post-graduation PumpFun trading research', {fill:'#475569','font-size':10,'text-anchor':'end'});

        var xml=new XMLSerializer().serializeToString(out);
        var url='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(xml)));
        var img=new Image();
        img.onload=function(){
          var scale=2, canvas=document.createElement('canvas');
          canvas.width=EW*scale; canvas.height=EH*scale;
          var c=canvas.getContext('2d'); c.fillStyle='#0c0c14'; c.fillRect(0,0,canvas.width,canvas.height);
          c.drawImage(img,0,0,canvas.width,canvas.height);
          canvas.toBlob(function(b){ b?resolve(b):reject(new Error('toBlob failed')); },'image/png');
        };
        img.onerror=function(){ reject(new Error('svg load failed')); };
        img.src=url;
      });
    }
    function download(blob){ var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
      a.download='chart-'+Date.now()+'.png'; document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },1500); }

    return {
      update:function(cfg){ ctx.cfg=cfg; if(cfg.resetView){ ctx.xv=null; } draw(); },
      resetZoom:function(){ ctx.xv=null; draw(); },
      toggleMenu:toggleAnnoMenu,
      // copyImage(cb): copies the chart PNG to the clipboard, or downloads it if
      // clipboard image-write isn't available. cb('copied'|'downloaded'|'error').
      copyImage:function(cb){
        var p=renderBlob();
        if(navigator.clipboard && window.ClipboardItem){
          try{
            navigator.clipboard.write([new window.ClipboardItem({'image/png':p})])
              .then(function(){ cb&&cb('copied'); })
              .catch(function(){ p.then(function(b){ download(b); cb&&cb('downloaded'); }).catch(function(){ cb&&cb('error'); }); });
          }catch(e){ p.then(function(b){ download(b); cb&&cb('downloaded'); }).catch(function(){ cb&&cb('error'); }); }
        } else {
          p.then(function(b){ download(b); cb&&cb('downloaded'); }).catch(function(){ cb&&cb('error'); });
        }
      }
    };
  }

  // ── metric & comparison rendering (uses server-computed numbers) ──
  // ── client-side metrics + comparison (mirror of the server TS helpers) ──
  // Computed fresh from the selected subset of live trades so ANY multi-select
  // combination works, not just single-strategy / all. Mirrors computeMetrics /
  // computeComparison in src/api/live-training-data.ts.
  function jround(v,d){ if(v===null||v===undefined||!isFinite(v)) return null; var f=Math.pow(10,d===undefined?4:d); return Math.round(v*f)/f; }
  function jmean(xs){ if(!xs.length) return null; var s=0; for(var i=0;i<xs.length;i++) s+=xs[i]; return s/xs.length; }
  function jmedian(xs){ if(!xs.length) return null; var s=xs.slice().sort(function(a,b){return a-b;}); var m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; }
  function jstd(xs){ if(xs.length<2) return null; var m=jmean(xs); var v=0; for(var i=0;i<xs.length;i++){var d=xs[i]-m; v+=d*d;} return Math.sqrt(v/xs.length); }
  function jpctl(xs,p){ if(!xs.length) return null; var s=xs.slice().sort(function(a,b){return a-b;}); return s[Math.min(s.length-1,Math.max(0,Math.floor(p*(s.length-1))))]; }
  function notNull(xs){ var o=[]; for(var i=0;i<xs.length;i++) if(xs[i]!==null&&xs[i]!==undefined&&isFinite(xs[i])) o.push(xs[i]); return o; }

  function jsComputeMetrics(trades){
    var closed=[],failed=[],open=[];
    for(var i=0;i<trades.length;i++){ var s=trades[i].status; if(s==='closed') closed.push(trades[i]); else if(s==='failed') failed.push(trades[i]); else if(s==='open') open.push(trades[i]); }
    var wins=[],losses=[];
    for(var i=0;i<closed.length;i++){ ((num(closed[i].net_profit_sol)||0)>0?wins:losses).push(closed[i]); }
    var netSols=closed.map(function(t){return num(t.net_profit_sol)||0;});
    var returns=notNull(closed.map(function(t){return num(t.net_return_pct);}));
    var holds=notNull(closed.map(function(t){return num(t.held_seconds);}));
    var grossWins=0; for(var i=0;i<wins.length;i++) grossWins+=num(wins[i].net_profit_sol)||0;
    var grossLosses=0; for(var i=0;i<losses.length;i++){ var v=num(losses[i].net_profit_sol)||0; if(v<0) grossLosses+=-v; }
    var entrySlips=notNull(closed.map(function(t){return num(t.entry_slip_pct);}));
    var exitSlips=notNull(closed.map(function(t){return num(t.exit_slip_pct);}));
    var rtSlips=notNull(closed.map(rt));
    var landMs=notNull(closed.map(function(t){return num(t.tx_land_ms);}));
    var sd=jstd(returns), mr=jmean(returns);
    var rc={}; for(var i=0;i<closed.length;i++){ var r=closed[i].exit_reason||'unknown'; rc[r]=(rc[r]||0)+1; }
    var totalFees=0,totalJito=0,totalNet=0;
    for(var i=0;i<closed.length;i++){ totalFees+=num(closed[i].fees_sol)||0; totalJito+=num(closed[i].jito_tip_sol)||0; }
    for(var i=0;i<netSols.length;i++) totalNet+=netSols[i];
    return {
      n_trades:trades.length, n_closed:closed.length, n_failed:failed.length, n_open:open.length,
      total_net_sol:jround(totalNet),
      win_rate_pct: closed.length? jround(wins.length/closed.length*100,1): null,
      profit_factor: grossLosses>0? jround(grossWins/grossLosses,2): (grossWins>0? null: 0),
      avg_winner_sol: jround(jmean(wins.map(function(t){return num(t.net_profit_sol)||0;}))),
      avg_loser_sol: jround(jmean(losses.map(function(t){return num(t.net_profit_sol)||0;}))),
      avg_winner_pct: jround(jmean(notNull(wins.map(function(t){return num(t.net_return_pct);}))),2),
      avg_loser_pct: jround(jmean(notNull(losses.map(function(t){return num(t.net_return_pct);}))),2),
      largest_winner_sol: jround(netSols.length? Math.max.apply(null,netSols): null),
      largest_loser_sol: jround(netSols.length? Math.min.apply(null,netSols): null),
      avg_net_return_pct: jround(mr,2), median_net_return_pct: jround(jmedian(returns),2),
      sharpe_like: (sd&&sd>0&&mr!==null)? jround(mr/sd,3): null,
      avg_holding_sec: jround(jmean(holds),0),
      avg_entry_slip_pct: jround(jmean(entrySlips),3), avg_exit_slip_pct: jround(jmean(exitSlips),3),
      avg_roundtrip_slip_pct: jround(jmean(rtSlips),3),
      total_fees_sol: jround(totalFees,6), total_jito_tip_sol: jround(totalJito,6),
      avg_tx_land_ms: jround(jmean(landMs),0),
      tx_land_p50_ms: jround(jpctl(landMs,0.5),0), tx_land_p90_ms: jround(jpctl(landMs,0.9),0),
      tx_land_max_ms: jround(landMs.length? Math.max.apply(null,landMs): null,0),
      execution_success_rate_pct: (closed.length+failed.length)>0? jround(closed.length/(closed.length+failed.length)*100,1): null,
      exit_reason_counts: rc
    };
  }

  // ── Slip-cap counterfactual (Tier 1) — mirrors computeSlipCapOverlay server-side ──
  var SLIP_CAP_FLIP_ON_TS = 1782408610; // 2026-06-25T17:30Z — keep in sync with live-training-data.ts
  var SLIP_CAP_LEVELS = [1,2,3];
  function jsComputeSlipCapWindow(trades, flipOnTs){
    var elig=trades.filter(function(t){return t.status==='closed'&&num(t.entry_slip_pct)!==null&&num(t.net_profit_sol)!==null;});
    function sumNet(xs){ var s=0; for(var i=0;i<xs.length;i++) s+=num(xs[i].net_profit_sol)||0; return s; }
    var baseNet=sumNet(elig);
    var startTs=null; for(var i=0;i<elig.length;i++){ var t=num(elig[i].entry_ts); if(t!==null&&(startTs===null||t<startTs)) startTs=t; }
    var slips=notNull(elig.map(function(t){return num(t.entry_slip_pct);}));
    var rows=SLIP_CAP_LEVELS.map(function(cap){
      var kept=elig.filter(function(t){return (num(t.entry_slip_pct)||0)<=cap;});
      var skipped=elig.filter(function(t){return (num(t.entry_slip_pct)||0)>cap;});
      var winners=skipped.filter(function(t){return (num(t.net_profit_sol)||0)>0;});
      var losers=skipped.filter(function(t){return (num(t.net_profit_sol)||0)<=0;});
      var keptWins=kept.filter(function(t){return (num(t.net_profit_sol)||0)>0;}).length;
      var keptNet=sumNet(kept);
      return { cap_pct:cap, kept_n:kept.length, skipped_n:skipped.length,
        kept_net_sol:jround(keptNet), skipped_net_sol:jround(sumNet(skipped)),
        improvement_sol:jround(keptNet-baseNet),
        winners_dropped_n:winners.length, winners_dropped_sol:jround(sumNet(winners)),
        losers_dropped_n:losers.length, losers_dropped_sol:jround(sumNet(losers)),
        kept_win_rate_pct:kept.length? jround(keptWins/kept.length*100,1): null,
        skipped_win_rate_pct:skipped.length? jround(winners.length/skipped.length*100,1): null };
    });
    return { window_start_ts:startTs, flip_on_ts:flipOnTs, n_eligible:elig.length,
      baseline_net_sol:jround(baseNet), avg_entry_slip_pct:jround(jmean(slips),3), rows:rows };
  }
  function jsComputeSlipCapOverlay(liveTr){
    var closed=liveTr.filter(function(t){return t.status==='closed';});
    return { flip_on_ts:SLIP_CAP_FLIP_ON_TS, caps_pct:SLIP_CAP_LEVELS,
      since_conception:jsComputeSlipCapWindow(closed,null),
      since_flip_on:jsComputeSlipCapWindow(closed.filter(function(t){return (num(t.entry_ts)||0)>=SLIP_CAP_FLIP_ON_TS;}),SLIP_CAP_FLIP_ON_TS) };
  }

  function jsComputeComparison(liveTr, shadowTr){
    var map=LT.mapping||{};
    var COPY_WIN=60; // tight mint+time fallback (mirror of COPY_MINT_MATCH_WINDOW_SEC); genuine twins enter <=5s apart
    var shIdx={}, shByMint={}, shByEvent={};
    for(var i=0;i<shadowTr.length;i++){ var s=shadowTr[i]; if(s.status!=='closed') continue;
      if(s.graduation_id!==null&&s.graduation_id!==undefined) shIdx[s.strategy_id+':'+s.graduation_id]=s;
      if(s.copy_event_id) shByEvent[s.strategy_id+':'+s.copy_event_id]=s;
      if(s.mint){ var mk=s.strategy_id+':'+s.mint; (shByMint[mk]=shByMint[mk]||[]).push(s); } }
    var usedMint={};
    var pairs=[], liveGross=[], shadowGross=[], liveLand=[], deltas=[];
    for(var i=0;i<liveTr.length;i++){ var lv=liveTr[i];
      if(lv.status!=='closed') continue;
      var sid=map[lv.strategy_id]; if(!sid) continue;
      var tw=null;
      if(lv.graduation_id!==null&&lv.graduation_id!==undefined){ tw=shIdx[sid+':'+lv.graduation_id]; }
      else if(lv.copy_event_id){ // deterministic copy join: same onLeadBuy() event id
        var ex=shByEvent[sid+':'+lv.copy_event_id]; if(ex&&!usedMint[ex.id]){ usedMint[ex.id]=1; tw=ex; } }
      if(!tw && (lv.graduation_id===null||lv.graduation_id===undefined) && lv.mint && !lv.copy_event_id){
        // pre-migration copy rows only: mint + closest entry within the widened window
        var cands=shByMint[sid+':'+lv.mint]||[], best=null, bestDiff=COPY_WIN+1;
        for(var j=0;j<cands.length;j++){ var c=cands[j]; if(usedMint[c.id]) continue; if(c.copy_event_id) continue;
          var diff=Math.abs((c.entry_ts||0)-(lv.entry_ts||0)); if(diff<=COPY_WIN&&diff<bestDiff){ best=c; bestDiff=diff; } }
        if(best){ usedMint[best.id]=1; tw=best; } }
      if(!tw) continue;
      var lr=rt(lv), sr=rt(tw);
      if(num(lv.gross_return_pct)!==null&&num(tw.gross_return_pct)!==null){ liveGross.push(num(lv.gross_return_pct)); shadowGross.push(num(tw.gross_return_pct)); }
      if(num(lv.tx_land_ms)!==null) liveLand.push(num(lv.tx_land_ms));
      // Size-match shadow net to the live trade's size (live 0.05 vs shadow 0.5 twin):
      // net scales linearly with size, so the cumulative-SOL chart + totals + deltas
      // are apples-to-apples. Return % is size-independent (left as-is).
      var lsz=num(lv.trade_size_sol), ssz=num(tw.trade_size_sol);
      var sizeAdj=(lsz&&ssz&&ssz>0)? lsz/ssz : 1;
      var twNet=(num(tw.net_profit_sol)||0)*sizeAdj;
      deltas.push((num(lv.net_profit_sol)||0)-twNet);
      pairs.push({ graduation_id:lv.graduation_id, mint:lv.mint, entry_ts:lv.entry_ts,
        live_return_pct:num(lv.net_return_pct), shadow_return_pct:num(tw.net_return_pct),
        return_delta_pct:(num(lv.net_return_pct)!==null&&num(tw.net_return_pct)!==null)? jround(num(lv.net_return_pct)-num(tw.net_return_pct),2): null,
        live_net_sol:num(lv.net_profit_sol), shadow_net_sol:jround(twNet,6),
        live_roundtrip_slip_pct:jround(lr,3), shadow_roundtrip_slip_pct:jround(sr,3) });
    }
    pairs.sort(function(a,b){return (a.entry_ts||0)-(b.entry_ts||0);});
    var liveRets=notNull(pairs.map(function(p){return p.live_return_pct;}));
    var shadowRets=notNull(pairs.map(function(p){return p.shadow_return_pct;}));
    var liveWins=0,shadowWins=0,liveTotal=0,shadowTotal=0;
    for(var i=0;i<pairs.length;i++){ if((num(pairs[i].live_net_sol)||0)>0) liveWins++; if((num(pairs[i].shadow_net_sol)||0)>0) shadowWins++; liveTotal+=num(pairs[i].live_net_sol)||0; shadowTotal+=num(pairs[i].shadow_net_sol)||0; }
    var liveRt=notNull(pairs.map(function(p){return p.live_roundtrip_slip_pct;}));
    var shadowRt=notNull(pairs.map(function(p){return p.shadow_roundtrip_slip_pct;}));
    var la=jmean(liveRets), sa=jmean(shadowRets);
    var lga=jmean(liveGross), sga=jmean(shadowGross);
    var grossGap=(lga!==null&&sga!==null)? lga-sga: null;
    var netGap=(la!==null&&sa!==null)? la-sa: null;
    var byAbs=deltas.slice().sort(function(a,b){return Math.abs(b)-Math.abs(a);});
    var totalDelta=0; for(var i=0;i<deltas.length;i++) totalDelta+=deltas[i];
    var top3=0; for(var i=0;i<Math.min(3,byAbs.length);i++) top3+=byAbs[i];
    // Longest consecutive win/loss streaks per side + divergence tally (pairs time-ordered).
    function jStreaks(getNet){ var mw=0,ml=0,cw=0,cl=0; for(var i=0;i<pairs.length;i++){ var n=getNet(pairs[i])||0; if(n>0){cw++;cl=0;if(cw>mw)mw=cw;} else {cl++;cw=0;if(cl>ml)ml=cl;} } return {win:mw,loss:ml}; }
    var liveStreak=jStreaks(function(p){return num(p.live_net_sol);}), shadowStreak=jStreaks(function(p){return num(p.shadow_net_sol);});
    var DIV_PP=15, divWorse=0, divBetter=0;
    for(var i=0;i<pairs.length;i++){ var dd=pairs[i].return_delta_pct; if(dd===null||dd===undefined) continue; if(dd<=-DIV_PP) divWorse++; else if(dd>=DIV_PP) divBetter++; }
    // ── run-rate projection + parent benchmark + adjusted live (mirrors server computeComparison) ──
    // Run rate on The Analyst's basis (anAssess): FULL-strategy net ÷ days since
    // first trade (floored at 7) × period, live-size normalized — so this panel's
    // Live SOL/mo MATCHES the Analyst headline, not a competing matched-subset figure.
    function firstTsOf(tss){ var m=null; for(var i=0;i<tss.length;i++){ var t=num(tss[i]); if(t!==null&&(m===null||t<m)) m=t; } return m; }
    function ageDaysOf(ft){ return ft===null? null : jround((Date.now()/1000-ft)/86400,1); }
    function runDaysOf(ft){ return ft===null? 7 : Math.max((Date.now()/1000-ft)/86400, 7); }
    function perPeriod(total,days,mult){ return days>0? jround((total/days)*mult,4): null; }
    var liveClosed=liveTr.filter(function(t){return t.status==='closed';});
    var liveSize=null; for(var i=0;i<liveClosed.length;i++){ var z=num(liveClosed[i].trade_size_sol); if(z&&z>0){liveSize=z;break;} }
    var liveFirstTs=firstTsOf(liveClosed.map(function(t){return t.entry_ts;}));
    var liveRunDays=runDaysOf(liveFirstTs);
    var liveNetFull=0; for(var i=0;i<liveClosed.length;i++) liveNetFull+=num(liveClosed[i].net_profit_sol)||0;
    // Build a size-normalized run-rate leg from a strategy-id→1 map over shadowTr.
    var origMap=(typeof LT!=='undefined'&&LT.original_mapping)? LT.original_mapping : {};
    function legFrom(mappedSet){
      var tr=shadowTr.filter(function(t){return t.status==='closed'&&mappedSet[t.strategy_id];});
      var nativeTotal=0; for(var i=0;i<tr.length;i++) nativeTotal+=num(tr[i].net_profit_sol)||0;
      var sz=null; for(var i=0;i<tr.length;i++){ var z2=num(tr[i].trade_size_sol); if(z2&&z2>0){sz=z2;break;} }
      var sn=(liveSize&&sz&&sz>0)? liveSize/sz : 1;
      var totalLive=tr.length? jround(nativeTotal*sn): null;
      var ft=firstTsOf(tr.map(function(t){return t.entry_ts;}));
      var rd=runDaysOf(ft);
      var keys=Object.keys(mappedSet); var sid=keys.length===1? keys[0]: null;
      return { strategy_id:sid, n:tr.length, age_days:ageDaysOf(ft), run_days:jround(rd,1),
        total_net_sol_live_size:totalLive, _size:sz,
        net_per_trade_live_size:(totalLive!==null&&tr.length)? jround(totalLive/tr.length,6): null,
        weekly_sol:totalLive===null? null: perPeriod(totalLive,rd,7),
        monthly_sol:totalLive===null? null: perPeriod(totalLive,rd,30) };
    }
    // Parent = ORIGINAL research strategy (original_mapping), the long-running trend.
    var mappedOriginal={}; for(var i=0;i<liveClosed.length;i++){ var osid=origMap[liveClosed[i].strategy_id]; if(osid) mappedOriginal[osid]=1; }
    var parentLeg=legFrom(mappedOriginal);
    // Pair shadow = dedicated same-age twin (LIVE_SHADOW_MAP) — the "ideal execution" leg.
    var mappedShadow={}; for(var i=0;i<liveClosed.length;i++){ var msid=map[liveClosed[i].strategy_id]; if(msid) mappedShadow[msid]=1; }
    var pairLeg=legFrom(mappedShadow);
    var parentSize=parentLeg._size;
    // Adjusted: FULL live net minus matched pairs where live underperformed shadow by >=ADJ_PP.
    var ADJ_PP=50;
    var blowupPairs=pairs.filter(function(p){return p.return_delta_pct!=null&&p.return_delta_pct<=-ADJ_PP;});
    var blowupLiveNet=0; for(var i=0;i<blowupPairs.length;i++) blowupLiveNet+=num(blowupPairs[i].live_net_sol)||0;
    var adjLiveNetFull=liveNetFull-blowupLiveNet;
    var runRate={ basis:'full_strategy_net / days_since_first_trade(min 7) x period (live-size normalized) — same basis as The Analyst',
      live_trade_size_sol:liveSize, parent_trade_size_sol:parentSize,
      live:{ first_entry_ts:liveFirstTs, age_days:ageDaysOf(liveFirstTs), run_days:jround(liveRunDays,1),
        n:liveClosed.length, total_net_sol:jround(liveNetFull),
        net_per_trade:liveClosed.length? jround(liveNetFull/liveClosed.length,6): null,
        weekly_sol:perPeriod(liveNetFull,liveRunDays,7), monthly_sol:perPeriod(liveNetFull,liveRunDays,30) },
      parent:parentLeg,
      pair:pairLeg,
      adjusted_live:{ divergence_pp_threshold:ADJ_PP, excluded_n:blowupPairs.length,
        total_net_sol:jround(adjLiveNetFull),
        weekly_sol:perPeriod(adjLiveNetFull,liveRunDays,7), monthly_sol:perPeriod(adjLiveNetFull,liveRunDays,30) } };
    return { matched_n:pairs.length, run_rate:runRate,
      live_total_net_sol:jround(liveTotal), shadow_total_net_sol:jround(shadowTotal), total_net_sol_delta:jround(liveTotal-shadowTotal),
      live_avg_return_pct:jround(la,2), shadow_avg_return_pct:jround(sa,2),
      avg_return_delta_pct:netGap!==null? jround(netGap,2): null,
      live_win_rate_pct: pairs.length? jround(liveWins/pairs.length*100,1): null,
      shadow_win_rate_pct: pairs.length? jround(shadowWins/pairs.length*100,1): null,
      live_avg_roundtrip_slip_pct:jround(jmean(liveRt),3), shadow_avg_roundtrip_slip_pct:jround(jmean(shadowRt),3),
      live_avg_gross_return_pct:jround(lga,2), shadow_avg_gross_return_pct:jround(sga,2),
      gross_gap_pp:jround(grossGap,2), cost_gap_pp:(netGap!==null&&grossGap!==null)? jround(netGap-grossGap,2): null,
      median_delta_sol:jround(jmedian(deltas)), delta_drop_top3_sol: deltas.length? jround(totalDelta-top3): null,
      live_avg_tx_land_ms:jround(jmean(liveLand),0), live_p90_tx_land_ms:jround(jpctl(liveLand,0.9),0),
      live_longest_win_streak:liveStreak.win, live_longest_loss_streak:liveStreak.loss,
      shadow_longest_win_streak:shadowStreak.win, shadow_longest_loss_streak:shadowStreak.loss,
      divergence_pp_threshold:DIV_PP, divergence_count:divWorse+divBetter, divergence_live_worse:divWorse, divergence_live_better:divBetter,
      pairs:pairs };
  }

  function metricsFor(){ return jsComputeMetrics(liveTrades()); }
  function comparisonFor(){ return jsComputeComparison(liveTrades(), LT.trades.shadow||[]); }
  function scopeLabel(){
    if(!state.selected.length) return '— active live strategies';
    if(state.selected.length===1) return '— '+state.selected[0];
    return '— '+state.selected.length+' strategies';
  }

  function metricCard(lab,val,cls){ return '<div class="lt-metric"><div class="lab">'+lab+'</div><div class="val '+(cls||'')+'">'+val+'</div></div>'; }
  function renderMetrics(){
    var m=metricsFor();
    var topReason='—'; var rc=m.exit_reason_counts||{}; var best=-1; for(var k in rc){ if(rc[k]>best){best=rc[k];topReason=k+' ('+rc[k]+')';} }
    var html='';
    html+=metricCard('Total SOL Profit', f4(m.total_net_sol)+' SOL', colorClass(m.total_net_sol));
    html+=metricCard('Trades (closed/failed/open)', m.n_closed+' / '+m.n_failed+' / '+m.n_open);
    html+=metricCard('Win Rate', m.win_rate_pct===null?'—':m.win_rate_pct+'%', (m.win_rate_pct!==null&&m.win_rate_pct>=50)?'green':(m.win_rate_pct!==null&&m.win_rate_pct<40?'red':'yellow'));
    html+=metricCard('Profit Factor', m.profit_factor===null?'∞':String(m.profit_factor), (m.profit_factor!==null&&m.profit_factor>=1?'green':'red'));
    html+=metricCard('Avg Winner', f4(m.avg_winner_sol)+' SOL ('+fpct(m.avg_winner_pct)+')','green');
    html+=metricCard('Avg Loser', f4(m.avg_loser_sol)+' SOL ('+fpct(m.avg_loser_pct)+')','red');
    html+=metricCard('Largest Winner / Loser', f4(m.largest_winner_sol)+' / '+f4(m.largest_loser_sol)+' SOL');
    html+=metricCard('Avg Net Return', fpct(m.avg_net_return_pct)+' (med '+fpct(m.median_net_return_pct)+')', colorClass(m.avg_net_return_pct));
    html+=metricCard('Sharpe-like (per-trade)', m.sharpe_like===null?'—':m.sharpe_like.toFixed(3), colorClass(m.sharpe_like));
    html+=metricCard('Avg Holding Time', fsec(m.avg_holding_sec));
    html+=metricCard('Avg Slippage (entry / exit)', fpctp(m.avg_entry_slip_pct)+' / '+fpctp(m.avg_exit_slip_pct));
    html+=metricCard('Avg Round-trip Slippage', fpctp(m.avg_roundtrip_slip_pct));
    html+=metricCard('Total Fees Paid', f4u(m.total_fees_sol)+' SOL');
    html+=metricCard('Total Jito Tips', f4u(m.total_jito_tip_sol)+' SOL');
    html+=metricCard('Avg Tx Land Time', m.avg_tx_land_ms===null?'—':fint(m.avg_tx_land_ms)+' ms');
    html+=metricCard('Execution Success Rate', m.execution_success_rate_pct===null?'—':m.execution_success_rate_pct+'%', (m.execution_success_rate_pct!==null&&m.execution_success_rate_pct>=95)?'green':'yellow');
    html+=metricCard('Top Exit Reason', topReason);
    document.getElementById('lt-metrics').innerHTML=html;
    document.getElementById('lt-metrics-scope').textContent=scopeLabel();
  }

  function diagCard(lab,val,sub,cls){ return '<div class="lt-metric"><div class="lab">'+lab+'</div><div class="val '+(cls||'')+'">'+val+'</div>'+(sub?'<div style="color:#64748b;font-size:10px;margin-top:2px">'+sub+'</div>':'')+'</div>'; }
  function renderDiagnostics(){
    var m=metricsFor();
    function ms(v){ return (v===null||v===undefined)?'—':fint(v)+' ms'; }
    // ~5s land time = mostly RPC fallback (slow). <1.5s = fast Jito landing.
    var landCls=(m.avg_tx_land_ms!==null&&m.avg_tx_land_ms>3000)?'red':(m.avg_tx_land_ms!==null&&m.avg_tx_land_ms>1500?'yellow':'green');
    var html='';
    html+=diagCard('Avg tx land time', ms(m.avg_tx_land_ms), 'p50 '+ms(m.tx_land_p50_ms)+' · p90 '+ms(m.tx_land_p90_ms), landCls);
    html+=diagCard('Worst tx land time', ms(m.tx_land_max_ms), 'slowest single fill');
    html+=diagCard('Avg entry slippage', fpctp(m.avg_entry_slip_pct), 'buy fill vs expected');
    html+=diagCard('Avg exit slippage', fpctp(m.avg_exit_slip_pct), 'sell fill vs expected');
    html+=diagCard('Execution success rate', m.execution_success_rate_pct===null?'—':m.execution_success_rate_pct+'%', 'closed / (closed+failed)', (m.execution_success_rate_pct!==null&&m.execution_success_rate_pct>=95)?'green':'yellow');
    html+=diagCard('Total fees + tips', f4u((m.total_fees_sol||0)+(m.total_jito_tip_sol||0))+' SOL', 'fees '+f4u(m.total_fees_sol)+' · tips '+f4u(m.total_jito_tip_sol));
    document.getElementById('lt-diag').innerHTML=html;
  }

  // Real <table> (3 fixed columns) — robust alignment vs the old flow grid.
  function cmpTr(lab, live, shadow){ return '<tr><td class="rl">'+lab+'</td><td>'+live+'</td><td>'+shadow+'</td></tr>'; }
  function cspan(v,fmt){ return '<span class="'+colorClass(v)+'">'+fmt+'</span>'; }
  function renderSlipCap(sc){
    function sgn(v){ return (v===null||v===undefined)?'—':((v>=0?'+':'')+f4(v)); }
    function win(w, title, sub){
      if(!w || w.n_eligible===0){
        return '<b>'+title+'</b> <span style="color:#64748b">'+sub+'</span>'
          +'<br><span style="color:#64748b">— no eligible fills in this window yet (accumulating going forward).</span>';
      }
      var h='<b>'+title+'</b> <span style="color:#64748b">'+sub+'</span>'
        +'<br>baseline (no cap): '+cspan(w.baseline_net_sol,f4(w.baseline_net_sol)+' SOL')
        +' on n='+w.n_eligible+' fills · avg entry slip '+fpctp(w.avg_entry_slip_pct);
      h+='<table class="lt-cmp-tbl" style="margin-top:6px"><thead><tr>'
        +'<th>cap</th><th>kept</th><th>book w/ cap</th><th>Δ vs base</th>'
        +'<th>dropped W/L</th><th>dropped net</th><th>drop win%</th></tr></thead><tbody>';
      for(var i=0;i<w.rows.length;i++){ var r=w.rows[i];
        h+='<tr><td>≤'+r.cap_pct+'%</td>'
          +'<td>'+r.kept_n+'/'+(r.kept_n+r.skipped_n)+'</td>'
          +'<td>'+cspan(r.kept_net_sol,f4(r.kept_net_sol))+'</td>'
          +'<td>'+cspan(r.improvement_sol,sgn(r.improvement_sol))+'</td>'
          +'<td><span class="green">'+r.winners_dropped_n+'W</span> / <span class="red">'+r.losers_dropped_n+'L</span></td>'
          +'<td>'+cspan(r.skipped_net_sol,f4(r.skipped_net_sol))+'</td>'
          +'<td>'+(r.skipped_win_rate_pct===null?'—':r.skipped_win_rate_pct+'%')+'</td></tr>';
      }
      h+='</tbody></table>';
      return h;
    }
    var hdr='<b>Slippage-cap counterfactual</b> <span style="color:#64748b">(Tier 1 — measurement only, no behavior change)</span>. '
      +'Drops closed live entries whose <i>realized</i> entry slip exceeded the cap = the revert outcome of an on-chain max-slip cap. '
      +'A good cut shows a positive Δ, mostly losers dropped (high "dropped net" loss, low drop win%), and few winners lost. '
      +'<span style="color:#64748b">Ignores the freed-concurrency-slot substitution (a reverted entry frees a slot live might refill).</span>';
    return hdr
      +'<div style="margin-top:8px">'+win(sc.since_conception,'Since live conception','(full backtest on realized slip)')+'</div>'
      +'<div style="margin-top:12px">'+win(sc.since_flip_on,'Since flip-on '+(sc.flip_on_ts?fts(sc.flip_on_ts):'—'),'(forward test from when the cap turns on)')+'</div>';
  }
  function renderComparison(){
    var c=comparisonFor();
    var body=document.getElementById('lt-cmp-body'), empty=document.getElementById('lt-cmp-empty');
    if(!c || c.matched_n===0){ body.style.display='none'; empty.style.display='block'; return; }
    empty.style.display='none'; body.style.display='block';
    var g='<table class="lt-cmp-tbl"><thead><tr>'
      +'<th>Metric</th><th style="color:#22d3ee">Live</th><th style="color:#a78bfa">Shadow</th></tr></thead><tbody>';
    g+=cmpTr('Matched graduations', c.matched_n, c.matched_n);
    g+=cmpTr('Total net SOL <span style="color:#64748b;font-weight:400">(matched only)</span>', cspan(c.live_total_net_sol,f4(c.live_total_net_sol)), cspan(c.shadow_total_net_sol,f4(c.shadow_total_net_sol)));
    g+=cmpTr('Avg return %', cspan(c.live_avg_return_pct,fpct(c.live_avg_return_pct)), cspan(c.shadow_avg_return_pct,fpct(c.shadow_avg_return_pct)));
    g+=cmpTr('Win rate', (c.live_win_rate_pct===null?'—':c.live_win_rate_pct+'%'), (c.shadow_win_rate_pct===null?'—':c.shadow_win_rate_pct+'%'));
    g+=cmpTr('Longest win streak', c.live_longest_win_streak, c.shadow_longest_win_streak);
    g+=cmpTr('Longest loss streak', c.live_longest_loss_streak, c.shadow_longest_loss_streak);
    g+=cmpTr('Avg round-trip slip', fpctp(c.live_avg_roundtrip_slip_pct), fpctp(c.shadow_avg_roundtrip_slip_pct));
    var rr=c.run_rate;
    g+='<tr class="lt-cmp-delta"><td class="rl">Divergences (|Δ|≥'+c.divergence_pp_threshold+'pp)</td><td colspan="2">'
      +'<b>'+c.divergence_count+'</b> of '+c.matched_n+' · '
      +cspan(-1,c.divergence_live_worse+' live worse')+' · '
      +cspan(1,c.divergence_live_better+' live better')+'</td></tr>';
    g+='<tr class="lt-cmp-delta"><td class="rl">Live − Shadow</td><td colspan="2">'
      +cspan(c.total_net_sol_delta,f4(c.total_net_sol_delta)+' SOL')+' · '
      +cspan(c.avg_return_delta_pct,fpct(c.avg_return_delta_pct)+' avg/trade')+'</td></tr>';
    g+='</tbody></table>';
    document.getElementById('lt-cmp-table').innerHTML=g;
    // Gap attribution + outlier + latency footer — the "why".
    function ms(v){ return (v===null||v===undefined)?'—':fint(v)+' ms'; }
    var att='<b>Gap attribution:</b> of the '+cspan(c.avg_return_delta_pct,fpct(c.avg_return_delta_pct))
      +' net return gap, '+cspan(c.gross_gap_pp,fpct(c.gross_gap_pp)+'pp')+' is exit timing/price (gross) and '
      +cspan(c.cost_gap_pp,fpct(c.cost_gap_pp)+'pp')+' is execution cost.'
      +'<br><b>Outlier check (n='+c.matched_n+'):</b> median Δ/trade '+cspan(c.median_delta_sol,f4(c.median_delta_sol)+' SOL')
      +' · Δ excl. top-3 |outliers| '+cspan(c.delta_drop_top3_sol,f4(c.delta_drop_top3_sol)+' SOL')+'.'
      +'<br><b>Live latency:</b> avg '+ms(c.live_avg_tx_land_ms)+' (p90 '+ms(c.live_p90_tx_land_ms)+') vs shadow 0 (modeled fill).';
    document.getElementById('lt-cmp-attrib').innerHTML=att;
    // Run-rate block: FULL-strategy projection on The Analyst's basis (so the Live
    // SOL/mo here EQUALS the Analyst headline), original-strategy benchmark, and an
    // adjusted-live that strips the worst execution blowups.
    var benchEl=document.getElementById('lt-cmp-bench');
    if(rr && benchEl){
      var liveMo=num(rr.live.monthly_sol), parMo=num(rr.parent.monthly_sol), adjMo=num(rr.adjusted_live.monthly_sol);
      // Trend check uses NET PER TRADE (size-normalized) — run-length-independent, so the
      // longer-running original is apples-to-apples with the <7d live/pair WITHOUT the
      // 7-day run-day floor that deflates the young legs in the SOL/mo figure.
      var liveNpt=num(rr.live.net_per_trade);
      var parNpt=(rr.parent?num(rr.parent.net_per_trade_live_size):null);
      var pairNpt=(rr.pair?num(rr.pair.net_per_trade_live_size):null);
      // "On track" = live net/trade within 25% of the original's (some execution drag expected).
      var onTrack=(liveNpt!==null&&parNpt!==null&&parNpt!==0)?(liveNpt>=parNpt*0.75):null;
      var verdict=onTrack===null?'—':(onTrack?'<span class="green">on track</span>':'<span class="red">lagging</span>');
      var sz=rr.live_trade_size_sol;
      function npt(v){ return v===null||v===undefined?'—':(v>=0?'+':'')+v.toFixed(5)+' SOL/trade'; }
      var b='<b>Run rate</b> — full strategy, net SOL ÷ days since first trade (min 7) × period'+(sz!=null?(', normalized to live size '+f4u(sz)+' SOL'):'')+'. Matches The Analyst / Metrics Summary.'
        +'<br><b>Live</b> ('+(rr.live.age_days==null?'—':rr.live.age_days+'d')+' old, '+f4(rr.live.total_net_sol)+' SOL total): '
        +cspan(rr.live.weekly_sol,f4(rr.live.weekly_sol)+' SOL/wk')+' · '+cspan(liveMo,f4(liveMo)+' SOL/mo')+'.'
        +'<br><b>Trend check</b> — net per trade, size-normalized to '+(sz!=null?f4u(sz):'0.05')+' SOL (run-length-independent — valid at any age, no run-day floor):'
        +'<br>&nbsp;&nbsp;· <b>original</b>'+(rr.parent.strategy_id?(' '+rr.parent.strategy_id):'')+' (n='+rr.parent.n+(rr.parent.age_days==null?'':', '+rr.parent.age_days+'d')+'): '+cspan(parNpt,npt(parNpt))
        +'<br>&nbsp;&nbsp;· <b>pair shadow</b> (n='+(rr.pair?rr.pair.n:0)+(rr.pair&&rr.pair.age_days!=null?(', '+rr.pair.age_days+'d'):'')+', ideal exec, same window): '+cspan(pairNpt,npt(pairNpt))
        +'<br>&nbsp;&nbsp;· <b>live</b> (n='+(rr.live.n==null?'—':rr.live.n)+'): '+cspan(liveNpt,npt(liveNpt))+' → '+verdict+' vs original.'
        +'<br><b>Adjusted live</b> (excl. '+rr.adjusted_live.excluded_n+' pair'+(rr.adjusted_live.excluded_n===1?'':'s')+' where live ≥'+rr.adjusted_live.divergence_pp_threshold+'pp worse than shadow): '
        +cspan(rr.adjusted_live.total_net_sol,f4(rr.adjusted_live.total_net_sol)+' SOL')+' total · '+cspan(adjMo,f4(adjMo)+' SOL/mo')+' projected.';
      benchEl.innerHTML=b;
    } else if(benchEl){ benchEl.innerHTML=''; }
    // Slip-cap counterfactual overlay (Tier 1) — computed on the currently-selected
    // live trades so it tracks the strategy selector, same as the rest of the panel.
    var scEl=document.getElementById('lt-cmp-slipcap');
    if(scEl){ scEl.innerHTML=renderSlipCap(jsComputeSlipCapOverlay(liveTrades())); }
    document.getElementById('lt-cmp-n').textContent=c.matched_n;
    // pairs table
    var tb=document.querySelector('#lt-cmp-pairs tbody'); var rows='';
    for(var i=0;i<c.pairs.length;i++){ var p=c.pairs[i];
      rows+='<tr><td>'+fts(p.entry_ts)+'</td><td style="font-family:monospace">'+shortMint(p.mint)+'</td>'
        +'<td class="'+colorClass(p.live_return_pct)+'">'+fpct(p.live_return_pct)+'</td>'
        +'<td class="'+colorClass(p.shadow_return_pct)+'">'+fpct(p.shadow_return_pct)+'</td>'
        +'<td class="'+colorClass(p.return_delta_pct)+'">'+fpct(p.return_delta_pct)+'</td>'
        +'<td>'+fpctp(p.live_roundtrip_slip_pct)+'</td><td>'+fpctp(p.shadow_roundtrip_slip_pct)+'</td></tr>';
    }
    tb.innerHTML=rows;
    // overlay chart: cumulative net SOL, live vs shadow, over matched pairs
    var ls=[], ss=[], la=0, sa=0;
    var sorted=c.pairs.slice().sort(function(a,b){return (a.entry_ts||0)-(b.entry_ts||0);});
    for(var i=0;i<sorted.length;i++){ la+=num(sorted[i].live_net_sol)||0; sa+=num(sorted[i].shadow_net_sol)||0;
      var x=sorted[i].entry_ts||i; ls.push({x:x,y:la,t:sorted[i]}); ss.push({x:x,y:sa,t:sorted[i]}); }
    cmpChart.update({type:'line',kind:'line',zero:true,unit:'SOL',series:[
      {name:'Live',color:'#22d3ee',points:ls},
      {name:'Shadow',color:'#a78bfa',points:ss,dashed:true}
    ],resetView:true});
  }

  // ── primary chart wiring ──
  function populateMetricSelect(){
    var sel=document.getElementById('lt-metric'); sel.innerHTML='';
    var list = state.type==='hist' ? HIST_METRICS : LINE_METRICS;
    var found=false;
    for(var i=0;i<list.length;i++){ var o=document.createElement('option'); o.value=list[i].key; o.textContent=list[i].label; sel.appendChild(o); if(list[i].key===state.metric) found=true; }
    if(!found){ state.metric=list[0].key; }
    sel.value=state.metric;
  }
  function renderPrimary(){
    var scope=scopeLabel().replace(/^—\s*/,'');
    if(state.type==='hist'){
      var h=buildHist(state.metric);
      primaryChart.update({type:'hist',bars:h.bars,unit:h.unit,resetView:true,title:h.label,scope:scope});
    } else {
      var s=buildLineSeries(state.metric);
      primaryChart.update({type:'line',kind:s.kind,zero:s.zero,unit:s.unit,memes:true,title:s.label,scope:scope,series:[{name:'Live',color:'#22d3ee',points:s.points}],resetView:true});
    }
  }

  function renderAll(){ renderPrimary(); renderMetrics(); renderDiagnostics(); renderComparison(); }

  // ── The Analyst: live AI-style commentary keyed to the 3.75 SOL/month goal ──
  // Self-contained persona — no API key, no per-view cost. Each "beat" it
  // recomputes the current scope's monthly run rate from the embedded live data,
  // classifies it into a tier, and streams a dry/sarcastic line: it roasts when
  // off-goal and grudgingly praises when clearing +3.75 SOL/mo. anPick() is the
  // single seam to later swap in a real LLM call (keep the (tier,stats)→string
  // contract; await a fetch to /api/roast and fall back to the local pool).
  var AN_GOAL=3.75;
  var AN_PERSONAS={ quant:{label:'Deadpan Quant'}, hype:{label:'Hype Man'}, doomer:{label:'Permabear Doomer'}, zen:{label:'Zen Monk'}, drill:{label:'Drill Sergeant'} };
  var AN={ feed:null, timer:null, paused:false, last:'', started:false, llm:'unknown', llmBadge:false, seq:0, typingEl:null, persona:'quant' };
  try{ var _p=localStorage.getItem('an-persona'); if(_p && AN_PERSONAS[_p]) AN.persona=_p; }catch(e){}
  function anM(v){ if(v===null||v===undefined||!isFinite(v)) return '0.00'; return (v>=0?'+':'')+v.toFixed(2); }
  function anS(v){ v=num(v); return v===null?'0 SOL':f4(v)+' SOL'; }
  function anW(v){ return (v===null||v===undefined)?'unknown':(v+'%'); }
  function anEta(s){ if(!(s.monthly>0)) return 'a geological era'; var d=AN_GOAL/(s.monthly/30); return d>60?((d/30).toFixed(1)+' months'):(Math.round(d)+' days'); }

  // assess current scope vs the goal → tier + stats for interpolation
  function anAssess(){
    var ts=liveTrades(); var m=jsComputeMetrics(ts);
    var firstTs=null; for(var i=0;i<ts.length;i++){ if(ts[i].status==='closed'&&ts[i].entry_ts!=null){ if(firstTs===null||ts[i].entry_ts<firstTs) firstTs=ts[i].entry_ts; } }
    var days=firstTs!==null?Math.max((Date.now()/1000-firstTs)/86400,7):7;
    var net=m.total_net_sol||0;
    var monthly=(m.n_closed>0)?(net/days*30):0;
    var dd=0; try{ var pts=buildLineSeries('cum_sol').points, pk=-1e18;
      for(var i=0;i<pts.length;i++){ if(pts[i].y>pk) pk=pts[i].y; var d=pk-pts[i].y; if(d>dd) dd=d; } }catch(e){}
    var tier;
    if(m.n_closed<8) tier='wait';
    else if(net<0||monthly<0) tier='bad';
    else if(monthly<AN_GOAL) tier='cold';
    else if(monthly<AN_GOAL*2) tier='ok';
    else tier='good';
    return {tier:tier,monthly:monthly,net:net,n:m.n_closed,wr:m.win_rate_pct,
      worstLoss:m.largest_loser_sol,bestWin:m.largest_winner_sol,dd:dd,
      pct:(monthly/AN_GOAL*100),scope:scopeLabel().replace(/^—\s*/,'')};
  }

  // tier line pools — functions of the stats so jabs are data-aware
  var AN_LINES={
    wait:[
      function(s){return "Only "+s.n+" closed trades. I don't roast small samples — that's just bullying. The bar says n>=100 before anyone's allowed to feel anything.";},
      function(s){return s.n+" trades in. Statistically this is a rumor, not a track record. Wake me at 100.";},
      function(s){return "Not enough data to be mean yet. I'm very patient, and very disappointed in advance.";},
      function(s){return "Sample size "+s.n+". That's an anecdote, not an edge. Keep going.";}
    ],
    bad:[
      function(s){return "Run rate "+anM(s.monthly)+" SOL/month against a +3.75 goal. The arrow points at the floor and so does morale.";},
      function(s){return "Net "+anS(s.net)+" total. You've built a machine that converts SOL into tuition for lessons you keep failing.";},
      function(s){return "Win rate "+anW(s.wr)+". A coin flip would like its reputation back.";},
      function(s){return "Goal is +3.75/mo. You're at "+anM(s.monthly)+". At this pace you hit it shortly after the heat death of the universe.";},
      function(s){return "Worst drawdown -"+f4u(s.dd)+" SOL. That wasn't a dip, that was a confession.";},
      function(s){return "Biggest single loss "+anS(s.worstLoss)+". We don't talk about that trade. You know what you did.";},
      function(s){return "Bleeding "+anM(s.monthly)+" a month. The mempool says thanks for the donation.";},
      function(s){return "I asked the equity curve how it's doing and it just pointed at the stairs going down.";},
      function(s){return "A whole strategy called '"+s.scope+"' and this is the result. Bold to put a name on it.";}
    ],
    cold:[
      function(s){return anM(s.monthly)+" / 3.75 SOL a month. Green — technically. Like a participation trophy is technically a trophy.";},
      function(s){return "You're at "+Math.round(s.pct)+"% of the goal. The other "+Math.max(0,Math.round(100-s.pct))+"% is doing heavy lifting in your imagination.";},
      function(s){return "Up "+anS(s.net)+" all-time. Don't spend it on one priority fee.";},
      function(s){return "At this rate it takes ~"+anEta(s)+" to clear a single 3.75. Rent, meanwhile, is monthly.";},
      function(s){return "Positive but under target. The financial equivalent of 'we should hang out sometime.'";},
      function(s){return "Win rate "+anW(s.wr)+" and still only "+anM(s.monthly)+"/mo. The winners are shy, the losers load-bearing.";},
      function(s){return "Profitable-ish. The 'ish' is where I live.";}
    ],
    ok:[
      function(s){return anM(s.monthly)+" SOL/month — above the 3.75 line. I'm contractually required to say 'good job,' so: good job. Don't make it weird.";},
      function(s){return "Clearing the goal at "+Math.round(s.pct)+"% of target. Look at you, almost responsible.";},
      function(s){return "Net "+anS(s.net)+" and the run rate covers the bills. I'd celebrate, but I've seen the sequel.";},
      function(s){return "Hitting +3.75/mo. This is the calm, well-lit room right before the drawdown montage. Enjoy it.";},
      function(s){return "Above target. Suspicious. I'll allow it, but I'm watching the tape.";},
      function(s){return "Making money on memecoins. Either the edge is real or the market's generous. History votes generous.";}
    ],
    good:[
      function(s){return anM(s.monthly)+" SOL/month — about "+(s.monthly/AN_GOAL).toFixed(1)+"x the goal. Either the edge is real or I'm about to be very wrong on camera.";},
      function(s){return "Doubling the target. I'm not impressed, I'm just quietly recalculating my entire worldview.";},
      function(s){return "Net "+anS(s.net)+". Fine. FINE. It's good. There, I said it. Don't screenshot this.";},
      function(s){return "Crushing 3.75 by a mile. The part of the movie where everyone's happy and the music's nice. We both know the next scene.";},
      function(s){return "Best trade "+anS(s.bestWin)+", run rate "+anM(s.monthly)+"/mo. Touch grass while it lasts.";},
      function(s){return "Beating the goal "+(s.monthly/AN_GOAL).toFixed(1)+"x. I came to roast and I'm leaving grudgingly impressed. Disgusting.";}
    ]
  };
  function anOpener(s){
    if(s.tier==='wait') return "Booting up. "+s.n+" trades on the tape — not enough to start swinging. Yet.";
    if(s.tier==='bad') return "Alright, let's see the damage. Run rate "+anM(s.monthly)+" SOL/month vs a +3.75 goal. Oh. Oh no.";
    if(s.tier==='cold') return "Clocking in. Green but under the 3.75 line at "+anM(s.monthly)+"/mo. Mediocrity, my old friend.";
    if(s.tier==='ok') return "Tuning in. "+anM(s.monthly)+" SOL/month — above target. Suspicious, but allowed.";
    return "Well well. "+anM(s.monthly)+" SOL/month, "+(s.monthly/AN_GOAL).toFixed(1)+"x the goal. This better not be a setup.";
  }
  function anPick(tier,s){ var pool=AN_LINES[tier]||AN_LINES.wait, txt, g=0;
    do{ txt=pool[Math.floor(Math.random()*pool.length)](s); g++; }while(txt===AN.last && g<8); AN.last=txt; return txt; }
  function anTime(){ var d=new Date(),p=function(n){return(n<10?'0':'')+n;}; return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
  function anScroll(){ if(AN.feed) AN.feed.scrollTop=AN.feed.scrollHeight; }
  function anTyping(){ var w=document.createElement('div'); w.className='an-msg'; w.innerHTML='<span class="an-typing"><i></i><i></i><i></i></span>'; AN.feed.appendChild(w); anScroll(); return w; }
  function anAppend(text,tier){ var el=document.createElement('div'); el.className='an-msg t-'+tier;
    var ts=document.createElement('span'); ts.className='an-ts'; ts.textContent=anTime();
    var tx=document.createElement('span'); tx.className='an-tx'; tx.textContent=text;
    el.appendChild(ts); el.appendChild(tx); AN.feed.appendChild(el);
    while(AN.feed.children.length>60) AN.feed.removeChild(AN.feed.firstChild); anScroll(); }
  function anStatus(s){
    var pill=document.getElementById('an-pill');
    var map={wait:['WARMING UP','#94a3b8','#475569'],bad:['ROASTING','#fca5a5','#7f1d1d'],
      cold:['UNIMPRESSED','#fcd34d','#854d0e'],ok:['GRUDGING RESPECT','#86efac','#166534'],good:['STANDING OVATION','#5eead4','#115e59']};
    var v=map[s.tier]||map.wait; if(pill){ pill.textContent=v[0]; pill.style.color=v[1]; pill.style.borderColor=v[2]; }
    var g=document.getElementById('an-goal');
    if(g){ g.innerHTML = s.tier==='wait' ? ('gathering data · '+s.n+' trades')
      : ('<b>'+anM(s.monthly)+'</b> / 3.75 SOL/mo · <b>'+Math.round(s.pct)+'%</b> of goal'); }
  }
  // anShow: render one message, newest-wins. Each call bumps AN.seq and replaces
  // any pending typing bubble; if a newer call starts before this one resolves
  // (e.g. a slow Claude response), the stale one is dropped so the freshest
  // roast is always what lands on screen, in order.
  function anShow(producer, tier, floorMs){
    var myseq=++AN.seq;
    if(AN.typingEl && AN.typingEl.parentNode) AN.feed.removeChild(AN.typingEl);
    AN.typingEl=anTyping(); var t0=Date.now();
    Promise.resolve(producer()).then(function(r){
      if(myseq!==AN.seq || !r) return;
      var wait=Math.max(0,(floorMs||700)-(Date.now()-t0));
      setTimeout(function(){
        if(myseq!==AN.seq) return;
        if(AN.typingEl && AN.typingEl.parentNode) AN.feed.removeChild(AN.typingEl);
        AN.typingEl=null;
        anAppend(r.line, r.tier||tier); anSource(r.source);
      }, wait);
    });
  }
  // anProduce: try the real Claude endpoint (/api/roast); fall back to the local
  // pool on disabled/cooldown/error so the stream never stalls. Resolves
  // {line, source}. isOpener swaps the local fallback to the tier opener.
  function anProduce(s, isOpener, force){
    var local=function(){ return {line:(isOpener?anOpener(s):anPick(s.tier,s)), source:'local'}; };
    if(AN.llm==='off' || typeof fetch!=='function') return Promise.resolve(local());
    try{
      return fetch('/api/roast',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({monthly:s.monthly,net:s.net,n:s.n,winRate:s.wr,worstLoss:s.worstLoss,bestWin:s.bestWin,drawdown:s.dd,scope:s.scope,persona:AN.persona,mode:'line',force:!!force})})
        .then(function(resp){ return resp.ok?resp.json():null; })
        .then(function(j){
          if(j && j.source==='llm' && j.line){ AN.llm='on'; AN.last=j.line; return {line:j.line, source:'llm'}; }
          if(j && j.source==='disabled'){ AN.llm='off'; }
          return local();
        })
        .catch(function(){ return local(); });
    }catch(e){ return Promise.resolve(local()); }
  }
  function anSource(src){ if(src==='llm' && !AN.llmBadge){ AN.llmBadge=true;
    var sub=document.querySelector('#lt-analyst-card .an-sub');
    if(sub) sub.textContent='live commentary · powered by Claude · goal +3.75 SOL/mo'; } }
  function anEmit(s, isOpener, floorMs, force){ anShow(function(){ return anProduce(s, isOpener, force); }, s.tier, floorMs); }
  function anBeat(forced){ if(AN.paused&&!forced) return; var s=anAssess(); anStatus(s); anEmit(s,false,700); }
  // Manual "new take" — fires immediately (skips the timer + the beat cooldown),
  // works even while paused; the server throttles rapid clicks.
  function anNow(){ if(!AN.started) return; var s=anAssess(); anStatus(s); anEmit(s,false,400,true); }
  function anReact(kind){ if(!AN.started||AN.paused) return; var s=anAssess(); var line;
    if(kind==='scope'){ line="Now judging "+(s.scope||'the whole book')+". Let's see if this one's different. (They rarely are.)"; }
    else if(kind==='metric'){ var sel=document.getElementById('lt-metric'); var lbl=(sel&&sel.options[sel.selectedIndex])?sel.options[sel.selectedIndex].text:'that';
      line = state.metric==='cum_sol' ? "Back to the P&L — the only chart that keeps score." : ("Switching to "+lbl+"? Bold, staring at anything except the bottom line."); }
    else return;
    anStatus(s); anShow(function(){ return {line:line, source:'local'}; }, s.tier, 650);
  }

  // ── Recap card: a shareable PNG (title + stats + chart + an AI summary) ──
  var anMeasureCtx=null;
  function anWrap(text, font, maxW, maxLines){
    if(!anMeasureCtx) anMeasureCtx=document.createElement('canvas').getContext('2d');
    anMeasureCtx.font=font;
    var words=String(text||'').split(/\s+/), lines=[], cur='';
    for(var i=0;i<words.length;i++){ var t=cur?cur+' '+words[i]:words[i];
      if(anMeasureCtx.measureText(t).width>maxW && cur){ lines.push(cur); cur=words[i]; } else cur=t; }
    if(cur) lines.push(cur);
    if(maxLines && lines.length>maxLines){ lines=lines.slice(0,maxLines);
      var last=lines[maxLines-1];
      while(anMeasureCtx.measureText(last+'…').width>maxW && last.length>1) last=last.slice(0,-1);
      lines[maxLines-1]=last.replace(/[\s.,;:]+$/,'')+'…'; }
    return lines;
  }
  function anLocalRecap(s){ var a=anPick(s.tier,s), b=anPick(s.tier,s); return a+(b&&b!==a?' '+b:''); }
  function anFetchRecap(s){
    if(AN.llm==='off' || typeof fetch!=='function') return Promise.resolve(anLocalRecap(s));
    try{
      return fetch('/api/roast',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({monthly:s.monthly,net:s.net,n:s.n,winRate:s.wr,worstLoss:s.worstLoss,bestWin:s.bestWin,drawdown:s.dd,scope:s.scope,persona:AN.persona,mode:'recap'})})
        .then(function(r){ return r.ok?r.json():null; })
        .then(function(j){ if(j&&j.source==='llm'&&j.line){ AN.llm='on'; return j.line; } if(j&&j.source==='disabled') AN.llm='off'; return anLocalRecap(s); })
        .catch(function(){ return anLocalRecap(s); });
    }catch(e){ return Promise.resolve(anLocalRecap(s)); }
  }
  function anBuildCard(s, recap){
    var NS='http://www.w3.org/2000/svg', FS="'Helvetica Neue',Helvetica,Arial,sans-serif";
    var CW=1200, CH=630;
    var pos=s.monthly>=AN_GOAL, neg=(s.net<0||s.monthly<0);
    var accent=neg?'#ef4444':(pos?'#22c55e':'#22d3ee');
    var out=document.createElementNS(NS,'svg');
    out.setAttribute('xmlns',NS); out.setAttribute('width',CW); out.setAttribute('height',CH);
    out.setAttribute('viewBox','0 0 '+CW+' '+CH); out.setAttribute('font-family',FS);
    function txt(x,y,str,a){ a=a||{}; a.x=x; a.y=y; var e=svgEl('text',a); e.textContent=str; out.appendChild(e); return e; }
    function rect(a){ out.appendChild(svgEl('rect',a)); }
    rect({x:0,y:0,width:CW,height:CH,fill:'#0b0b12'});
    rect({x:0,y:0,width:CW,height:6,fill:accent,opacity:0.9});
    // header
    txt(48,58,(s.scope||'all active strategies'),{fill:'#f1f5f9','font-size':27,'font-weight':'700'});
    txt(48,84,'post-graduation PumpFun trading bot',{fill:'#94a3b8','font-size':15});
    txt(CW-48,56,((AN_PERSONAS[AN.persona]||{}).label||'The Analyst'),{fill:accent,'font-size':16,'font-weight':'700','text-anchor':'end'});
    txt(CW-48,80,(AN.llm==='on'?'powered by Claude':'The Analyst'),{fill:'#64748b','font-size':13,'text-anchor':'end'});
    // recap text
    var rlines=anWrap(recap,'italic 30px '+FS,CW-96,3);
    for(var i=0;i<rlines.length;i++){ txt(48,150+i*40,rlines[i],{fill:'#e2e8f0','font-size':30,'font-style':'italic','font-weight':'500'}); }
    // sparkline panel
    var px=48,py=300,pw=CW-96,ph=160;
    rect({x:px,y:py,width:pw,height:ph,fill:'#13131f',rx:10});
    txt(px+14,py+24,'Cumulative SOL P&L',{fill:'#64748b','font-size':13,'font-weight':'700'});
    var pts=[]; try{ pts=buildLineSeries('cum_sol').points; }catch(e){}
    if(pts.length>=2){
      var ip=18,plx=px+ip,ply=py+34,plw=pw-ip*2,plh=ph-34-16;
      var xs=pts.map(function(p){return p.x;}), ys=pts.map(function(p){return p.y;});
      var x0=Math.min.apply(null,xs),x1=Math.max.apply(null,xs);
      var ymin=Math.min.apply(null,ys.concat([0])),ymax=Math.max.apply(null,ys.concat([0]));
      if(x1===x0)x1=x0+1; if(ymax===ymin)ymax=ymin+1;
      var X=function(x){return plx+(x-x0)/(x1-x0)*plw;}, Y=function(y){return ply+(1-(y-ymin)/(ymax-ymin))*plh;};
      out.appendChild(svgEl('line',{x1:plx,y1:Y(0),x2:plx+plw,y2:Y(0),stroke:'#334155','stroke-width':1,'stroke-dasharray':'4 4'}));
      var d=''; for(var k=0;k<pts.length;k++){ d+=(k?'L':'M')+X(pts[k].x).toFixed(1)+' '+Y(pts[k].y).toFixed(1)+' '; }
      out.appendChild(svgEl('path',{d:d+'L'+X(pts[pts.length-1].x).toFixed(1)+' '+Y(0).toFixed(1)+' L'+X(pts[0].x).toFixed(1)+' '+Y(0).toFixed(1)+' Z',fill:accent,opacity:0.12}));
      out.appendChild(svgEl('path',{d:d,fill:'none',stroke:accent,'stroke-width':3}));
    } else { txt(px+pw/2,py+ph/2+6,'not enough trades to chart yet',{fill:'#475569','font-size':16,'text-anchor':'middle','font-style':'italic'}); }
    // stat tiles
    var tiles=[
      ['NET SOL', anS(s.net), s.net>=0?'#22c55e':'#ef4444'],
      ['RUN RATE / MO', anM(s.monthly)+' SOL', s.monthly>=AN_GOAL?'#22c55e':(s.monthly<0?'#ef4444':'#e2e8f0')],
      ['% OF GOAL', Math.round(s.pct)+'%', s.pct>=100?'#22c55e':'#e2e8f0'],
      ['WIN RATE', (s.wr==null?'—':s.wr+'%'), '#e2e8f0'],
      ['TRADES', String(s.n), '#e2e8f0']
    ];
    var tw=(CW-96)/tiles.length;
    for(var t=0;t<tiles.length;t++){ var tx0=48+t*tw;
      txt(tx0,496,tiles[t][0],{fill:'#64748b','font-size':13,'font-weight':'700','letter-spacing':'0.5'});
      txt(tx0,530,tiles[t][1],{fill:tiles[t][2],'font-size':28,'font-weight':'700'}); }
    // footer
    var dt=new Date();
    txt(48,CH-22,'Captured '+dt.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),{fill:'#64748b','font-size':13});
    txt(CW-48,CH-22,(neg?"it's so over":(pos?'we are so back':'warming up')),{fill:accent,'font-size':16,'font-weight':'700','font-style':'italic','text-anchor':'end'});
    return {svg:out, w:CW, h:CH};
  }
  function anSvgBlob(svg, W, H){
    return new Promise(function(resolve,reject){
      var xml=new XMLSerializer().serializeToString(svg);
      var img=new Image();
      img.onload=function(){ var sc=2,c=document.createElement('canvas'); c.width=W*sc; c.height=H*sc;
        var x=c.getContext('2d'); x.fillStyle='#0b0b12'; x.fillRect(0,0,c.width,c.height);
        x.drawImage(img,0,0,c.width,c.height); c.toBlob(function(bl){ bl?resolve(bl):reject(new Error('toBlob')); },'image/png'); };
      img.onerror=function(){ reject(new Error('img')); };
      img.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(xml)));
    });
  }
  function anCardDownload(bl){ var a=document.createElement('a'); a.href=URL.createObjectURL(bl);
    a.download='recap-'+Date.now()+'.png'; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },1500); }
  function anCardCopy(p, cb){
    if(navigator.clipboard && window.ClipboardItem){
      try{ navigator.clipboard.write([new window.ClipboardItem({'image/png':p})])
        .then(function(){ cb&&cb('copied'); })
        .catch(function(){ p.then(function(b){ anCardDownload(b); cb&&cb('downloaded'); }).catch(function(){ cb&&cb('error'); }); });
      }catch(e){ p.then(function(b){ anCardDownload(b); cb&&cb('downloaded'); }).catch(function(){ cb&&cb('error'); }); }
    } else { p.then(function(b){ anCardDownload(b); cb&&cb('downloaded'); }).catch(function(){ cb&&cb('error'); }); }
  }
  function anRecap(btn){
    var old=btn.textContent; btn.disabled=true; btn.style.opacity='0.7'; btn.textContent='Generating…';
    var s=anAssess();
    anFetchRecap(s).then(function(text){
      btn.textContent='Rendering…';
      var card=anBuildCard(s, text);
      anCardCopy(anSvgBlob(card.svg, card.w, card.h), function(res){
        btn.textContent = res==='copied'?'Copied!':(res==='downloaded'?'Saved PNG':'Failed — retry');
        setTimeout(function(){ btn.textContent=old; btn.disabled=false; btn.style.opacity='1'; }, 2100);
      });
    });
  }
  function anStart(){
    AN.feed=document.getElementById('lt-analyst-feed'); if(!AN.feed) return; AN.started=true;
    var s=anAssess(); anStatus(s); anEmit(s,true,600);
    AN.timer=setInterval(anBeat, (typeof AN_BEAT_MS==='number' && AN_BEAT_MS>0)?AN_BEAT_MS:30000);
    var tg=document.getElementById('an-toggle');
    if(tg) tg.addEventListener('click', function(){ AN.paused=!AN.paused; this.textContent=AN.paused?'Resume':'Pause'; if(!AN.paused) anBeat(true); });
    var pf=document.getElementById('an-persona');
    if(pf){ pf.value=AN.persona;
      pf.addEventListener('change', function(){ AN.persona=this.value; try{ localStorage.setItem('an-persona',AN.persona); }catch(e){}
        if(AN.started && !AN.paused) anEmit(anAssess(), false, 500); }); }
    var nb=document.getElementById('an-now');
    if(nb) nb.addEventListener('click', function(){ var b=this; b.disabled=true; b.style.opacity='0.7';
      anNow(); setTimeout(function(){ b.disabled=false; b.style.opacity='1'; }, 700); });
    var rb=document.getElementById('an-recap');
    if(rb) rb.addEventListener('click', function(){ anRecap(this); });
  }

  // ── init ──
  var primaryChart, cmpChart;
  function init(){
    if(!LT.has_live_data){
      var f=document.getElementById('lt-analyst-feed');
      if(f) f.innerHTML='<div class="an-msg t-wait"><span class="an-tx">No live trades on the tape yet. I can’t roast a blank chart — that’s just yelling at a wall. Come back when there’s a P&L to insult.</span></div>';
      var p=document.getElementById('an-pill'); if(p){ p.textContent='STANDBY'; }
      var tg0=document.getElementById('an-toggle'); if(tg0) tg0.style.display='none';
      return;
    }
    primaryChart=makeChart(document.getElementById('lt-primary-wrap'), document.getElementById('lt-primary-tip'));
    cmpChart=makeChart(document.getElementById('lt-cmp-wrap'), document.getElementById('lt-cmp-tip'));
    // strategy chips — MULTI-SELECT. "All Live" (data-strat="") clears the
    // selection; clicking individual chips toggles them in/out of the set.
    // Selecting every individual chip, or toggling the last one off, reverts to
    // the All-Live aggregate.
    function syncChips(){
      var chips=document.querySelectorAll('.lt-strat-chip');
      var selMap={}; for(var i=0;i<state.selected.length;i++) selMap[state.selected[i]]=true;
      for(var i=0;i<chips.length;i++){ var id=chips[i].getAttribute('data-strat');
        var on = id==='' ? state.selected.length===0 : !!selMap[id];
        chips[i].classList.toggle('lt-active', on);
      }
    }
    document.getElementById('lt-strat-bar').addEventListener('click', function(ev){
      var btn=ev.target.closest('.lt-strat-chip'); if(!btn) return;
      var id=btn.getAttribute('data-strat')||'';
      if(id===''){ state.selected=[]; }
      else {
        var idx=state.selected.indexOf(id);
        if(idx>=0) state.selected.splice(idx,1); else state.selected.push(id);
      }
      syncChips();
      document.getElementById('lt-reset-zoom').style.display='none';
      renderAll();
      anReact('scope');
    });
    // type segment
    document.getElementById('lt-type-seg').addEventListener('click', function(ev){
      var btn=ev.target.closest('button'); if(!btn) return;
      state.type=btn.getAttribute('data-type');
      var bs=this.querySelectorAll('button'); for(var i=0;i<bs.length;i++) bs[i].classList.remove('lt-on');
      btn.classList.add('lt-on');
      document.getElementById('lt-metric-wrap').style.opacity = '1';
      document.getElementById('lt-reset-zoom').style.display='none';
      populateMetricSelect(); renderPrimary();
    });
    document.getElementById('lt-metric').addEventListener('change', function(){ state.metric=this.value; document.getElementById('lt-reset-zoom').style.display='none'; renderPrimary(); anReact('metric'); });
    document.getElementById('lt-reset-zoom').addEventListener('click', function(){ primaryChart.resetZoom(); this.style.display='none'; });
    document.getElementById('lt-overlays').addEventListener('click', function(ev){ ev.stopPropagation(); primaryChart.toggleMenu(); });
    document.getElementById('lt-copy-img').addEventListener('click', function(){
      var btn=this, old=btn.textContent; btn.disabled=true; btn.style.opacity='0.7'; btn.textContent='Rendering…';
      primaryChart.copyImage(function(res){
        btn.textContent = res==='copied'?'Copied!':(res==='downloaded'?'Saved PNG':'Failed — retry');
        setTimeout(function(){ btn.textContent=old; btn.disabled=false; btn.style.opacity='1'; },1900);
      });
    });
    populateMetricSelect();
    renderAll();
    anStart();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
</script>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Training</title>
${ICON_HEAD_TAGS}
<style>${STYLES}
  .card{background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px}
  .card-title{font-size:14px;font-weight:600;color:#94a3b8;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em}
  .table{width:100%;border-collapse:collapse;font-size:12px}
  .table th{text-align:left;padding:6px 8px;color:#64748b;border-bottom:1px solid #334155;font-weight:500}
  .table td{padding:5px 8px;border-bottom:1px solid #1e293b;vertical-align:top}
  .table tr:hover td{background:#1e3a5f22}
${pageStyles}
</style></head><body>
<nav><span class="title">Graduation Arb Research</span>${navHtml}</nav>
<div class="container">
  <h1 style="font-size:18px;color:#60a5fa;margin:0 0 4px">Live Training
    <span style="font-size:12px;color:#f59e0b;margin-left:8px;border:1px solid #f59e0b55;border-radius:4px;padding:1px 6px">LIVE MONEY</span>
    <button onclick="location.reload()" style="margin-left:12px;background:#334155;color:#94a3b8;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:11px">Refresh</button>
  </h1>
  <p style="color:#64748b;font-size:11px;margin:0 0 16px">Live-money execution only (live_micro / live_full) · Generated ${escHtml(generated)}</p>
  ${emptyState}
  ${liveSection}
  <details class="card" style="padding:0">
    <summary style="cursor:pointer;padding:12px 16px;color:#94a3b8;font-size:12px;font-weight:600">Live → Shadow mapping</summary>
    <div style="padding:0 16px 14px">
      <p style="color:#64748b;font-size:11px;margin:0 0 8px">Maintained in <code>LIVE_SHADOW_MAP</code> (src/api/live-training-data.ts). Add a row when launching a live strategy.</p>
      <table class="table"><thead><tr><th>Live strategy</th><th>Shadow twin</th></tr></thead><tbody>${mappingRows}</tbody></table>
    </div>
  </details>
  <details class="json-toggle">
    <summary>Raw JSON (for AI / API)</summary>
    <pre>${escHtml(JSON.stringify({ generated_at: data.generated_at, strategies: data.strategies, metrics: data.metrics, comparison: { all: data.comparison?.all } }, null, 2))}</pre>
  </details>
</div>
${js}
</body></html>`;
}

// ── PEAK ANALYSIS PAGE ───────────────────────────────────────────────
// Diagnostic-only surface for max_relret_0_300. The metric is look-ahead
// (only known at T+300), so peak-filters are intentionally absent from the
// filter leaderboards. This page exposes the data for TP calibration,
// exit-timing calibration, and filter-quality scoring.


export function renderSmartMoneyHtml(data: any): string {
  const d = data;

  if (d?.pending) {
    const body = `<div class="card"><h2>Smart Money</h2>
      <div class="desc">The token-selection analysis hasn't been computed yet. The CopytradeWorker
      computes it on boot and every ~3h from the scored-wallet leaderboard. Check back shortly.</div></div>`;
    return shell('Smart Money — Graduation Arb Research', '/smart-money', body, data as object);
  }

  const num = (v: any, dp = 2): string => (typeof v === 'number' && isFinite(v) ? v.toFixed(dp) : '—');
  const pct = (v: any): string => (typeof v === 'number' && isFinite(v) ? (v * 100).toFixed(1) + '%' : '—');
  const short = (a: string): string => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
  const dMag = (v: any): string => {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    const a = Math.abs(v);
    return a >= 0.8 ? 'large' : a >= 0.5 ? 'medium' : a >= 0.2 ? 'small' : 'negligible';
  };

  const ol = d.outcome_lift ?? {};
  const sp = ol.smart_present ?? {};
  const ba = ol.baseline_absent ?? {};
  const cov = d.coverage ?? {};

  const lowConf = d.low_confidence
    ? `<div class="card" style="border-color:#facc15"><div class="desc" style="color:#facc15;margin:0">
       ⚠ LOW CONFIDENCE — small smart set (${d.smart_set?.n_wallets ?? 0} wallets) or few smart-present
       graduations (${cov.actionable_present_grads ?? 0}). Numbers shown but treat as directional until coverage grows.</div></div>`
    : '';

  // ── header / coverage ──
  const headerCard = `<div class="card">
    <h2>Smart Money — token-selection analysis</h2>
    <div class="desc">Do the profitable wallets pick a detectable kind of token? If so we can replicate the
    SELECTION at our own T+30 entry — no copy-execution latency race. Smart set = <code>${d.smart_set?.definition ?? ''}</code></div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Smart wallets</span><span class="value">${d.smart_set?.n_wallets ?? 0}</span></div>
        <div class="stat"><span class="label">Tracked graduations analyzed</span><span class="value">${cov.tracked_graduations ?? 0}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Smart-present grads (0-30s, actionable)</span><span class="value green">${cov.actionable_present_grads ?? 0}</span></div>
        <div class="stat"><span class="label">Cache-present grads (any phase)</span><span class="value">${cov.cache_present_grads ?? 0}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Smart buy events (0-30s)</span><span class="value">${cov.smart_buy_events_actionable ?? 0}</span></div>
        <div class="stat"><span class="label">Computed</span><span class="value">${(d.generated_at ?? '').slice(0, 19)}</span></div>
      </div>
    </div>
    <div class="desc">${(cov.notes ?? []).map((n: string) => '• ' + n).join('<br>')}</div>
  </div>`;

  // ── M3 outcome lift (headline) ──
  const liftCls = typeof ol.pump_rate_lift_pp === 'number'
    ? (ol.pump_rate_lift_pp > 0 ? 'green' : 'red') : '';
  const ci = (c: any): string => (c ? `[${num(c.low, 1)}–${num(c.high, 1)}%]` : '');
  const gradedRows = (ol.by_smart_count ?? []).map((r: any) => `<tr>
      <td>${r.smart_buyers}</td><td>${r.n}</td><td>${pct(r.pump_rate)}</td><td>${num(r.avg_return_pct)}%</td></tr>`).join('');
  const outcomeCard = `<div class="card" style="border-color:#16a34a">
    <h2>Outcome lift — does smart-money presence predict winners? (headline)</h2>
    <div class="desc">Graduations where ≥1 smart wallet bought in the first 30s (detectable at our T+30 entry)
    vs those where none did. PUMP = label ≥ +10% by T+300. Avg return = T+30→T+300 buy-and-hold.</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Smart-present: PUMP rate</span><span class="value green">${pct(sp.pump_rate)} <span class="desc" style="display:inline">${ci(sp.pump_rate_ci)}</span></span></div>
        <div class="stat"><span class="label">Smart-present: avg return</span><span class="value">${num(sp.avg_return_pct)}% (n=${sp.n ?? 0})</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">No smart money: PUMP rate</span><span class="value">${pct(ba.pump_rate)} <span class="desc" style="display:inline">${ci(ba.pump_rate_ci)}</span></span></div>
        <div class="stat"><span class="label">No smart money: avg return</span><span class="value">${num(ba.avg_return_pct)}% (n=${ba.n ?? 0})</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">PUMP-rate lift</span><span class="value ${liftCls}">${typeof ol.pump_rate_lift_pp === 'number' ? (ol.pump_rate_lift_pp > 0 ? '+' : '') + num(ol.pump_rate_lift_pp) + ' pp' : '—'}</span></div>
        <div class="stat"><span class="label">p-value (two-prop)</span><span class="value ${typeof ol.p_value === 'number' && ol.p_value < 0.05 ? 'green' : 'yellow'}">${num(ol.p_value, 4)}</span></div>
      </div>
    </div>
    <h3>Graded by # of smart buyers (consensus)</h3>
    <table><tr><th>Smart buyers</th><th>n grads</th><th>PUMP rate</th><th>Avg return</th></tr>${gradedRows}</table>
  </div>`;

  // ── M2 feature signature ──
  const featRows = (d.feature_signature ?? []).slice(0, 25).map((f: any) => {
    const dCls = typeof f.cohens_d === 'number' ? (f.cohens_d > 0 ? 'green' : 'red') : '';
    return `<tr>
      <td>${f.display}</td>
      <td>${num(f.mean_smart, 3)}</td>
      <td>${num(f.mean_rest, 3)}</td>
      <td class="${dCls}">${typeof f.cohens_d === 'number' ? f.cohens_d.toFixed(3) : '—'} <span class="desc" style="display:inline">${dMag(f.cohens_d)}</span></td>
      <td>${f.n_smart}/${f.n_rest}</td>
      <td class="desc">${f.direction_hint}</td></tr>`;
  }).join('');
  const featureCard = `<div class="card">
    <h2>Feature signature — what kind of tokens do they pick?</h2>
    <div class="desc">Per-feature mean among smart-present graduations vs the rest, with Cohen's d effect size
    (|d|≥0.8 large, ≥0.5 medium, ≥0.2 small). Sorted by |d|. T+30-safe features only (PREDICTOR_WHITELIST).</div>
    <table><tr><th>Feature</th><th>Smart mean</th><th>Rest mean</th><th>Cohen's d</th><th>n smart/rest</th><th>Better when</th></tr>${featRows}</table>
  </div>`;

  // ── M1 timing/venue ──
  const ph = d.timing?.by_phase ?? {};
  const venueRows = Object.entries(d.timing?.by_venue ?? {})
    .sort((a: any, b: any) => b[1] - a[1])
    .map(([v, c]) => `<tr><td>${v}</td><td>${c}</td></tr>`).join('');
  const archRows = (d.timing?.per_wallet ?? []).slice(0, 20).map((w: any) => `<tr>
      <td style="font-family:monospace">${short(w.address)}</td><td>${w.grad_buys}</td>
      <td>${pct(w.pre_pct)}</td><td>${w.archetype}</td></tr>`).join('');
  const timingCard = `<div class="card">
    <h2>Timing & venue — are these tokens bought from launch?</h2>
    <div class="desc">From smart wallets' full history on tracked graduations (any phase). Pre-graduation =
    bonding-curve buy; post = after migration. Answers whether the edge is curve-sniping vs post-grad selection.</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Pre-graduation (bonding curve)</span><span class="value">${ph.pre_graduation?.events ?? 0} (${pct(ph.pre_graduation?.pct)})</span></div>
        <div class="stat"><span class="label">Post-graduation</span><span class="value">${ph.post_graduation?.events ?? 0} (${pct(ph.post_graduation?.pct)})</span></div>
      </div>
      <div><table><tr><th>Venue</th><th>Buys</th></tr>${venueRows || '<tr><td colspan=2 class="desc">no cache matches yet</td></tr>'}</table></div>
    </div>
    <h3>Per-wallet archetype (top 20 by tracked-grad buys)</h3>
    <table><tr><th>Wallet</th><th>Grad buys</th><th>Pre-grad %</th><th>Archetype</th></tr>${archRows || '<tr><td colspan=4 class="desc">no cache matches yet</td></tr>'}</table>
  </div>`;

  // ── M4 consensus ──
  const distRows = Object.entries(d.consensus?.distribution ?? {})
    .map(([k, v]) => `<tr><td>${k} smart buyer(s)</td><td>${v}</td></tr>`).join('');
  const pairRows = (d.consensus?.top_pairs ?? []).map((p: any) => `<tr>
      <td style="font-family:monospace">${short(p.a)}</td><td style="font-family:monospace">${short(p.b)}</td><td>${p.count}</td></tr>`).join('');
  const consensusCard = `<div class="card">
    <h2>Consensus & overlap</h2>
    <div class="desc">How often multiple smart wallets pile into the same token, and which wallets co-occur
    (potential clusters / shared signal source).</div>
    <div class="grid">
      <div><table><tr><th>Smart buyers</th><th># grads</th></tr>${distRows}</table></div>
      <div><table><tr><th>Wallet A</th><th>Wallet B</th><th>Co-buys</th></tr>${pairRows || '<tr><td colspan=3 class="desc">no co-occurring pairs yet</td></tr>'}</table></div>
    </div>
  </div>`;

  // ── M5 behavior ──
  const bz = d.behavior?.buy_size_sol ?? {};
  const hs = d.behavior?.hold_sec ?? {};
  const behaviorCard = `<div class="card">
    <h2>Behavior — do they size up on winners & cut losers fast?</h2>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Avg buy size on PUMP tokens</span><span class="value green">${num(bz.on_pump, 3)} SOL (n=${bz.n_pump ?? 0})</span></div>
        <div class="stat"><span class="label">Avg buy size on DUMP tokens</span><span class="value red">${num(bz.on_dump, 3)} SOL (n=${bz.n_dump ?? 0})</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Avg hold on PUMP tokens</span><span class="value">${hs.on_pump ?? '—'}s (n=${hs.n_pump ?? 0})</span></div>
        <div class="stat"><span class="label">Avg hold on DUMP tokens</span><span class="value">${hs.on_dump ?? '—'}s (n=${hs.n_dump ?? 0})</span></div>
      </div>
    </div>
  </div>`;

  // ── smart wallet set ──
  const walletRows = (d.smart_set?.wallets ?? []).map((w: any) => `<tr>
      <td style="font-family:monospace">${short(w.address)}</td>
      <td>${w.n_round_trips}</td>
      <td class="${w.total_realized_sol > 0 ? 'green' : 'red'}">${num(w.total_realized_sol, 2)}</td>
      <td class="${w.total_realized_sol_drop_top3 > 0 ? 'green' : 'red'}">${num(w.total_realized_sol_drop_top3, 2)}</td>
      <td>${num(w.monthly_run_rate_sol, 1)}</td>
      <td>${pct(w.win_rate)}</td></tr>`).join('');
  const walletCard = `<div class="card">
    <h2>Smart wallet set (${d.smart_set?.n_wallets ?? 0})</h2>
    <div class="desc">The analysis population — wallets whose money-edge survives drop_top3 + clears the monthly bar.</div>
    <table><tr><th>Wallet</th><th>Round trips</th><th>Total SOL</th><th>Drop top-3</th><th>Monthly</th><th>Win rate</th></tr>${walletRows || '<tr><td colspan=6 class="desc">none yet</td></tr>'}</table>
  </div>`;

  const body = lowConf + headerCard + outcomeCard + featureCard + timingCard + consensusCard + behaviorCard + walletCard;
  return shell('Smart Money — Graduation Arb Research', '/smart-money', body, data as object);
}

// ── COPY TRADES PAGE ──────────────────────────────────────────────────
// Shadow copy-trader (Option B, Phase 2). Separate from /trading — these
// positions live in the copy_trades table, not trades_v2.

export function renderCopyTradesHtml(data: any): string {
  const d = data;
  if (d?.pending) {
    const body = `<div class="card"><h2>Copy Trades</h2><div class="desc">No shadow copy trades computed yet —
      the copy-trader populates this once followed wallets start trading after deploy.</div></div>`;
    return shell('Copy Trades — Graduation Arb Research', '/copy-trades', body, data as object);
  }
  const n = (v: any, dp = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(dp) : '—');
  const pct = (v: any) => (typeof v === 'number' && isFinite(v) ? (v * 100).toFixed(1) + '%' : '—');
  const sol = (v: any) => (typeof v === 'number' && isFinite(v) ? `<span class="${v >= 0 ? 'green' : 'red'}">${v >= 0 ? '+' : ''}${v.toFixed(3)}</span>` : '—');
  // entry_ts is unix seconds; age is computed at render time (refresh to update).
  const fmtAge = (ts: any) => {
    if (typeof ts !== 'number' || !isFinite(ts)) return '—';
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const fmtClock = (ts: any) => {
    if (typeof ts !== 'number' || !isFinite(ts)) return '—';
    const dt = new Date(ts * 1000), p = (x: number) => String(x).padStart(2, '0');
    return `${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}Z`;
  };
  const ov = d.overall ?? {};

  // ── Regime banner: is NOW a good window to copy trade? (1-10 score) ────────
  const rg = d.regime ?? {};
  const rgc = rg.current ?? {};
  // 1-10 score → color, matching scoreBand() in copy-regime.ts.
  const scoreColor = (sc: number): string =>
    sc >= 8 ? '#16a34a' : sc >= 6 ? '#65a30d' : sc >= 5 ? '#ca8a04' : sc >= 3 ? '#ea580c' : '#dc2626';
  const curScore = rgc.score;
  const regimeColor = typeof curScore === 'number' ? scoreColor(curScore) : '#6b7280';
  // 72h hourly strip — one block per hour, height = |baseline net| that hour,
  // color = the 1-10 window score at that hour.
  const hours: any[] = rg.hourly ?? [];
  const maxAbsHour = Math.max(0.05, ...hours.map((h) => Math.abs(h.baseline_net_sol ?? 0)));
  const hourStrip = hours.map((h) => {
    const v = h.baseline_net_sol ?? 0;
    const hPx = Math.max(2, Math.round((Math.abs(v) / maxAbsHour) * 26));
    const col = typeof h.score === 'number' ? scoreColor(h.score) : '#6b7280';
    const dir = v >= 0 ? `margin-top:${28 - hPx}px` : 'margin-top:28px';
    return `<div title="${h.hour}  score ${h.score ?? '—'}/10 · base ${v >= 0 ? '+' : ''}${n(v, 2)} SOL (${h.baseline_n} closed, ${h.lead_buys} lead buys)"
      style="width:6px;height:${hPx}px;${dir};background:${col};opacity:${v === 0 ? 0.3 : 0.9};border-radius:1px"></div>`;
  }).join('');
  const regimeCard = !rg.current ? '' : `<div class="card" style="border-left:6px solid ${regimeColor}">
    <h2>Copy regime — <span style="color:${regimeColor}">${curScore ?? '—'}/10</span>
      <span class="desc" style="font-size:13px">${rgc.band ?? ''} · 24h trend ${rgc.score_24h ?? '—'}/10</span></h2>
    <div class="desc">Window quality 1 (worst) – 10 (best), rolling ${rg.scale?.window_hours ?? 6}h on the roster-stable
    baseline (${rg.baseline_strategy}); 5 = neutral. Driven by net SOL (±${rg.scale?.pnl_scale_sol ?? 2.5} = strong) +
    win-rate breadth, pulled toward neutral when &lt;${rg.scale?.min_trades_6h ?? 5} closed. copy-regime-hi enters at ≥7,
    copy-regime-mid at ≥5. Strip = last 72h hourly, colored by score.</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Score (6h)</span><span class="value" style="color:${regimeColor}">${curScore ?? '—'}/10</span></div>
        <div class="stat"><span class="label">Baseline net (6h)</span><span class="value">${sol(rgc.baseline_net_6h)} <span class="desc">(${rgc.baseline_n_6h ?? 0} closed)</span></span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Score (24h)</span><span class="value" style="color:${scoreColor(rgc.score_24h ?? 5)}">${rgc.score_24h ?? '—'}/10</span></div>
        <div class="stat"><span class="label">Baseline net (24h)</span><span class="value">${sol(rgc.baseline_net_24h)} <span class="desc">(${rgc.baseline_n_24h ?? 0} closed)</span></span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Whole-book net (6h)</span><span class="value">${sol(rgc.book_net_6h)} <span class="desc">(${rgc.book_n_6h ?? 0} closed)</span></span></div>
        <div class="stat"><span class="label">Lead activity (6h)</span><span class="value">${rgc.lead_buys_6h ?? 0} buys / ${rgc.active_leads_6h ?? 0} wallets</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Daily swing (mean ± std)</span><span class="value">${n(rg.swing?.daily_mean_sol)} ± ${n(rg.swing?.daily_std_sol)} SOL</span></div>
      </div>
    </div>
    <div style="display:flex;gap:1px;align-items:flex-start;height:58px;margin-top:8px">${hourStrip}</div>
  </div>`;

  // ── Macro banner: broad crypto market tailwind/headwind (1-10) ────────────
  const mac = d.macro ?? {};
  const macScore = mac.score;
  const macColor = typeof macScore === 'number' ? scoreColor(macScore) : '#6b7280';
  const macHist: any[] = mac.history ?? [];
  const macStrip = macHist.map((h) => {
    const col = typeof h.score === 'number' ? scoreColor(h.score) : '#6b7280';
    const hPx = Math.max(3, Math.round(((h.score ?? 5) / 10) * 26));
    return `<div title="${h.date}  score ${h.score ?? '—'}/10 · BTC $${h.btc_close != null ? Math.round(h.btc_close).toLocaleString() : '—'} · SOL $${h.sol_close != null ? n(h.sol_close, 0) : '—'}"
      style="width:11px;height:${hPx}px;margin-top:${28 - hPx}px;background:${col};opacity:0.9;border-radius:1px"></div>`;
  }).join('');
  const cmp = mac.components ?? {};
  const pctSpan = (v: any) => v == null ? '—' : `<span class="${v >= 0 ? 'green' : 'red'}">${v >= 0 ? '+' : ''}${n(v, 1)}%</span>`;
  const macroCard = (mac.pending || !mac.score) ? '' : `<div class="card" style="border-left:6px solid ${macColor}">
    <h2>Macro market (BTC) — <span style="color:${macColor}">${macScore ?? '—'}/10</span>
      <span class="desc" style="font-size:13px">${mac.band ?? ''} · as of ${mac.latest_date ?? '—'}</span></h2>
    <div class="desc">Broad crypto tailwind/headwind, 1 (worst) – 10 (best). BTC trend only: 0.4·(1-day) + 0.6·(7-day)
    through tanh; 5 = neutral. From market_daily (CoinGecko, no extra RPC). copy-macro enters at ≥6;
    copy-macro-regime needs macro ≥6 AND copy-regime ≥5. Strip = last 14 days. SOL/F&amp;G shown for context, not scored.</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">BTC 7d / 1d <span class="green">(scored)</span></span><span class="value">${pctSpan(cmp.btc_7d_pct)} <span class="desc">/ ${pctSpan(cmp.btc_1d_pct)}</span></span></div>
        <div class="stat"><span class="label">BTC / USD</span><span class="value">$${mac.btc_usd != null ? Math.round(mac.btc_usd).toLocaleString() : '—'}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">SOL 7d / 1d <span class="desc">(context)</span></span><span class="value">${pctSpan(cmp.sol_7d_pct)} <span class="desc">/ ${pctSpan(cmp.sol_1d_pct)}</span></span></div>
        <div class="stat"><span class="label">SOL / USD <span class="desc">(context)</span></span><span class="value">$${mac.sol_usd != null ? n(mac.sol_usd, 2) : '—'}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Fear &amp; Greed <span class="desc">(context)</span></span><span class="value">${cmp.fear_greed ?? '—'}</span></div>
      </div>
    </div>
    <div style="display:flex;gap:2px;align-items:flex-start;height:34px;margin-top:8px">${macStrip}</div>
  </div>`;

  // ── Promotion readiness: which copy strategies are ready for live-micro ───
  const promo = d.promotion ?? {};
  const gchip = (ok: boolean, label: string) =>
    `<span style="font-size:10px;padding:1px 4px;border-radius:3px;color:#fff;background:${ok ? '#16a34a' : '#6b7280'}">${label}${ok ? '✓' : '✗'}</span>`;
  // age = days since the strategy's first trade; — when it hasn't traded yet
  const formatAge = (dRaw: number | null | undefined): string => {
    if (dRaw == null) return '—';
    if (dRaw < 1) return '<1d';
    if (dRaw < 14) return `${Math.round(dRaw)}d`;
    return `${Math.round(dRaw / 7)}w`;
  };
  const promoRow = (r: any) => {
    const g = r.gates ?? {};
    return `<tr${r.promotable ? ' style="background:rgba(22,163,74,0.12)"' : (r.realistic_execution ? '' : ' style="opacity:0.6"')}>
      <td>${r.id}${r.promotable ? ' <span style="color:#16a34a">★</span>' : ''}</td>
      <td><b>${n(r.score, 0)}</b></td>
      <td>${r.n}</td>
      <td style="white-space:nowrap" title="${r.active_days != null ? `traded ${r.active_days} of ${r.age_days ?? '?'} days` : ''}">${formatAge(r.age_days)}</td>
      <td>${sol(r.net_sol)}</td>
      <td>${sol(r.drop_top3)}</td>
      <td>${sol(r.exit_stress)}</td>
      <td>${sol(r.monthly_run_rate_sol)}</td>
      <td style="white-space:nowrap"><span class="green">${r.max_win_streak ?? 0}W</span> / <span class="red">${r.max_loss_streak ?? 0}L</span></td>
      <td>${sol(r.max_drawdown_sol)}</td>
      <td style="white-space:nowrap">${gchip(g.realistic_execution, 'ex')} ${gchip(g.n_ge_100, 'n')} ${gchip(g.drop3_positive, 'd3')} ${gchip(g.stress_positive, 'st')} ${gchip(g.monthly_ge_bar, 'mo')}</td></tr>`;
  };
  const allRows = (promo.rows ?? []).filter((r: any) => r.n > 0);
  const realRows = allRows.filter((r: any) => r.realistic_execution).slice(0, 14);
  const idealRows = allRows.filter((r: any) => !r.realistic_execution).slice(0, 10);
  const thead = `<tr><th>Strategy</th><th>Score</th><th>n</th><th title="time since this strategy's first trade — proxy for how long it's been running; — = no trades yet">Age</th><th>Net</th><th>Drop3</th><th>Stress</th><th>SOL/mo</th><th title="longest consecutive wins / losses, in time order">Streak W/L</th><th title="deepest peak-to-trough decline in cumulative net SOL">Max DD</th><th>Gates</th></tr>`;
  const promoCard = !promo.rows ? '' : `<div class="card">
    <h2>Promotion readiness <span class="desc" style="font-size:13px">— ${promo.n_promotable ?? 0} promotable</span></h2>
    <div class="desc">PROMOTABLE (★, green) requires ALL: <b>realistic execution (5s entry delay)</b> · n≥100 ·
    drop-top3&gt;0 · exit-stress&gt;0 · monthly ≥${n(promo.monthly_bar_sol, 2)} SOL (~$300/mo). Score 0-100 =
    realistic-exec 20 + sample 20 + drop3 25 + stress 20 + monthly 15 — so an idealized mirror caps at <b>80</b>
    and can never reach 100; only a 5s-entry strategy can. <b>Streak W/L</b> = longest consecutive wins / losses;
    <b>Max DD</b> = deepest peak-to-trough drawdown in cumulative net SOL — the worst run you'd sit through live.</div>
    <h3 style="margin:10px 0 4px">① Realistic execution — 5s buy entry <span class="desc" style="font-size:12px">(live candidates — only these can be promoted)</span></h3>
    <table>${thead}${realRows.map(promoRow).join('') || '<tr><td colspan="10" class="desc">none with trades yet</td></tr>'}</table>
    <h3 style="margin:14px 0 4px">② Idealized mirror — ~1.1s snapshot <span class="desc" style="font-size:12px">(upper bound / reference only — NOT promotable, capped at 80)</span></h3>
    <table style="opacity:0.75">${thead}${idealRows.map(promoRow).join('') || '<tr><td colspan="10" class="desc">none</td></tr>'}</table>
  </div>`;

  // ── Live execution status: is real money actually trading? ────────────────
  const le = d.live_execution ?? {};
  const leCard = `<div class="card" style="border-left:6px solid ${le.confirmed_live ? '#dc2626' : '#6b7280'}">
    <h2>Live execution — <span style="color:${le.confirmed_live ? '#dc2626' : '#6b7280'}">${le.confirmed_live ? 'LIVE (real funds)' : 'not detected (shadow only)'}</span></h2>
    <div class="desc">A row with execution_mode=live_micro only exists when COPY_LIVE_ENABLED + wallet are active
    AND a real swap was submitted. ${le.confirmed_live
      ? `<b>Real money is trading.</b> ${le.open_live_positions ?? 0} open live position(s), ${le.closed_live_trades ?? 0} closed.`
      : `No live_micro rows yet — the live-micro strategy is running as a shadow (COPY_LIVE_ENABLED not active, no wallet, or no qualifying entry has fired yet).`}</div>
    ${(le.open_detail ?? []).length ? `<table><tr><th>Mint</th><th>Bought</th><th>Age</th><th>Entry SOL</th><th>Tracked tok</th><th>Wallet tok</th><th>Status</th><th>Tx sig</th></tr>${
      le.open_detail.map((o: any) => {
        const st = o.recon_status;
        const stColor = st === 'held' ? '#16a34a' : (st === 'settling' ? '#d97706' : (st === 'closing' ? '#6b7280' : '#6b7280'));
        const stLabel = st === 'held' ? 'held ✓' : (st ? st : 'unchecked');
        const wt = o.wallet_tokens != null ? n(o.wallet_tokens, 0) : '—';
        // Flag a tracked position whose wallet balance reads 0 (phantom pending reconcile).
        const wtColor = (o.wallet_tokens != null && o.wallet_tokens <= 0) ? '#dc2626' : 'inherit';
        return `<tr><td style="font-family:monospace">${o.mint}</td><td style="white-space:nowrap">${fmtClock(o.entry_ts)}</td><td style="white-space:nowrap">${fmtAge(o.entry_ts)}</td><td>${n(o.entry_price_sol, 9)}</td><td>${o.live_tokens != null ? n(o.live_tokens, 0) : '—'}</td><td style="color:${wtColor}">${wt}</td><td style="color:${stColor};white-space:nowrap">${stLabel}</td><td style="font-family:monospace">${o.tx_sig_entry ?? '—'}</td></tr>`;
      }).join('')
    }</table>
    <div class="desc" style="margin-top:6px">Wallet reconciliation ${le.reconciliation?.checked_at ? `last checked ${fmtAge(le.reconciliation.checked_at)} ago` : '— not run yet'}.
    <b>Wallet tok</b> = the bot's read of the REAL on-chain balance; <span style="color:#16a34a">held ✓</span> = chain matches the open row,
    <span style="color:#d97706">settling</span> = empty but too fresh to reconcile, <span style="color:#dc2626">wallet 0</span> = phantom (will close on the next sweep).</div>
    ${(le.reconciliation?.orphan_count ?? 0) > 0 ? `<div class="desc" style="margin-top:8px;color:#dc2626"><b>⚠ ${le.reconciliation.orphan_count} orphan token balance(s)</b> — mints the bot live-traded that are no longer tracked as open but still sit in the wallet (a sell/terminal-close left them behind). Manual review:</div>
    <table><tr><th>Mint</th><th>Wallet tokens</th></tr>${
      (le.reconciliation.orphans ?? []).map((o: any) => `<tr><td style="font-family:monospace">${o.mint}</td><td>${n(o.tokens, 0)}</td></tr>`).join('')
    }</table>` : ''}` : ''}
  </div>`;

  // ── Live vs shadow: real-fill gap for live_micro strategies ───────────────
  const lvs: any[] = (d.live_vs_shadow ?? []).filter((p: any) => (p.n_live_total ?? 0) > 0);
  const lvsCard = lvs.length === 0 ? '' : `<div class="card" style="border-left:6px solid #2563eb">
    <h2>Live vs Shadow <span class="desc" style="font-size:13px">— real execution gap (live_micro)</span></h2>
    <div class="desc">Each live_micro strategy paired with its identical shadow twin on the SAME lead-buy
    (same token, same entry decision) — so the gap is pure execution: real fills, slippage, timing, fees.
    Compared on <b>return %</b> (size-normalized: live trades 0.05 SOL, shadow 0.5). Exec gap &lt; 0 = live
    underperforms the model — the real-world cost of going live.</div>
    ${lvs.map((p: any) => `<div style="margin-top:8px">
      <div class="desc" style="font-size:12px">${p.live_id} vs ${p.shadow_id} — ${p.matched} matched of ${p.n_live_total} live</div>
      <table><tr><th>Metric</th><th>Live</th><th>Shadow</th></tr>
        <tr><td>Avg return / trade</td><td class="${p.live.avg_return_pct >= 0 ? 'green' : 'red'}">${n(p.live.avg_return_pct, 2)}%</td><td class="${p.shadow.avg_return_pct >= 0 ? 'green' : 'red'}">${n(p.shadow.avg_return_pct, 2)}%</td></tr>
        <tr><td>Win rate</td><td>${pct(p.live.win_rate)}</td><td>${pct(p.shadow.win_rate)}</td></tr>
        <tr><td>Total net SOL <span class="desc">(diff sizes)</span></td><td>${sol(p.live.total_net_sol)}</td><td>${sol(p.shadow.total_net_sol)}</td></tr>
        <tr><td><b>Exec gap (live − shadow)</b></td><td colspan="2" class="${p.exec_gap_pp >= 0 ? 'green' : 'red'}">${n(p.exec_gap_pp, 2)} pp over ${p.matched} matched</td></tr>
      </table></div>`).join('')}
  </div>`;

  // ── Daily book P&L bars — the swings, made visible ────────────────────────
  const daily: any[] = ov.daily ?? [];
  const last14 = daily.slice(-14);
  const maxAbsDay = Math.max(0.5, ...last14.map((x) => Math.abs(x.net_sol ?? 0)));
  const dayBars = last14.map((x) => {
    const v = x.net_sol ?? 0;
    const hPx = Math.max(3, Math.round((Math.abs(v) / maxAbsDay) * 60));
    const up = v >= 0;
    return `<div style="display:flex;flex-direction:column;align-items:center;width:52px">
      <div style="height:64px;display:flex;align-items:${up ? 'flex-end' : 'flex-start'}">
        <div title="${x.date}: ${up ? '+' : ''}${n(v, 2)} SOL on ${x.n} trades"
          style="width:34px;height:${hPx}px;background:${up ? '#16a34a' : '#dc2626'};border-radius:2px"></div>
      </div>
      <span class="desc" style="font-size:10px">${(x.date ?? '').slice(5)}</span>
      <span style="font-size:11px" class="${up ? 'green' : 'red'}">${up ? '+' : ''}${n(v, 1)}</span>
    </div>`;
  }).join('');
  const dailyCard = `<div class="card">
    <h2>Daily book P&L (last 14 days)</h2>
    <div class="desc">Whole-book net SOL per UTC day — lifetime totals hide these swings.</div>
    <div style="display:flex;gap:4px;align-items:flex-start;margin-top:6px">${dayBars}</div>
  </div>`;

  // ── Lead performance: which wallets make us money (the winning signal) ─────
  const lp = d.lead_performance ?? {};
  const leadRow = (l: any) => `<tr>
    <td style="font-family:monospace">${l.lead}</td>
    <td>${l.n}</td>
    <td>${sol(l.net_sol)}</td>
    <td>${pct(l.win_rate)}</td>
    <td>${sol(l.last10_net_sol)}</td>
    <td>${l.hot ? '<span style="color:#16a34a">●&nbsp;hot</span>' : '<span class="desc">cold</span>'}</td></tr>`;
  const leadCard = (lp.pending || !lp.top) ? '' : `<div class="card">
    <h2>Lead performance <span class="desc" style="font-size:13px">— ${lp.n_hot ?? 0} hot / ${lp.n_cold ?? 0} cold of ${lp.n_leads ?? 0} leads</span></h2>
    <div class="desc">Per-lead-wallet copy P&L on the baseline (${lp.baseline}) — the lead-selection signal made
    legible (it's the book's strongest). "hot" = passes the copy-hotlead gate (≥3 of last 10 copies net-positive).
    Last-10 net is what the gate keys on. Top 12 + worst 8 by total net.</div>
    <div class="grid" style="align-items:start">
      <div><div class="desc" style="margin-bottom:4px">Top leads</div>
        <table><tr><th>Lead</th><th>n</th><th>Net SOL</th><th>Win%</th><th>Last10</th><th>State</th></tr>${(lp.top ?? []).map(leadRow).join('')}</table></div>
      <div><div class="desc" style="margin-bottom:4px">Worst leads</div>
        <table><tr><th>Lead</th><th>n</th><th>Net SOL</th><th>Win%</th><th>Last10</th><th>State</th></tr>${(lp.bottom ?? []).map(leadRow).join('')}</table></div>
    </div>
  </div>`;

  const headerCard = `<div class="card">
    <h2>Copy Trades — shadow follower</h2>
    <div class="desc">SHADOW (no real funds). When a followed wallet buys a graduated token, each strategy
    opens a modeled position ~1.1s behind them and holds INDEFINITELY (the wallets hold ~hours), exiting per
    its rule. net SOL is after the round-trip cost. Size ${n(d.size_sol)} SOL/trade. Separate from /trading.
    <b>Totals below count ACTIVE strategies only.</b>${d.retired_summary ? ` Retired/killed strategies (excluded): ${d.retired_summary.n} closed, ${sol(d.retired_summary.net_sol)} SOL.` : ''}</div>
    <div class="grid">
      <div>
        <div class="stat"><span class="label">Closed copies</span><span class="value">${ov.n ?? 0}</span></div>
        <div class="stat"><span class="label">Total net SOL</span><span class="value">${sol(ov.total_net_sol)}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Net after drop top-3</span><span class="value">${sol(ov.total_net_sol_drop_top3)}</span></div>
        <div class="stat"><span class="label">Net under exit stress</span><span class="value">${sol(ov.total_net_sol_exit_stress)}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Win rate</span><span class="value">${pct(ov.win_rate)}</span></div>
        <div class="stat"><span class="label">Incl. open MTM</span><span class="value">${sol(ov.total_incl_open_sol)}</span></div>
      </div>
      <div>
        <div class="stat"><span class="label">Median hold</span><span class="value">${ov.median_hold_sec != null ? Math.round(ov.median_hold_sec) + 's' : '—'}</span></div>
        <div class="stat"><span class="label">Avg detection lag</span><span class="value">${n(ov.avg_detection_lag_sec)}s</span></div>
      </div>
    </div>
  </div>`;

  // ── Per-strategy table: robustness gates, drift, paired delta, 14d sparkline ──
  const paired = d.paired_vs_baseline ?? {};
  const gateBadge = (ok: boolean | null, label: string) =>
    ok == null ? `<span class="desc" style="font-size:10px">${label}:—</span>`
      : `<span style="font-size:10px;padding:1px 4px;border-radius:3px;color:#fff;background:${ok ? '#16a34a' : '#dc2626'}">${label}${ok ? '✓' : '✗'}</span>`;
  const sparkline = (days: any[]) => {
    const ds = (days ?? []).slice(-14);
    if (!ds.length) return '<span class="desc">—</span>';
    const mx = Math.max(0.05, ...ds.map((x) => Math.abs(x.net_sol ?? 0)));
    return `<div style="display:flex;gap:1px;align-items:center;height:24px">` + ds.map((x) => {
      const v = x.net_sol ?? 0;
      const h = Math.max(2, Math.round((Math.abs(v) / mx) * 10));
      return `<div title="${x.date}: ${v >= 0 ? '+' : ''}${n(v, 2)}" style="width:5px;height:${h}px;background:${v >= 0 ? '#16a34a' : '#dc2626'};${v >= 0 ? `margin-bottom:${h}px` : `margin-top:${h}px`};border-radius:1px"></div>`;
    }).join('') + `</div>`;
  };
  const stratRows = Object.entries(d.by_strategy ?? {}).map(([id, s]: [string, any]) => {
    const c = s.config ?? {};
    const gateBits = [
      c.entry_delay_sec != null ? `lag${c.entry_delay_sec}s` : '',
      c.max_entry_drift_pct != null ? `drift≤${c.max_entry_drift_pct}%` : '',
      c.min_lead_buy_sol != null ? `buy≥${c.min_lead_buy_sol}◎` : '',
      c.hot_lead_gate ? 'hot-lead' : '',
      c.elite_lead_gate ? 'elite-lead' : '',
      c.regime_gate_min_score != null ? `regime≥${c.regime_gate_min_score}` : '',
      c.macro_gate_min_score != null ? `macro≥${c.macro_gate_min_score}` : '',
      c.min_consensus != null ? `cons≥${c.min_consensus}` : '',
      c.entry_penalty_pct != null ? `pen${c.entry_penalty_pct}%` : '',
    ].filter(Boolean).join(' · ');
    // gate funnel: if this strategy passed on entries, show why (top 2 reasons).
    // Surfaces "low n because the gate is strict" vs "low n because no events".
    const gs = s.gate_skips ?? {};
    const skipEntries = Object.entries(gs).filter(([, v]: any) => v > 0).sort((a: any, b: any) => b[1] - a[1]);
    const totalSkips = skipEntries.reduce((acc: number, [, v]: any) => acc + v, 0);
    const interesting = skipEntries.filter(([k]) => k !== 'already_open' && k !== 'at_capacity');
    const funnel = (s.config && (s.config.hot_lead_gate || s.config.elite_lead_gate || s.config.regime_gate_min_score != null || s.config.macro_gate_min_score != null || s.config.min_consensus != null || s.config.min_lead_buy_sol != null) && interesting.length)
      ? `<div class="desc" style="font-size:10px">entered ${s.entered ?? 0} · skipped ${totalSkips} (${interesting.slice(0, 2).map(([k, v]: any) => `${k} ${v}`).join(', ')})</div>` : '';
    const exitRule = c.exit_follow && c.tp_pct == null ? 'lead sell only'
      : (c.tp_pct != null ? `TP${c.tp_pct}/SL${c.sl_pct}` + (c.exit_follow ? ' + follow' : '') : 'follow');
    const nClosed = s.n ?? 0;
    const badges = [
      gateBadge(nClosed > 0 ? nClosed >= 100 : null, 'n100'),
      gateBadge(nClosed > 0 ? (s.total_net_sol_drop_top3 ?? 0) > 0 : null, 'drop3'),
      gateBadge(nClosed > 0 ? (s.total_net_sol_exit_stress ?? 0) > 0 : null, 'stress'),
    ].join(' ');
    const allPass = nClosed >= 100 && (s.total_net_sol_drop_top3 ?? 0) > 0 && (s.total_net_sol_exit_stress ?? 0) > 0;
    const p = paired[id];
    const pairedCell = p ? `<span class="${p.delta_net_sol >= 0 ? 'green' : 'red'}">${p.delta_net_sol >= 0 ? '+' : ''}${n(p.delta_net_sol, 2)}</span> <span class="desc">(${p.n_common_events})</span>` : '—';
    const drift = s.entry_drift;
    const driftCell = drift ? `${drift.median_pct >= 0 ? '+' : ''}${n(drift.median_pct, 1)}%<span class="desc"> med</span>${(s.drift_skips ?? 0) > 0 ? ` <span class="desc">skip:${s.drift_skips}</span>` : ''}` : ((s.drift_skips ?? 0) > 0 ? `skip:${s.drift_skips}` : '—');
    return `<tr${allPass ? ' style="background:rgba(22,163,74,0.08)"' : ''}>
      <td>${id}<div class="desc" style="font-size:10px">${gateBits}</div>${funnel}</td><td class="desc">${exitRule}</td>
      <td>${nClosed}</td><td><span class="blue">${s.open_positions ?? 0}</span></td>
      <td>${sol(s.total_net_sol)}</td><td>${sol(s.total_net_sol_drop_top3)}</td><td>${sol(s.total_net_sol_exit_stress)}</td>
      <td>${pairedCell}</td><td>${pct(s.win_rate)}</td><td>${driftCell}</td>
      <td>${sparkline(s.daily)}</td>
      <td style="white-space:nowrap">${badges}</td></tr>`;
  }).join('');
  const stratCard = `<div class="card">
    <h2>By strategy</h2>
    <div class="desc">Paired Δ = net SOL vs ${d.paired_baseline} on the SAME lead-buy events (the honest exit-variant
    comparison — lifetime totals are not independent across strategies). Gates: n≥100 · drop-top3&gt;0 ·
    exit-stress&gt;0 — a green-tinted row clears all three. Drift = measured detection→fill move on lag variants
    (median); skip = drift-gate rejections.</div>
    <table><tr><th>Strategy</th><th>Exit rule</th><th>Closed</th><th>Open</th><th>Net SOL</th><th>Drop top-3</th><th>Stress</th><th>Paired Δ</th><th>Win%</th><th>Drift</th><th>14d</th><th>Gates</th></tr>${stratRows}</table>
  </div>`;

  // ── Time-to-exit: how long positions hold before TP vs SL ─────────────────
  const fmtDur = (s: any) => {
    if (typeof s !== 'number') return '—';
    if (s < 90) return Math.round(s) + 's';
    if (s < 5400) return (s / 60).toFixed(s < 600 ? 1 : 0) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  };
  const holdRows = Object.entries(d.by_strategy ?? {})
    .filter(([, s]: [string, any]) => s.hold_by_exit?.take_profit?.n || s.hold_by_exit?.stop_loss?.n)
    .map(([id, s]: [string, any]) => {
      const tp = s.hold_by_exit?.take_profit; const sl = s.hold_by_exit?.stop_loss;
      const cell = (h: any) => h ? `${fmtDur(h.median)} <span class="desc">(${fmtDur(h.min)}–${fmtDur(h.max)}, avg ${fmtDur(h.avg)})</span>` : '—';
      return `<tr><td>${id}</td>
        <td>${tp ? tp.n : 0}</td><td>${cell(tp)}</td>
        <td>${sl ? sl.n : 0}</td><td>${cell(sl)}</td></tr>`;
    }).join('');
  const holdCard = !holdRows ? '' : `<div class="card">
    <h2>Time to exit <span class="desc" style="font-size:13px">— how long a position holds before TP vs SL</span></h2>
    <div class="desc">Hold time broken out by exit reason (the overall median mixes them). <b>Time to TP</b> =
    how long until a winner pumps to the +100% target; shown as median (min–max, avg). TP holds are typically
    much longer than SL holds — losers cut fast, winners take time to run.</div>
    <table><tr><th>Strategy</th><th>TP n</th><th>Time to TP</th><th>SL n</th><th>Time to SL</th></tr>${holdRows}</table>
  </div>`;

  const recentRows = (d.recent_closed ?? []).map((r: any) => `<tr>
      <td>${r.strategy_id}</td><td style="font-family:monospace">${r.mint}</td>
      <td style="font-family:monospace">${r.lead}</td><td class="desc">${r.tier}</td>
      <td>${r.exit_reason}</td><td>${n(r.gross_pct)}%</td><td>${sol(r.net_sol)}</td>
      <td>${r.hold_sec != null ? Math.round(r.hold_sec) + 's' : '—'}</td></tr>`).join('');
  const recentCard = `<div class="card">
    <h2>Recent closed (30)</h2>
    <table><tr><th>Strategy</th><th>Mint</th><th>Lead</th><th>Tier</th><th>Exit</th><th>Gross%</th><th>Net SOL</th><th>Hold</th></tr>${recentRows}</table>
  </div>`;

  // ── Wallet discovery funnel: how the smart-wallet pool grows over time ──────
  const w = (a: any) => typeof a === 'string' && a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a ?? '—');
  const wd = d.wallet_discovery ?? {};
  const wds = wd.summary ?? {};
  const wdg = wd.gate ?? {};
  const scoredPct = (wds.total_candidates ?? 0) > 0 ? (100 * (wds.scored ?? 0) / wds.total_candidates).toFixed(1) : '0';
  // PumpSwap share = fraction of trades on the post-grad pool we can actually copy.
  // Low % = bonding-curve scalper (uncopyable). avg_hold formatted compactly.
  const swapPct = (v: any) => {
    const tot = v ? Object.values(v).reduce((a: number, b: any) => a + (b as number), 0) : 0;
    return tot > 0 ? Math.round(100 * ((v.pumpswap ?? 0) / tot)) : 0;
  };
  const fmtHold = (s: any) => s == null ? '—' : s < 90 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
  const promoRows = (wd.top_promotable ?? []).map((r: any) => {
    const sp = swapPct(r.venues);
    const spClass = sp >= 40 ? 'green' : sp < 20 ? 'red' : 'yellow';
    const r24 = r.rt_24h ?? 0;
    const recentClass = r24 > 0 ? 'green' : (r.rt_7d ?? 0) > 0 ? 'yellow' : 'red';
    return `<tr>
      <td style="font-family:monospace">${w(r.address)}</td><td>${r.n_round_trips}</td>
      <td>${sol(r.total_realized_sol)}</td><td>${sol(r.total_realized_sol_drop_top3)}</td>
      <td>${n(r.monthly_run_rate_sol, 0)}</td><td>${pct(r.win_rate)}</td>
      <td class="${spClass}">${sp}%</td><td>${fmtHold(r.avg_hold_sec)}</td>
      <td class="${recentClass}">${r24}/${r.rt_7d ?? 0}</td>
      <td>${r.last_active_days_ago != null ? r.last_active_days_ago + 'd' : '—'}</td></tr>`;
  }).join('');
  const discoveryCard = wd.summary == null ? '' : `<div class="card" style="border-left:6px solid #7c3aed">
    <h2>Wallet discovery <span class="desc" style="font-size:13px">— smart-money funnel (refresh to track over time)</span></h2>
    <div class="desc">Candidates seeded from graduation buyers → scored by lifetime P&amp;L → gated to promotable.
    Gate: ≥${wdg.min_round_trips ?? 100} round-trips · ≥${wdg.min_total_sol ?? 0.5} SOL · drop_top3&gt;${wdg.min_drop_top3_sol ?? 0} ·
    ≥${wdg.min_monthly_run_rate_sol ?? 3.75} SOL/mo · active ≤${wdg.max_days_since_active ?? 14}d.
    <b>Swap%</b> = share of trades on the post-grad PumpSwap pool we can actually copy (<span class="red">low % = uncopyable bonding-curve scalper</span>);
    <b>Hold</b> = avg hold; <b>24h/7d</b> = round-trips in the last 1/7 days (freshness — <span class="red">0/0 = gone quiet</span>; as of last scoring, see Active);
    <b>Active</b> = days since its last trade.</div>
    <div class="grid">
      <div class="stat"><span class="label">Candidates seeded</span><span class="value">${(wds.total_candidates ?? 0).toLocaleString()}</span></div>
      <div class="stat"><span class="label">Scored</span><span class="value">${(wds.scored ?? 0).toLocaleString()} <span class="desc">(${scoredPct}%)</span></span></div>
      <div class="stat"><span class="label">Promotable</span><span class="value green">${wds.promotable ?? 0}</span></div>
      <div class="stat"><span class="label">Watch</span><span class="value yellow">${wds.watch ?? 0}</span></div>
    </div>
    ${promoRows ? `<h3>Top promotable wallets</h3>
    <table><tr><th>Wallet</th><th>RTs</th><th>Net SOL</th><th>Drop3</th><th>SOL/mo</th><th>WR</th><th>Swap%</th><th>Hold</th><th>24h/7d</th><th>Active</th></tr>${promoRows}</table>` : ''}
  </div>`;

  // ── Per-strategy lead attribution: which wallets drive TP vs SL per strategy ─
  const attribRows = (d.lead_attribution ?? []).map((s: any) => {
    const leads = (s.top_leads ?? []).map((l: any) => `<tr>
        <td style="font-family:monospace">${w(l.wallet)}</td><td>${l.n}</td>
        <td>${sol(l.net)}</td><td class="green">${l.n_tp}</td><td class="red">${l.n_sl}</td>
        <td>${l.n > 0 ? pct(l.n_win / l.n) : '—'}</td></tr>`).join('');
    const worst = (s.worst_leads ?? []).map((l: any) => `<tr>
        <td style="font-family:monospace">${w(l.wallet)}</td><td>${l.n}</td>
        <td>${sol(l.net)}</td><td class="green">${l.n_tp}</td><td class="red">${l.n_sl}</td>
        <td>${l.n > 0 ? pct(l.n_win / l.n) : '—'}</td></tr>`).join('');
    const concentrated = (s.top_wallet_share_pct ?? 0) >= 50;
    return `<details class="card" style="border-left:6px solid ${concentrated ? '#16a34a' : '#334155'};padding:0">
      <summary style="cursor:pointer;padding:12px 16px;font-size:13px">
        <b>${s.strategy_id}</b> <span class="desc">· ${s.n_leads} leads · ${s.n_trades} trades · net ${sol(s.total_net)}</span>
        <span style="float:right" class="${concentrated ? 'green' : 'desc'}">top wallet ${s.top_wallet_share_pct}% · top3 ${s.top3_share_pct}% of profit</span>
      </summary>
      <div style="padding:0 16px 14px">
        <h3>Top leads (winners)</h3>
        <table><tr><th>Wallet</th><th>n</th><th>Net SOL</th><th>TP</th><th>SL</th><th>WR</th></tr>${leads}</table>
        ${worst ? `<h3>Worst leads (SL drivers)</h3>
        <table><tr><th>Wallet</th><th>n</th><th>Net SOL</th><th>TP</th><th>SL</th><th>WR</th></tr>${worst}</table>` : ''}
      </div>
    </details>`;
  }).join('');
  const attribCard = (d.lead_attribution ?? []).length === 0 ? '' : `<div class="card" style="border-left:6px solid #16a34a">
    <h2>Per-strategy lead attribution <span class="desc" style="font-size:13px">— who drives TP vs SL</span></h2>
    <div class="desc">For each strategy (≥20 closed trades), lead wallets ranked by net SOL contributed. A high
    "top wallet %" means the edge is a few wallets — candidates for a <code>walletAllowlist</code> to copy ONLY
    the proven leads and shed the SL tail. Green = top wallet drives ≥50% of gross profit.</div>
    ${attribRows}
  </div>`;

  return shell('Copy Trades — Graduation Arb Research', '/copy-trades', leCard + regimeCard + macroCard + discoveryCard + attribCard + promoCard + lvsCard + dailyCard + leadCard + headerCard + stratCard + holdCard + recentCard, data as object);
}
