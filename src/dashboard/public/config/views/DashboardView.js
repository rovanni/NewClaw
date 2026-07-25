import { runtimeStore, skillsStore, toolsStore, providersStore } from '../state.js';

// Diretriz 2026-07-25: o Dashboard principal responde só "o sistema está funcionando?" — cada
// painel aqui precisa responder a pelo menos uma dessas perguntas (sistema online, provider
// conectado, modelo ativo, serviço indisponível, canal desconectado, preciso agir?). Telemetria
// do motor cognitivo (Top Ferramentas por Uso, Padrões Cognitivos) foi movida pra DesenvolvedorView
// — não responde nenhuma dessas perguntas, é análise de comportamento interno.

export function render(container) {
  container.innerHTML = `
    <div class="v-dashboard">
      <div class="page-header">
        <h1>📡 Dashboard</h1>
        <p>${t('dash_page_desc')}</p>
      </div>

      <div class="agent-hero">
        <div class="agent-avatar">
          <div class="avatar-ring" id="avatarRing"></div>
          <div class="avatar-core">🧠</div>
        </div>
        <div class="agent-hero-info">
          <div class="agent-hero-name">NewClaw Agent</div>
          <div class="agent-hero-sub">
            <span class="dot" id="heroDot"></span>
            <span id="heroStatusText">${t('status_verifying')}</span>
            <span style="color:var(--border-color)">·</span>
            <span id="heroUptime" style="color:var(--text-soft)">—</span>
          </div>
        </div>
        <div class="hero-model-chip">
          <div>
            <div class="chip-label">${t('active_model_label')}</div>
            <div class="chip-value" id="heroModel">—</div>
          </div>
          <span class="badge" id="heroModelBadge" style="background:rgba(125,211,252,.15);color:var(--accent)">—</span>
        </div>
      </div>

      <!-- Alertas primeiro — problemas antes de estatísticas (diretriz UX 2026-07-25). -->
      <div class="activity-panel" id="dashAlertsPanel">
        <div class="activity-panel-title">🚨 ${t('dash_alerts_title')}</div>
        <div id="dashAlerts"><div class="empty">${t('waiting_data')}</div></div>
      </div>

      <!-- Estado Geral — checklist de prontidão, mesma linguagem visual do overview-card de Modelos. -->
      <div class="overview-card" style="max-width:none;margin-bottom:16px;">
        <div class="overview-row"><span class="overview-label">${t('dash_state_system')}</span><span class="overview-value"><span class="dot" id="dashSysDot"></span> <span id="dashSysText">—</span></span></div>
        <div class="overview-row"><span class="overview-label">${t('dash_state_provider')}</span><span class="overview-value" id="dashProvText">—</span></div>
        <div class="overview-row"><span class="overview-label">${t('dash_state_model')}</span><span class="overview-value" id="dashModelText">—</span></div>
        <div class="overview-row"><span class="overview-label">${t('dash_state_ready')}</span><span class="overview-value" id="dashReadyText">—</span></div>
      </div>

      <div class="activity-panel">
        <div class="activity-panel-title">🧩 ${t('dash_services_title')}</div>
        <div id="dashServices"><div class="empty">${t('waiting_data')}</div></div>
      </div>

      <div class="activity-panel" id="channelsPanel">
        <div class="activity-panel-title"><div class="live-dot"></div>${t('channels_section_title')}</div>
        <div id="channelsList"><div class="empty">${t('waiting_data')}</div></div>
      </div>

      <div class="metrics-strip">
        <div class="metric-card"><div class="metric-val accent" id="mRam">—</div><div class="metric-lbl">RAM Heap</div></div>
        <div class="metric-card"><div class="metric-val green" id="mActiveSkills">—</div><div class="metric-lbl">${t('metric_active_skills')}</div></div>
        <div class="metric-card"><div class="metric-val warn" id="mProposedSkills">—</div><div class="metric-lbl">${t('metric_proposed')}</div></div>
        <div class="metric-card"><div class="metric-val" id="mPatterns">—</div><div class="metric-lbl">${t('metric_patterns')}</div></div>
        <div class="metric-card"><div class="metric-val accent" id="mTopTool">—</div><div class="metric-lbl">${t('metric_top_tool')}</div></div>
      </div>

      <details class="cfg-details">
        <summary>⚙️ ${t('behavior_settings')}</summary>
        <div class="cfg-details-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">${t('lang_label')}</label>
              <select class="form-select" id="f-language">
                <option value="pt-BR">🇧🇷 Português</option>
                <option value="en-US">🇺🇸 English</option>
                <option value="es">🇪🇸 Español</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">${t('iterations_label')}</label>
              <input type="number" class="form-input" id="f-maxIterations" min="1" max="20">
              <div class="form-hint">${t('iterations_hint')}</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">${t('memory_window_label')}</label>
            <input type="number" class="form-input" id="f-memoryWindowSize" min="5" max="100" style="max-width:180px;">
            <div class="form-hint">${t('memory_window_hint')}</div>
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
    runtimeStore.on('*', updateHealthPanels),
    toolsStore.on('stats', updateTopToolMetric),
    skillsStore.on('*', updateSkillMetrics),
    providersStore.on('*', updateHealthPanels),
    cs ? cs.on('*', updateHealthPanels) : () => {},
  ];

  updateRuntime(runtimeStore.snap());
  updateSkillMetrics(skillsStore.snap());
  updateTopToolMetric();
  updateChannels(runtimeStore.get('telegramChannel'));
  updateHealthPanels();

  return () => unsubs.forEach(fn => fn());
}

function updateRuntime(s) {
  const el = id => document.getElementById(id);
  const online = s.status === 'online';
  const dot = el('heroDot');
  if (dot) dot.className = `dot ${online ? 'online' : 'offline'}`;
  const txt = el('heroStatusText');
  if (txt) txt.textContent = online ? t('online') : t('offline');
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
}

function updateTopToolMetric() {
  const stats = toolsStore.get('stats') || {};
  const el = id => document.getElementById(id);
  const entries = Object.entries(stats).sort((a, b) => b[1].calls - a[1].calls);
  if (el('mTopTool')) el('mTopTool').textContent = entries[0]?.[0] || '—';
}

function updateChannels(tg) {
  const el = document.getElementById('channelsList');
  if (!el) return;

  if (!tg) {
    el.innerHTML = `<div class="empty">${t('no_channel_data')}</div>`;
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
    connected:    t('tg_connected'),
    cooldown:     t('tg_cooldown'),
    reconnecting: t('tg_reconnecting'),
    conflict:     t('tg_conflict'),
    disconnected: t('tg_disconnected'),
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

// ─── Estado Geral / Serviços / Alertas ──────────────────────────────────────
// Só usa dado real já buscado por app.js (runtimeStore/providersStore/configStore) — nenhum dos
// três painéis inventa uma checagem nova. Serviços sem health check de verdade no backend (Redis,
// MCP, scheduler como serviço externo) não aparecem aqui — ver auditoria 2026-07-25.

function updateHealthPanels() {
  const cs = window.__configStore;
  if (!cs) return;
  const s = cs.snap();
  const rt = runtimeStore.snap();
  const health = providersStore.get('health') || [];
  const ollamaOnline = providersStore.get('ollamaOnline');
  const model = s.currentModel || s.ollamaModel || '';
  const sysOnline = rt.status === 'online';

  const defaultProvider = s.defaultProvider || 'ollama';
  const providerHealth = health.find(h => h.provider === defaultProvider);
  const providerOnline = defaultProvider === 'ollama' ? ollamaOnline : !!providerHealth?.online;
  const providerHasKeyOnly = defaultProvider !== 'ollama' && !providerHealth; // cloud API-key provider, sem health check real

  // ── Estado Geral ──
  const el = id => document.getElementById(id);
  el('dashSysDot')  && (el('dashSysDot').className = `dot ${sysOnline ? 'online' : 'offline'}`);
  el('dashSysText') && (el('dashSysText').textContent = sysOnline ? t('online') : t('offline'));
  el('dashProvText') && (el('dashProvText').textContent =
    providerHasKeyOnly
      ? (s[`has${defaultProvider.charAt(0).toUpperCase() + defaultProvider.slice(1)}Key`] ? t('dash_key_configured') : t('dash_key_missing'))
      : (providerOnline ? t('ml_ov_online') : t('ml_ov_offline')));
  el('dashModelText') && (el('dashModelText').textContent = model || t('dash_ready_no'));
  const ready = sysOnline && (providerOnline || providerHasKeyOnly) && !!model;
  el('dashReadyText') && (el('dashReadyText').textContent = ready ? t('dash_ready_yes') : t('dash_ready_no'));

  // ── Serviços (só o que tem health check real) ──
  const svcEl = el('dashServices');
  if (svcEl) {
    const rows = [];
    rows.push(serviceRow('🦙', 'Ollama', ollamaOnline));
    for (const h of health) {
      if (h.provider === 'ollama') continue;
      rows.push(serviceRow('🔗', h.provider, h.online));
    }
    svcEl.innerHTML = rows.join('') || `<div class="empty">${t('waiting_data')}</div>`;
  }

  // ── Alertas (derivados do mesmo dado, nunca uma checagem nova) ──
  const alerts = [];
  if (!sysOnline) alerts.push(t('dash_alert_system_offline'));
  if (!providerOnline && !providerHasKeyOnly) alerts.push(t('dash_alert_provider_down', { provider: defaultProvider }));
  if (providerHasKeyOnly && !s[`has${defaultProvider.charAt(0).toUpperCase() + defaultProvider.slice(1)}Key`]) alerts.push(t('dash_alert_key_missing', { provider: defaultProvider }));
  if (!model) alerts.push(t('dash_alert_no_model'));
  const tg = rt.telegramChannel;
  if (tg && tg.state !== 'connected') alerts.push(t('dash_alert_channel_down', { channel: 'Telegram' }));

  const alertsEl = el('dashAlerts');
  if (alertsEl) {
    alertsEl.innerHTML = alerts.length
      ? alerts.map(a => `<div class="alert-row"><span class="alert-icon">⚠️</span><span>${a}</span></div>`).join('')
      : `<div class="alert-row alert-row-ok"><span class="alert-icon">✅</span><span>${t('dash_alerts_none')}</span></div>`;
  }
}

function serviceRow(icon, name, online) {
  const dot = online ? '🟢' : '🔴';
  const status = online ? t('ml_ov_online') : t('ml_ov_offline');
  return `<div class="channel-row">
    <span class="channel-icon">${icon}</span>
    <span class="channel-name">${name}</span>
    <span class="channel-status">${dot} ${status}</span>
  </div>`;
}
