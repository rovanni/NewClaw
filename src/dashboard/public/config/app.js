import {
  configStore, runtimeStore, providersStore, toolsStore, skillsStore,
} from './state.js';
import {
  getConfig, getStatus, getProviders, getTools,
  getSkills, getPatterns, aggregateToolStats, saveConfig as apiSaveConfig,
  modelExists, pullModel as apiPullModel, addModel,
} from './api.js';
import { showToast } from './components/Toast.js';
import { installGlobalHelpers, updateDropdownModels } from './components/ModelDropdown.js';

// ── Expose configStore for views that need window.__configStore ──
window.__configStore = configStore;

// ── Router ──────────────────────────────────────────────────────
const VIEW_MAP = {
  dashboard:   'DashboardView',
  modelos:     'ModelosView',
  providers:   'ProvidersView',
  ferramentas: 'FerramentasView',
  skills:      'SkillsView',
  integracoes: 'IntegracoesView',
  seguranca:   'SegurancaView',
  avancado:    'AvancadoView',
  atualizacao: 'AtualizacaoView',
  backup:      'BackupView',
};

let currentCleanup = null;
let currentPage = 'dashboard';

async function navigate(page) {
  currentPage = page;
  document.querySelectorAll('#sidebar-nav .nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });

  if (currentCleanup) { try { currentCleanup(); } catch {} currentCleanup = null; }

  const container = document.getElementById('page-view');
  container.innerHTML = '';

  try {
    const mod = await import('./views/' + VIEW_MAP[page] + '.js');
    currentCleanup = mod.render(container) || null;
  } catch (e) {
    container.innerHTML = `<div class="page-view"><div class="empty">Erro ao carregar view: ${e.message}</div></div>`;
  }
}

window.addEventListener('newclaw-lang-changed', () => {
  window.newclawApplyI18n?.();
  navigate(currentPage);
});

// ── Sidebar nav ──────────────────────────────────────────────────
document.querySelectorAll('#sidebar-nav .nav-item').forEach(item => {
  item.addEventListener('click', () => navigate(item.dataset.page));
});

// ── Save & Restart ───────────────────────────────────────────────
document.getElementById('btnSave').addEventListener('click', doSave);
document.getElementById('btnRestart').addEventListener('click', doRestart);

async function doSave() {
  const c = configStore.snap();

  const config = {
    defaultProvider:        c.defaultProvider,
    language:               c.language,
    maxIterations:          Number(c.maxIterations),
    memoryWindowSize:       Number(c.memoryWindowSize),
    systemPrompt:           c.systemPrompt || '',
    ollamaUrl:              c.ollamaUrl    || 'http://localhost:11434',
    ollamaModel:            c.ollamaModel  || 'glm-5.2:cloud',
    telegramAllowedUserIds: c.telegramAllowedUserIds || '',
    modelRouter:            c.modelRouter  || {},
  };

  // Include API keys only if user typed something
  if (c.ollamaApiKey)    config.ollamaApiKey    = c.ollamaApiKey;
  if (c.geminiKey)       config.geminiKey       = c.geminiKey;
  if (c.deepseekKey)     config.deepseekKey     = c.deepseekKey;
  if (c.groqKey)         config.groqKey         = c.groqKey;
  if (c.openrouterKey)   config.openrouterKey   = c.openrouterKey;

  // Auto-pull/register missing models
  const toCheck = new Set();
  if (config.ollamaModel && config.defaultProvider === 'ollama') toCheck.add(config.ollamaModel);
  ['chat','code','vision','light','analysis','execution'].forEach(k => {
    const m = config.modelRouter[k];
    if (m?.trim()) toCheck.add(m.trim());
  });

  for (const model of toCheck) {
    if (model.includes('groq') || model.includes('gemini') || model.includes('deepseek')) continue;
    try {
      const exists = await modelExists(model);
      if (!exists) {
        showToast((model.includes(':cloud') ? '✨ Registrando "' : '⬇️ Baixando "') + model + '"…', 'success');
        apiPullModel(model)
          .then(() => { showToast('✅ "' + model + '" pronto!', 'success'); loadProviders(); })
          .catch(() => {});
      }
    } catch {}
  }

  try {
    await apiSaveConfig(config);
    showToast('✅ Configuração salva!', 'success');
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  }
}

async function doRestart() {
  await doSave();
  if (!confirm('Reiniciar o NewClaw agora?')) return;
  const f = window.newclawFetch || fetch;
  try {
    await f('/api/restart', { method: 'POST' });
    showToast('🔄 Reiniciando...', 'success');
    let tries = 0;
    const check = async () => {
      try { const r = await f('/api/status'); if (r.ok) { location.reload(); return; } } catch {}
      if (++tries < 30) setTimeout(check, 2000); else location.reload();
    };
    setTimeout(check, 5000);
  } catch {
    setTimeout(() => location.reload(), 8000);
  }
}

// ── Model dropdown global helpers ────────────────────────────────
const ROUTER_KEYS = {
  modelChat:'chat', modelCode:'code', modelVision:'vision',
  modelLight:'light', modelAnalysis:'analysis', modelExecution:'execution',
  classifierModel:'classifierModel',
};

installGlobalHelpers(
  model => {
    apiPullModel(model)
      .then(() => { showToast('✅ "' + model + '" pronto!', 'success'); loadProviders(); })
      .catch(e => showToast('❌ ' + e.message, 'error'));
  },
  async (id, model) => {
    try { await addModel(model); loadProviders(); } catch {}
    updateModelStore(id, model);
  },
  (id, model) => updateModelStore(id, model),
);

function updateModelStore(id, model) {
  if (id === 'ollamaModel') {
    configStore.set('ollamaModel', model);
  } else if (ROUTER_KEYS[id]) {
    const mr = { ...configStore.get('modelRouter') };
    mr[ROUTER_KEYS[id]] = model;
    configStore.set('modelRouter', mr);
  }
}

// ── Skills badge ─────────────────────────────────────────────────
skillsStore.on('proposedCount', count => {
  const badge = document.getElementById('skillsBadge');
  if (!badge) return;
  if (count > 0) { badge.style.display = 'inline'; badge.textContent = count; }
  else           { badge.style.display = 'none'; }
});

// ── Host badge ───────────────────────────────────────────────────
runtimeStore.on('platform', () => {
  const s = runtimeStore.snap();
  const badge = document.getElementById('newclaw-host-badge');
  if (badge && s.platform) {
    const osIcon = s.platform === 'win32' ? '🪟' : (s.platform === 'darwin' ? '🍏' : '🐧');
    const osName = s.platform === 'win32' ? 'Windows' : (s.platform === 'darwin' ? 'macOS' : 'Linux');
    badge.innerHTML = \`<span title="Servidor NewClaw (\${s.arch || 'unknown'})" style="font-size: 0.85rem; color: var(--text-soft); padding: 4px 8px; background: rgba(255,255,255,0.05); border-radius: 4px; margin-right: 12px; display: inline-flex; align-items: center; gap: 4px;">Servidor: \${osIcon} \${osName} · \${s.hostname || 'Desconhecido'}</span>\`;
  }
});

// ── Data loaders ─────────────────────────────────────────────────
async function loadConfig() {
  try {
    const c = await getConfig();
    configStore.patch({
      defaultProvider:        c.defaultProvider,
      language:               c.language,
      maxIterations:          c.maxIterations,
      memoryWindowSize:       c.memoryWindowSize,
      systemPrompt:           c.systemPrompt || '',
      ollamaUrl:              c.ollamaUrl    || 'http://localhost:11434',
      ollamaModel:            c.ollamaModel  || 'glm-5.2:cloud',
      telegramAllowedUserIds: c.telegramAllowedUserIds || '',
      hasGeminiKey:           c.hasGeminiKey      || false,
      hasDeepseekKey:         c.hasDeepseekKey    || false,
      hasGroqKey:             c.hasGroqKey        || false,
      hasOpenrouterKey:       c.hasOpenrouterKey  || false,
      hasOllamaApiKey:        c.hasOllamaApiKey   || false,
      currentModel:           c.currentModel  || c.ollamaModel || '—',
      modelRouter:            c.modelRouter   || {},
    });
  } catch {}
}

async function loadStatus() {
  try {
    const s = await getStatus();
    runtimeStore.patch({
      status: 'online',
      uptime: s.uptimeHuman || '—',
      ram:    s.memory?.heapUsed || '—',
      platform: s.platform || null,
      hostname: s.hostname || null,
      arch: s.arch || null,
      telegramChannel: s.telegramChannel || null,
    });
  } catch {
    runtimeStore.patch({ status: 'offline', uptime: '—', ram: '—', platform: null, hostname: null, arch: null, telegramChannel: null });
  }
}

async function loadProviders() {
  try {
    const p = await getProviders();
    const ollama = p.ollama;
    if (ollama?.models) {
      const models = ollama.models;
      providersStore.patch({
        models,
        ollamaOnline: true,
        ollamaModelCount: models.length,
      });
      updateDropdownModels(models);
    }
  } catch {}
}

async function loadTools() {
  try {
    const tools = await getTools();
    toolsStore.set('tools', tools);
  } catch {}
}

async function loadSkills() {
  try {
    const [skills, patterns] = await Promise.all([getSkills(), getPatterns()]);
    const stats = aggregateToolStats(patterns);
    skillsStore.patch({
      skills,
      patterns,
      activeCount:   skills.filter(s => s.status === 'active').length,
      proposedCount: skills.filter(s => s.status === 'proposed').length,
    });
    toolsStore.set('stats', stats);
  } catch {}
}

// ── Init ─────────────────────────────────────────────────────────
document.getElementById('header-root').innerHTML = window.newclawHeader('config');
window.newclawInitTheme?.();
window.newclawApplyI18n?.();

navigate('dashboard');

// Load data in background — stores update reactively
loadConfig();
loadStatus();
loadTools();
loadProviders().then(() => loadSkills());

setInterval(loadStatus,  30_000);
setInterval(loadSkills,  60_000);
setInterval(loadProviders, 120_000);
