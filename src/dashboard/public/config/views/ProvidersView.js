import { configStore, providersStore } from '../state.js';
import { showToast } from '../components/Toast.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔌 Providers</h1>
        <p>Conexões com LLMs e gerenciamento de chaves</p>
      </div>

      <div class="provider-grid">
        <div class="provider-card wide">
          <div class="provider-head">
            <div class="provider-name">
              🦙 Ollama
              <span class="badge badge-local">local</span>
              <span class="badge badge-cloud">cloud</span>
            </div>
            <div class="provider-health">
              <span class="dot" id="pv-ollamaDot"></span>
              <span id="pv-ollamaHealth">—</span>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">URL do Servidor</label>
              <input type="text" class="form-input" id="pv-ollamaUrl" placeholder="http://localhost:11434">
            </div>
            <div class="form-group">
              <label class="form-label">API Key (cloud)</label>
              <div class="api-key-group">
                <input type="password" class="form-input" id="pv-ollamaApiKey" placeholder="Opcional">
                <span class="api-key-status" id="pv-ollamaKeyStatus">—</span>
              </div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" id="pv-testOllama">🔍 Testar Conexão</button>
        </div>

        <div class="provider-card">
          <div class="provider-head">
            <div class="provider-name">✨ Google Gemini</div>
            <div class="provider-health"><span class="dot" id="pv-geminiDot"></span></div>
          </div>
          <div class="form-group">
            <label class="form-label">API Key</label>
            <div class="api-key-group">
              <input type="password" class="form-input" id="pv-geminiKey" placeholder="AIza...">
              <span class="api-key-status" id="pv-geminiStatus">—</span>
            </div>
          </div>
        </div>

        <div class="provider-card">
          <div class="provider-head">
            <div class="provider-name">🌊 DeepSeek</div>
            <div class="provider-health"><span class="dot" id="pv-deepseekDot"></span></div>
          </div>
          <div class="form-group">
            <label class="form-label">API Key</label>
            <div class="api-key-group">
              <input type="password" class="form-input" id="pv-deepseekKey" placeholder="sk-...">
              <span class="api-key-status" id="pv-deepseekStatus">—</span>
            </div>
          </div>
        </div>

        <div class="provider-card">
          <div class="provider-head">
            <div class="provider-name">⚡ Groq</div>
            <div class="provider-health"><span class="dot" id="pv-groqDot"></span></div>
          </div>
          <div class="form-group">
            <label class="form-label">API Key</label>
            <div class="api-key-group">
              <input type="password" class="form-input" id="pv-groqKey" placeholder="gsk_...">
              <span class="api-key-status" id="pv-groqStatus">—</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const cs = configStore;
  const s = cs.snap();
  const el = id => document.getElementById(id);

  // Populate from configStore
  el('pv-ollamaUrl').value    = s.ollamaUrl    || 'http://localhost:11434';
  el('pv-ollamaApiKey').value = '';
  setKeyStatus('pv-ollamaKeyStatus', 'pv-ollamaDot', s.hasOllamaApiKey);
  setKeyStatus('pv-geminiStatus',    'pv-geminiDot',   s.hasGeminiKey);
  setKeyStatus('pv-deepseekStatus',  'pv-deepseekDot', s.hasDeepseekKey);
  setKeyStatus('pv-groqStatus',      'pv-groqDot',     s.hasGroqKey);

  // Populate Ollama health from providersStore
  const ps = providersStore.snap();
  if (ps.ollamaOnline) {
    el('pv-ollamaDot').className = 'dot online';
    el('pv-ollamaHealth').textContent = ps.ollamaModelCount + ' modelos';
  }

  // Bind inputs to configStore
  el('pv-ollamaUrl').addEventListener('input',    e => cs.set('ollamaUrl', e.target.value));
  el('pv-ollamaApiKey').addEventListener('input', e => cs.set('ollamaApiKey', e.target.value));
  el('pv-geminiKey').addEventListener('input',    e => cs.set('geminiKey', e.target.value));
  el('pv-deepseekKey').addEventListener('input',  e => cs.set('deepseekKey', e.target.value));
  el('pv-groqKey').addEventListener('input',      e => cs.set('groqKey', e.target.value));

  // Test Ollama button
  el('pv-testOllama').addEventListener('click', testOllama);

  // Subscribe to providersStore for health updates
  const unsub = providersStore.on('*', ps => {
    if (ps.ollamaOnline) {
      el('pv-ollamaDot').className = 'dot online';
      el('pv-ollamaHealth').textContent = ps.ollamaModelCount + ' modelos';
    } else {
      el('pv-ollamaDot').className = 'dot offline';
      el('pv-ollamaHealth').textContent = 'Offline';
    }
  });

  return () => unsub();
}

function setKeyStatus(statusId, dotId, hasKey) {
  const s = document.getElementById(statusId);
  const d = document.getElementById(dotId);
  if (s) { s.textContent = hasKey ? '✓ OK' : '✗ Ausente'; s.className = 'api-key-status ' + (hasKey ? 'configured' : 'missing'); }
  if (d) { d.className = 'dot ' + (hasKey ? 'online' : 'offline'); }
}

async function testOllama() {
  const f = window.newclawFetch || fetch;
  showToast('🔍 Testando Ollama...', 'success');
  try {
    const res  = await f('/api/providers');
    const data = await res.json();
    if (data.success && data.providers?.ollama) {
      const cnt = data.providers.ollama.models?.length || 0;
      showToast('✅ Ollama OK — ' + cnt + ' modelos', 'success');
      document.getElementById('pv-ollamaDot').className   = 'dot online';
      document.getElementById('pv-ollamaHealth').textContent = cnt + ' modelos';
    } else {
      showToast('❌ Ollama não encontrado', 'error');
      document.getElementById('pv-ollamaDot').className = 'dot offline';
    }
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
    document.getElementById('pv-ollamaDot').className = 'dot offline';
  }
}
