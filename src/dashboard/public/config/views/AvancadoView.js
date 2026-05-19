import { configStore } from '../state.js';
import { showToast } from '../components/Toast.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>⚙️ Avançado</h1>
        <p>System prompt e configurações especializadas</p>
      </div>

      <details class="cfg-details" open>
        <summary>💬 System Prompt</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <textarea class="form-textarea" id="av-systemPrompt"
              placeholder="Instruções personalizadas do sistema..."
              style="min-height:160px;"></textarea>
            <div class="form-hint">Deixe vazio para usar o prompt padrão</div>
          </div>
        </div>
      </details>

      <details class="cfg-details">
        <summary>🔄 Reset de Formulário</summary>
        <div class="cfg-details-body">
          <p style="font-size:.8rem;color:var(--text-soft);margin-bottom:12px;">
            Restaura os valores padrão — não salva automaticamente.
          </p>
          <button class="btn btn-danger" style="width:auto;" id="av-resetBtn">🔄 Resetar Valores</button>
        </div>
      </details>
    </div>`;

  const cs = configStore;
  const s = cs.snap();

  document.getElementById('av-systemPrompt').value = s.systemPrompt || '';
  document.getElementById('av-systemPrompt').addEventListener('input', e =>
    cs.set('systemPrompt', e.target.value)
  );

  document.getElementById('av-resetBtn').addEventListener('click', () => {
    if (!confirm('Resetar para valores padrão?')) return;
    cs.patch({
      defaultProvider: 'ollama',
      language: 'pt-BR',
      maxIterations: 5,
      memoryWindowSize: 20,
      systemPrompt: '',
      ollamaModel: 'glm-5.1:cloud',
      telegramAllowedUserIds: '',
    });
    document.getElementById('av-systemPrompt').value = '';
    showToast('🔄 Resetado.', 'success');
  });
}
