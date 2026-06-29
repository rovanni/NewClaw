import { configStore } from '../state.js';
import { showToast } from '../components/Toast.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>⚙️ ${t('sidebar_advanced')}</h1>
        <p>${t('advanced_page_desc')}</p>
      </div>

      <details class="cfg-details" open>
        <summary>💬 ${t('system_prompt_title')}</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <textarea class="form-textarea" id="av-systemPrompt"
              placeholder="${t('system_prompt_placeholder')}"
              style="min-height:160px;"></textarea>
            <div class="form-hint">${t('system_prompt_hint_text')}</div>
          </div>
        </div>
      </details>

      <details class="cfg-details">
        <summary>${t('reset_form_title')}</summary>
        <div class="cfg-details-body">
          <p style="font-size:.8rem;color:var(--text-soft);margin-bottom:12px;">
            ${t('reset_form_desc')}
          </p>
          <button class="btn btn-danger" style="width:auto;" id="av-resetBtn">${t('reset_values_btn')}</button>
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
    if (!confirm(t('reset_confirm'))) return;
    cs.patch({
      defaultProvider: 'ollama',
      language: 'pt-BR',
      maxIterations: 5,
      memoryWindowSize: 20,
      systemPrompt: '',
      ollamaModel: 'glm-5.2:cloud',
      telegramAllowedUserIds: '',
    });
    document.getElementById('av-systemPrompt').value = '';
    showToast(t('reset_done_toast'), 'success');
  });
}
