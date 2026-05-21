import { configStore } from '../state.js';
import { getAuthStatus, changePassword } from '../api.js';
import { showToast } from '../components/Toast.js';

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

      <details class="cfg-details" open>
        <summary>🔑 Senha do Dashboard</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <div id="sg-authStatus" class="form-hint" style="margin-bottom:12px">Verificando...</div>
          </div>
          <div class="form-group">
            <label class="form-label">Nova Senha</label>
            <input type="password" class="form-input" id="sg-newPassword" placeholder="Nova senha (mín. 6 caracteres)" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="form-label">Confirmar Nova Senha</label>
            <input type="password" class="form-input" id="sg-confirmPassword" placeholder="Repita a nova senha" autocomplete="new-password">
          </div>
          <div class="form-group" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" id="sg-savePassword">💾 Salvar Senha</button>
            <button class="btn btn-secondary" id="sg-disableAuth" style="display:none">🔓 Desativar Autenticação</button>
          </div>
          <div class="form-hint" style="margin-top:8px">
            A senha é salva no banco de dados e persiste entre reinicializações.<br>
            Se a variável <code>DASHBOARD_PASSWORD</code> estiver definida no ambiente, ela tem prioridade.
          </div>
        </div>
      </details>
    </div>`;

  // ── Telegram IDs ──────────────────────────────────────────────────────────
  const cs = configStore;
  const s = cs.snap();
  document.getElementById('sg-telegramIds').value = s.telegramAllowedUserIds || '';
  document.getElementById('sg-telegramIds').addEventListener('input', e =>
    cs.set('telegramAllowedUserIds', e.target.value)
  );

  // ── Auth status ───────────────────────────────────────────────────────────
  const statusEl    = document.getElementById('sg-authStatus');
  const disableBtn  = document.getElementById('sg-disableAuth');

  async function refreshAuthStatus() {
    try {
      const auth = await getAuthStatus();
      if (auth.enabled && auth.hasPassword) {
        statusEl.innerHTML = '<span style="color:var(--success)">✅ Autenticação ATIVA</span> — o dashboard exige senha para acesso.';
        disableBtn.style.display = 'inline-flex';
      } else if (auth.enabled) {
        statusEl.innerHTML = '<span style="color:var(--warning)">⚠️ Autenticação ativada mas sem senha definida.</span>';
        disableBtn.style.display = 'inline-flex';
      } else {
        statusEl.innerHTML = '<span style="color:var(--muted)">🔓 Sem autenticação</span> — qualquer pessoa na rede pode acessar o dashboard.';
        disableBtn.style.display = 'none';
      }
    } catch {
      statusEl.textContent = 'Não foi possível verificar o status de autenticação.';
    }
  }

  refreshAuthStatus();

  // ── Salvar senha ──────────────────────────────────────────────────────────
  document.getElementById('sg-savePassword').addEventListener('click', async () => {
    const newPwd  = document.getElementById('sg-newPassword').value.trim();
    const confirm = document.getElementById('sg-confirmPassword').value.trim();

    if (!newPwd) {
      showToast('⚠️ Informe a nova senha.', 'warn');
      return;
    }
    if (newPwd.length < 6) {
      showToast('⚠️ A senha deve ter pelo menos 6 caracteres.', 'warn');
      return;
    }
    if (newPwd !== confirm) {
      showToast('❌ As senhas não coincidem.', 'error');
      return;
    }

    try {
      await changePassword(newPwd, true);
      document.getElementById('sg-newPassword').value = '';
      document.getElementById('sg-confirmPassword').value = '';
      showToast('✅ Senha salva! Você será solicitado a fazer login novamente.', 'success');
      // Força recarregamento após 2s — token anterior foi invalidado
      setTimeout(() => location.reload(), 2000);
    } catch (err) {
      showToast('❌ Erro ao salvar senha: ' + err.message, 'error');
    }
  });

  // ── Desativar autenticação ────────────────────────────────────────────────
  disableBtn.addEventListener('click', async () => {
    if (!confirm('Desativar a autenticação? O dashboard ficará acessível sem senha.')) return;
    try {
      await changePassword('', false);
      showToast('🔓 Autenticação desativada.', 'success');
      await refreshAuthStatus();
    } catch (err) {
      showToast('❌ Erro: ' + err.message, 'error');
    }
  });
}
