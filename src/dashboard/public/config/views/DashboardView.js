import { runtimeStore, skillsStore, toolsStore } from '../state.js';

const TOOL_ICONS = {
  exec_command:'💻', web_search:'🔍', web_navigate:'🌐', crypto_report:'📊',
  crypto_analysis:'📉', send_audio:'🔊', send_document:'📄', memory_search:'🔎',
  memory_write:'✍️', memory_admin:'⚙️', ssh_exec:'🖥️', write:'📝', read:'📖',
  edit:'✏️', list_dir:'📂', weather:'🌤️', schedule:'📅', file_ops:'📁',
};

export function render(container) {
  container.innerHTML = `
    <div class="v-dashboard">
      <div class="agent-hero">
        <div class="agent-avatar">
          <div class="avatar-ring" id="avatarRing"></div>
          <div class="avatar-core">🧠</div>
        </div>
        <div class="agent-hero-info">
          <div class="agent-hero-name">NewClaw Agent</div>
          <div class="agent-hero-sub">
            <span class="dot" id="heroDot"></span>
            <span id="heroStatusText">Verificando...</span>
            <span style="color:var(--border-color)">·</span>
            <span id="heroUptime" style="color:var(--text-soft)">—</span>
          </div>
        </div>
        <div class="hero-model-chip">
          <div>
            <div class="chip-label">modelo ativo</div>
            <div class="chip-value" id="heroModel">—</div>
          </div>
          <span class="badge" id="heroModelBadge" style="background:rgba(125,211,252,.15);color:var(--accent)">—</span>
        </div>
      </div>

      <div class="metrics-strip">
        <div class="metric-card"><div class="metric-val accent" id="mRam">—</div><div class="metric-lbl">RAM Heap</div></div>
        <div class="metric-card"><div class="metric-val green" id="mActiveSkills">—</div><div class="metric-lbl">Skills ativas</div></div>
        <div class="metric-card"><div class="metric-val warn" id="mProposedSkills">—</div><div class="metric-lbl">Propostas</div></div>
        <div class="metric-card"><div class="metric-val" id="mPatterns">—</div><div class="metric-lbl">Padrões</div></div>
        <div class="metric-card"><div class="metric-val accent" id="mTopTool">—</div><div class="metric-lbl">Tool líder</div></div>
      </div>

      <div class="activity-panel">
        <div class="activity-panel-title"><div class="live-dot"></div>Atividade — Top Ferramentas por Uso</div>
        <div id="dashToolBars"><div class="empty">Aguardando dados...</div></div>
      </div>

      <div class="activity-panel">
        <div class="activity-panel-title"><div class="live-dot"></div>Padrões Cognitivos Recentes</div>
        <div id="dashPatterns"><div class="empty">Aguardando dados...</div></div>
      </div>

      <div class="activity-panel" id="channelsPanel">
        <div class="activity-panel-title"><div class="live-dot"></div>Canais</div>
        <div id="channelsList"><div class="empty">Aguardando dados...</div></div>
      </div>

      <details class="cfg-details">
        <summary>⚙️ Configurações de Comportamento</summary>
        <div class="cfg-details-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Idioma</label>
              <select class="form-select" id="f-language">
                <option value="pt-BR">🇧🇷 Português</option>
                <option value="en-US">🇺🇸 English</option>
                <option value="es">🇪🇸 Español</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Iterações Máximas</label>
              <input type="number" class="form-input" id="f-maxIterations" min="1" max="20">
              <div class="form-hint">Loops por ciclo de raciocínio (1–20)</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Janela de Memória</label>
            <input type="number" class="form-input" id="f-memoryWindowSize" min="5" max="100" style="max-width:180px;">
            <div class="form-hint">Mensagens mantidas no contexto ativo</div>
          </div>
        </div>
      </details>
    </div>`;

  // Bind form fields from configStore
  const cs = window.__configStore;
  if (cs) {
    const s = cs.snap();
    const el = id => document.getElementById(id);
    el('f-language').value       = s.language       || 'pt-BR';
    el('f-maxIterations').value  = s.maxIterations  || 5;
    el('f-memoryWindowSize').value = s.memoryWindowSize || 20;

    el('f-language').addEventListener('change',       e => cs.set('language', e.target.value));
    el('f-maxIterations').addEventListener('input',   e => cs.set('maxIterations', +e.target.value));
    el('f-memoryWindowSize').addEventListener('input',e => cs.set('memoryWindowSize', +e.target.value));
  }

  // Subscribe to stores
  const unsubs = [
    runtimeStore.on('*', updateRuntime),
    runtimeStore.on('*', s => updateChannels(s.telegramChannel)),
    toolsStore.on('stats', () => updateActivity()),
    toolsStore.on('tools', () => updateActivity()),
    skillsStore.on('*', updateSkillMetrics),
  ];

  updateRuntime(runtimeStore.snap());
  updateSkillMetrics(skillsStore.snap());
  updateActivity();
  updateChannels(runtimeStore.get('telegramChannel'));

  return () => unsubs.forEach(fn => fn());
}

