import { configStore } from '../state.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔒 Segurança</h1>
        <p>Controle de acesso e usuários autorizados</p>
      </div>

      <details class="cfg-details" open>
        <summary>📱 Telegram — Whitelist de Usuários</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <label class="form-label">IDs Autorizados</label>
            <input type="text" class="form-input" id="sg-telegramIds" placeholder="123456789, 987654321">
            <div class="form-hint">IDs numéricos separados por vírgula · use @userinfobot para descobrir o seu</div>
          </div>
        </div>
      </details>
    </div>`;

  const cs = configStore;
  const s = cs.snap();

  document.getElementById('sg-telegramIds').value = s.telegramAllowedUserIds || '';
  document.getElementById('sg-telegramIds').addEventListener('input', e =>
    cs.set('telegramAllowedUserIds', e.target.value)
  );
}
