import { skillsStore, toolsStore } from '../state.js';
import { guideBox } from '../app.js';

const TOOL_ICONS = {
  exec_command:'💻', web_search:'🔍', web_navigate:'🌐', crypto_report:'📊',
  crypto_analysis:'📉', send_audio:'🔊', send_document:'📄', memory_search:'🔎',
  memory_write:'✍️', memory_admin:'⚙️', ssh_exec:'🖥️', write:'📝', read:'📖',
  edit:'✏️', list_dir:'📂', weather:'🌤️', schedule:'📅', file_ops:'📁',
};

// Diretriz 2026-07-25: área exclusiva de telemetria/diagnóstico do motor cognitivo, separada do
// Dashboard operacional. Cada painel novo de diagnóstico (GoalPlanner, Model Router, Traces,
// Performance, logs etc.) entra aqui como mais um <details> — sem precisar reorganizar o resto.
export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔬 ${t('dev_page_title')}</h1>
        <p>${t('dev_page_desc')}</p>
      </div>

      ${guideBox(t('dev_page_guide'))}

      <div class="activity-panel">
        <div class="activity-panel-title"><div class="live-dot"></div>${t('activity_tools_title')}</div>
        <div id="dashToolBars"><div class="empty">${t('waiting_data')}</div></div>
      </div>

      <div class="activity-panel">
        <div class="activity-panel-title"><div class="live-dot"></div>${t('cognitive_patterns_title')}</div>
        <div id="dashPatterns"><div class="empty">${t('waiting_data')}</div></div>
      </div>

      <button class="btn btn-ghost btn-sm" id="devDisableBtn" style="margin-top:8px;">${t('dev_disable_btn')}</button>
    </div>`;

  document.getElementById('devDisableBtn')?.addEventListener('click', () => {
    window.newclawSetDevMode(false);
  });

  const unsubs = [
    toolsStore.on('stats', () => renderToolBars()),
    toolsStore.on('tools', () => renderToolBars()),
    skillsStore.on('*', renderPatterns),
  ];

  renderToolBars();
  renderPatterns(skillsStore.snap());

  return () => unsubs.forEach(fn => fn());
}

function renderToolBars() {
  const stats = toolsStore.get('stats') || {};
  const barsEl = document.getElementById('dashToolBars');
  if (!barsEl) return;

  const entries = Object.entries(stats).sort((a, b) => b[1].calls - a[1].calls).slice(0, 7);
  const maxC = entries[0]?.[1].calls || 1;

  if (!entries.length) {
    barsEl.innerHTML = `<div class="empty">${t('waiting_data')}</div>`;
    return;
  }

  barsEl.innerHTML = entries.map(([name, s]) => {
    const pct  = Math.round(s.calls / maxC * 100);
    const icon = TOOL_ICONS[name] || '🔧';
    const cls  = s.successRate >= 80 ? 'ok' : s.successRate >= 50 ? 'warn' : 'neutral';
    return `<div class="usage-bar-row">
      <div class="usage-bar-icon">${icon}</div>
      <div class="usage-bar-name">${name}</div>
      <div class="usage-bar-track"><div class="usage-bar-fill ${cls}" style="width:0%" data-pct="${pct}"></div></div>
      <div class="usage-bar-stat">${s.calls} · ${s.successRate}% ✓ · ${s.avgLat}ms</div>
    </div>`;
  }).join('');

  requestAnimationFrame(() => {
    document.querySelectorAll('#dashToolBars .usage-bar-fill').forEach(b => { b.style.width = b.dataset.pct + '%'; });
  });
}

function renderPatterns(s) {
  const patterns = s.patterns || [];
  const pEl = document.getElementById('dashPatterns');
  if (!pEl) return;
  if (!patterns.length) { pEl.innerHTML = `<div class="empty">${t('no_patterns_yet')}</div>`; return; }
  const recent = [...patterns].sort((a, b) => ((b.success_count||0)+(b.fail_count||0)) - ((a.success_count||0)+(a.fail_count||0))).slice(0, 8);
  pEl.innerHTML = recent.map(p => {
    const total = (p.success_count||0)+(p.fail_count||0);
    const name = p.pattern.length > 42 ? p.pattern.slice(0, 40) + '…' : p.pattern;
    return `<div class="pattern-row">
      <span class="pr-name" title="${p.pattern}">${name}</span>
      <span class="pr-tool">${p.tool_name}</span>
      <span class="pr-stat">${total} · ${p.avg_latency_ms}ms</span>
    </div>`;
  }).join('');
}
