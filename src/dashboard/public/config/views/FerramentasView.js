import { toolsStore } from '../state.js';
import { getTools, toggleTool } from '../api.js';

const TOOL_CAT = {
  web_search:'web', web_navigate:'web', web_scrape:'web',
  exec_command:'sistema', ssh_exec:'sistema', write:'sistema', read:'sistema', edit:'sistema', list_dir:'sistema',
  memory_search:'memoria', memory_write:'memoria', memory_admin:'memoria',
  send_audio:'comunicacao', send_document:'comunicacao', send_image:'comunicacao',
  crypto_report:'dados', crypto_analysis:'dados', weather:'dados', schedule:'dados', get_news:'dados',
};
const CAT_LABEL = { web:'WEB', sistema:'SYS', memoria:'MEM', comunicacao:'COM', dados:'DATA', outros:'ETC' };
const TOOL_ICONS = {
  exec_command:'💻', web_search:'🔍', web_navigate:'🌐', file_ops:'📁', crypto_report:'📊',
  crypto_analysis:'📉', send_audio:'🔊', send_document:'📄', memory_search:'🔎',
  memory_write:'✍️', memory_admin:'⚙️', ssh_exec:'🖥️', write:'📝', read:'📖', edit:'✏️',
  list_dir:'📂', weather:'🌤️', schedule:'📅', send_image:'🖼️', get_news:'📰',
};

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🛠️ ${t('sidebar_tools')}</h1>
        <p>${t('tools_page_desc')}</p>
      </div>
      <input type="text" class="tool-search" id="ft-search" placeholder="${t('search_tools_placeholder')}">
      <div class="module-grid" id="ft-grid"><div class="empty">${t('loading_modules')}</div></div>
    </div>`;

  let allTools = [];

  function renderGrid(tools) {
    const stats  = toolsStore.get('stats') || {};
    const maxC   = Math.max(1, ...tools.map(tool => stats[tool.name]?.calls || 0));
    const grid   = document.getElementById('ft-grid');
    if (!grid) return;
    if (!tools.length) { grid.innerHTML = `<div class="empty">${t('no_tools_available')}</div>`; return; }
    grid.innerHTML = tools.map(tool => {
      const icon    = TOOL_ICONS[tool.name] || '🔧';
      const catLbl  = CAT_LABEL[TOOL_CAT[tool.name] || 'outros'] || 'ETC';
      const st      = stats[tool.name];
      const calls   = st?.calls || 0;
      const pct     = Math.round(calls / maxC * 100);
      const rate    = st?.successRate ?? -1;
      const barCls  = rate >= 80 ? 'ok' : rate >= 50 ? 'warn' : 'neutral';
      const modCls  = tool.dangerous ? 'is-dangerous' : tool.enabled ? 'is-enabled' : 'is-disabled';
      const statsTxt = calls > 0 ? `${calls} chamadas · ${rate}% ✓ · ${st.avgLat}ms` : t('no_usage_data');
      const warnBadge = tool.dangerous ? ' <span class="badge badge-proposed" style="font-size:.55rem">⚠️</span>' : '';
      return `
        <div class="tool-module ${modCls}" data-name="${tool.name}">
          <div class="tm-header">
            <div class="tm-icon">${icon}</div>
            <div class="tm-name">${tool.name}${warnBadge}</div>
            <button class="tm-toggle ${tool.enabled ? 'on' : 'off'}" data-tname="${tool.name}" data-enabled="${tool.enabled}">
              ${tool.enabled ? 'OFF' : 'ON'}
            </button>
          </div>
          <div class="tm-desc">${tool.description || ''}</div>
          <div>
            <div class="tm-stats">
              <span class="tm-cat-badge">${catLbl}</span>
              <span class="tm-stats-text">${statsTxt}</span>
            </div>
            <div class="tm-bar" style="margin-top:5px;">
              <div class="tm-bar-fill ${barCls}" style="width:${pct}%"></div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // Initial render from store
  allTools = toolsStore.get('tools') || [];
  renderGrid(allTools);

  // Delegate toggle clicks on the persistent grid container
  const grid = document.getElementById('ft-grid');
  grid.addEventListener('click', async e => {
    const btn = e.target.closest('.tm-toggle');
    if (!btn) return;
    const name    = btn.dataset.tname;
    const enabled = btn.dataset.enabled === 'true';
    btn.disabled  = true;
    try {
      await toggleTool(name, !enabled);
      const tools = await getTools();
      toolsStore.set('tools', tools);
    } catch {
      btn.disabled = false;
    }
  });

  // Search
  document.getElementById('ft-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    renderGrid(q ? allTools.filter(tool => tool.name.toLowerCase().includes(q) || (tool.description||'').toLowerCase().includes(q)) : allTools);
  });

  // Subscribe to store updates
  const unsubTools = toolsStore.on('tools', tools => { allTools = tools; renderGrid(allTools); });
  const unsubStats = toolsStore.on('stats', () => renderGrid(allTools));

  return () => { unsubTools(); unsubStats(); };
}
