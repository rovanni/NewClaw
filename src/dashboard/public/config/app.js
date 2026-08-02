import {
  configStore, runtimeStore, providersStore, toolsStore, skillsStore,
} from './state.js';
import {
  getConfig, getStatus, getProviders, getTools,
  getSkills, getPatterns, aggregateToolStats, saveConfig as apiSaveConfig,
  modelExists, pullModel as apiPullModel, addModel, getModelCatalog,
} from './api.js';
import { showToast } from './components/Toast.js';
import { installGlobalHelpers, updateDropdownModels } from './components/ModelDropdown.js';

// ── Expose configStore for views that need window.__configStore ──
window.__configStore = configStore;

// ── Dirty state (alterações não salvas) ──────────────────────────
// Toda edição de config passa pelo configStore; persistir em disco só acontece no doSave().
// Este rastreio fecha o buraco entre os dois: qualquer mudança após o carregamento inicial
// marca os botões Salvar/Reiniciar até o próximo save bem-sucedido.
let configLoaded = false;
let configDirty  = false;

configStore.on('*', () => { if (configLoaded && !configDirty) setConfigDirty(true); });

function setConfigDirty(v) {
  configDirty = v;
  updateDirtyUI();
}

function updateDirtyUI() {
  const hint = configDirty ? t('unsaved_changes_hint') : '';
  ['btnSave', 'btnRestart'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('btn-dirty', configDirty);
    btn.title = hint;
  });
}

window.addEventListener('beforeunload', e => {
  if (configDirty) { e.preventDefault(); e.returnValue = ''; }
});

// ── Router ──────────────────────────────────────────────────────
const VIEW_MAP = {
  dashboard:   'DashboardView',
  modelos:     'ModelosView',
  ferramentas: 'FerramentasView',
  skills:      'SkillsView',
  integracoes: 'IntegracoesView',
  seguranca:   'SegurancaView',
  avancado:    'AvancadoView',
  atualizacao: 'AtualizacaoView',
  backup:      'BackupView',
  desenvolvedor: 'DesenvolvedorView',
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
  updateDirtyUI(); // re-traduz o title dos botões Salvar/Reiniciar
  navigate(currentPage);
});

// ── Sidebar nav ──────────────────────────────────────────────────
document.querySelectorAll('#sidebar-nav .nav-item').forEach(item => {
  item.addEventListener('click', () => navigate(item.dataset.page));
});

// ── Modo Desenvolvedor — mostra/esconde a aba conforme o estado persistido/ativado ──────────
function applyDevModeVisibility(enabled) {
  const nav = document.getElementById('nav-desenvolvedor');
  if (nav) nav.style.display = enabled ? 'flex' : 'none';
  // Se a aba sumiu enquanto o usuário estava nela, não deixa a página orfã — volta pro Dashboard.
  if (!enabled && currentPage === 'desenvolvedor') navigate('dashboard');
}
applyDevModeVisibility(newclawIsDevMode());
window.addEventListener('newclaw-devmode-changed', e => {
  applyDevModeVisibility(e.detail.enabled);
  showToast(e.detail.enabled ? t('dev_mode_enabled_toast') : t('dev_mode_disabled_toast'), 'success');
});

// ── Save & Restart ───────────────────────────────────────────────
document.getElementById('btnSave').addEventListener('click', doSave);
document.getElementById('btnRestart').addEventListener('click', doRestart);

export async function doSave() {
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
    // Sempre enviado (mesmo vazio): '' significa "não uso pasta local", uma escolha que precisa
    // chegar ao servidor para apagar um valor anterior — ver o !== undefined na rota.
    localModelsDir:         c.localModelsDir || '',
  };

  // Include API keys only if user typed something
  if (c.ollamaApiKey)    config.ollamaApiKey    = c.ollamaApiKey;
  if (c.geminiKey)       config.geminiKey       = c.geminiKey;
  if (c.deepseekKey)     config.deepseekKey     = c.deepseekKey;
  if (c.groqKey)         config.groqKey         = c.groqKey;
  if (c.openrouterKey)   config.openrouterKey   = c.openrouterKey;
  if (c.anthropicKey)    config.anthropicKey    = c.anthropicKey;

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
        showToast(t(model.includes(':cloud') ? 'ml_model_registering_toast' : 'ml_pulling_toast', { model }), 'success');
        apiPullModel(model)
          .then(() => { showToast(t('ml_model_ready_toast', { model }), 'success'); loadProviders(); })
          .catch(() => {});
      }
    } catch {}
  }

  try {
    await apiSaveConfig(config);
    setConfigDirty(false);
    showToast(t('config_saved_toast'), 'success');
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  }
}

async function doRestart() {
  await doSave();
  if (!confirm(t('restart_confirm'))) return;
  const f = window.newclawFetch || fetch;
  try {
    await f('/api/restart', { method: 'POST' });
    showToast(t('restarting_toast'), 'success');
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
    badge.innerHTML = `<span title="Servidor NewClaw (${s.arch || 'unknown'})" style="font-size: 0.85rem; color: var(--text-soft); padding: 4px 8px; background: rgba(255,255,255,0.05); border-radius: 4px; margin-right: 12px; display: inline-flex; align-items: center; gap: 4px;">Servidor: ${osIcon} ${osName} · ${s.hostname || 'Desconhecido'}</span>`;
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
      hasAnthropicKey:        c.hasAnthropicKey   || false,
      hasOllamaApiKey:        c.hasOllamaApiKey   || false,
      currentModel:           c.currentModel  || c.ollamaModel || '—',
      modelRouter:            c.modelRouter   || {},
      customProviders:        c.customProviders || [],
      localModelsDir:         c.localModelsDir || '',
    });
  } catch {}
  // Só a partir daqui mudanças no configStore contam como "não salvas" — o patch inicial acima
  // (e o estado default caso o fetch falhe) não são edição do usuário.
  configLoaded = true;
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

// Caixa de ajuda passo a passo no topo de cada aba — nasceu em ModelosView.js (2026-07-25),
// extraída pra cá pra virar ponto único compartilhado por todas as views, em vez de cada uma
// duplicar a mesma função. Evita precisar de uma página de ajuda separada.
export function guideBox(text) {
  return `<div class="ml-guide-box">${text}</div>`;
}

export async function loadProviders(forceRefresh = false) {
  try {
    const resp = await getProviders();
    const p = resp.providers || {};
    const health = resp.health || [];
    const ollama = p.ollama;
    if (ollama?.models) {
      const models = ollama.models;
      // `models` é a lista de NOMES oferecida ao autocomplete (instalados + cloud conhecidos +
      // custom + digitados pelo usuário) — nunca foi a contagem de modelos do Ollama. Usar
      // models.length como "ollamaModelCount" inflava o número exibido (ex.: 21 com 6 instalados).
      // O discovery real já devolve a contagem por provider em `health`.
      const ollamaHealth = health.find(h => h.provider === 'ollama');
      providersStore.patch({
        models,
        ollamaOnline: ollamaHealth ? ollamaHealth.online : true,
        ollamaModelCount: ollamaHealth ? ollamaHealth.modelCount : models.length,
        health,
        // Último modelo local carregado (pode não estar no ar) — a UI usa junto com o health para
        // oferecer recarregá-lo depois de um reinício da máquina.
        lastKnownLocalModel: resp.lastKnownLocalModel || null,
      });
      updateDropdownModels(models);
    }
  } catch {}

  try {
    const { models } = await getModelCatalog(forceRefresh);
    providersStore.patch({ catalog: models || [], lastSync: Date.now() });
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