function updateRuntime(s) {
  const el = id => document.getElementById(id);
  const online = s.status === 'online';
  const dot = el('heroDot');
  if (dot) dot.className = `dot ${online ? 'online' : 'offline'}`;
  const txt = el('heroStatusText');
  if (txt) txt.textContent = online ? 'Online' : 'Offline';
  const uptime = el('heroUptime');
  if (uptime) uptime.textContent = s.uptime || '—';
  const ram = el('mRam');
  if (ram) ram.textContent = s.ram || '—';
  const ring = document.getElementById('avatarRing');
  if (ring) ring.style.borderColor = online ? 'var(--success)' : 'var(--danger)';

  // Hero model from configStore
  const cs = window.__configStore;
  if (cs) {
    const model = cs.get('currentModel') || cs.get('ollamaModel') || '—';
    const heroModel = el('heroModel');
    const heroBadge = el('heroModelBadge');
    if (heroModel) heroModel.textContent = model;
    if (heroBadge) heroBadge.textContent = model.includes(':cloud') ? 'cloud' : 'local';
  }
}

function updateSkillMetrics(s) {
  const el = id => document.getElementById(id);
  if (el('mActiveSkills'))   el('mActiveSkills').textContent   = s.activeCount   ?? '—';
  if (el('mProposedSkills')) el('mProposedSkills').textContent = s.proposedCount  ?? '—';
  if (el('mPatterns'))       el('mPatterns').textContent       = (s.patterns || []).length;

  // Patterns feed
  const patterns = s.patterns || [];
  const pEl = el('dashPatterns');
  if (!pEl) return;
  if (!patterns.length) { pEl.innerHTML = '<div class="empty">Padrões surgem com o uso. Nenhum ainda.</div>'; return; }
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

function updateChannels(tg) {
  const el = document.getElementById('channelsList');
  if (!el) return;

  if (!tg) {
    el.innerHTML = '<div class="empty">Dados de canal indisponíveis.</div>';
    return;
  }

  const STATE_ICON = {
    connected:    '🟢',
    cooldown:     '🟡',
    reconnecting: '🟡',
    conflict:     '🔴',
    disconnected: '⚫',
  };
  const STATE_LABEL = {
    connected:    'Conectado',
    cooldown:     'Cooldown após conflito',
    reconnecting: 'Reconectando...',
    conflict:     'Conflito de polling',
    disconnected: 'Desconectado',
  };

  const icon  = STATE_ICON[tg.state]  || '⚫';
  const label = STATE_LABEL[tg.state] || tg.state;
  const uptimeTxt  = tg.connectedUptimeMs  ? `uptime ${Math.round(tg.connectedUptimeMs / 1000)}s`  : '';
  const cooldownTxt= tg.cooldownRemainingMs? `reconecta em ${Math.round(tg.cooldownRemainingMs / 1000)}s` : '';
  const conflictTxt= tg.conflictCount      ? `conflitos: ${tg.conflictCount}`                         : '';
  const details = [uptimeTxt, cooldownTxt, conflictTxt, `pid=${tg.instanceId}@${tg.hostname}`].filter(Boolean).join(' · ');
  const clusterWarn = tg.isClusterMode
    ? `<div style="color:var(--warn);font-size:.75rem;margin-top:4px">⚠️ PM2 cluster mode detectado — apenas instância 0 faz polling</div>`
    : '';

  el.innerHTML = `
    <div class="channel-row">
      <span class="channel-icon">${icon}</span>
      <span class="channel-name">Telegram</span>
      <span class="channel-status">${label}</span>
      <span class="channel-detail">${details}</span>
    </div>
    ${clusterWarn}`;
}

function updateActivity() {
  const stats = toolsStore.get('stats') || {};
  const tools = toolsStore.get('tools') || [];
  const el = id => document.getElementById(id);

  const entries = Object.entries(stats).sort((a, b) => b[1].calls - a[1].calls).slice(0, 7);
  const maxC = entries[0]?.[1].calls || 1;

  const barsEl = el('dashToolBars');
  if (!barsEl) return;

  if (!entries.length) {
    barsEl.innerHTML = '<div class="empty">Barras aparecem conforme o agente usa ferramentas.</div>';
    el('mTopTool') && (el('mTopTool').textContent = '—');
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

  if (el('mTopTool')) el('mTopTool').textContent = entries[0][0];

  // Animate bars
  requestAnimationFrame(() => {
    document.querySelectorAll('#dashToolBars .usage-bar-fill').forEach(b => { b.style.width = b.dataset.pct + '%'; });
  });
}
