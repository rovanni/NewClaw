import { configStore } from '../state.js';
import { getAuthStatus, changePassword } from '../api.js';
import { showToast } from '../components/Toast.js';

async function getCapabilityMode() {
  const res = await fetch('/api/system/capability-mode', { credentials: 'include' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function setCapabilityMode(mode, godModeConfirmed = false) {
  const res = await fetch('/api/system/capability-mode', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, godModeConfirmed }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro desconhecido');
  return data;
}

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔒 ${t('sidebar_security')}</h1>
        <p>${t('security_page_desc')}</p>
      </div>

      <details class="cfg-details" open>
        <summary>⚡ Modo Operacional</summary>
        <div class="cfg-details-body">
          <div id="sg-modeStatus" class="form-hint" style="margin-bottom:12px">Carregando modo atual...</div>
          <div class="form-group" id="sg-modeCards" style="display:flex;gap:10px;flex-wrap:wrap"></div>
          <div class="form-hint" style="margin-top:10px">
            O modo é persistido no banco de dados e restaurado a cada reinicialização.<br>
            <strong>God Mode</strong> requer confirmação explícita e é registrado no audit log.
          </div>
        </div>
      </details>

      <details class="cfg-details" open>
        <summary>${t('telegram_whitelist_title')}</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <label class="form-label">${t('authorized_ids_label')}</label>
            <input type="text" class="form-input" id="sg-telegramIds" placeholder="123456789, 987654321">
            <div class="form-hint">${t('telegram_ids_hint')}</div>
          </div>
        </div>
      </details>

      <details class="cfg-details" open>
        <summary>${t('dashboard_password_title')}</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <div id="sg-authStatus" class="form-hint" style="margin-bottom:12px">${t('status_verifying')}</div>
          </div>
          <div class="form-group">
            <label class="form-label">${t('new_password_label')}</label>
            <input type="password" class="form-input" id="sg-newPassword" placeholder="${t('new_password_placeholder')}" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="form-label">${t('confirm_password_label')}</label>
            <input type="password" class="form-input" id="sg-confirmPassword" placeholder="${t('confirm_password_placeholder')}" autocomplete="new-password">
          </div>
          <div class="form-group" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" id="sg-savePassword">${t('save_password_btn')}</button>
            <button class="btn btn-secondary" id="sg-disableAuth" style="display:none">${t('disable_auth_btn')}</button>
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
        statusEl.innerHTML = `<span style="color:var(--success)">✅ ${t('auth_active_label')}</span> — ${t('auth_active_desc')}`;
        disableBtn.style.display = 'inline-flex';
      } else if (auth.enabled) {
        statusEl.innerHTML = `<span style="color:var(--warning)">⚠️ ${t('auth_no_pass_desc')}</span>`;
        disableBtn.style.display = 'inline-flex';
      } else {
        statusEl.innerHTML = `<span style="color:var(--muted)">🔓 ${t('auth_disabled_label')}</span> — ${t('auth_open_desc')}`;
        disableBtn.style.display = 'none';
      }
    } catch {
      statusEl.textContent = t('auth_check_failed');
    }
  }

  refreshAuthStatus();

  // ── Salvar senha ──────────────────────────────────────────────────────────
  document.getElementById('sg-savePassword').addEventListener('click', async () => {
    const newPwd  = document.getElementById('sg-newPassword').value.trim();
    const confirm = document.getElementById('sg-confirmPassword').value.trim();

    if (!newPwd) {
      showToast(t('enter_new_pass_toast'), 'warn');
      return;
    }
    if (newPwd.length < 6) {
      showToast(t('pass_too_short_toast'), 'warn');
      return;
    }
    if (newPwd !== confirm) {
      showToast(t('pass_mismatch_toast'), 'error');
      return;
    }

    try {
      await changePassword(newPwd, true);
      document.getElementById('sg-newPassword').value = '';
      document.getElementById('sg-confirmPassword').value = '';
      showToast(t('pass_saved_toast'), 'success');
      // Força recarregamento após 2s — token anterior foi invalidado
      setTimeout(() => location.reload(), 2000);
    } catch (err) {
      showToast('❌ Erro ao salvar senha: ' + err.message, 'error');
    }
  });

  // ── Desativar autenticação ────────────────────────────────────────────────
  disableBtn.addEventListener('click', async () => {
    if (!confirm(t('disable_auth_confirm'))) return;
    try {
      await changePassword('', false);
      showToast(t('auth_disabled_toast'), 'success');
      await refreshAuthStatus();
    } catch (err) {
      showToast('❌ Erro: ' + err.message, 'error');
    }
  });

  // ── Modo Operacional ──────────────────────────────────────────────────────
  const modeStatusEl = document.getElementById('sg-modeStatus');
  const modeCardsEl  = document.getElementById('sg-modeCards');

  const MODE_ICONS = { safe: '🔒', developer: '🛠️', god: '⚡' };
  const MODE_COLORS = {
    safe:      'var(--success)',
    developer: 'var(--warning)',
    god:       '#e74c3c',
  };

  async function renderModeCards() {
    try {
      const data = await getCapabilityMode();
      const { current, modes } = data;
      modeStatusEl.innerHTML =
        `Modo ativo: <strong style="color:${MODE_COLORS[current.mode]}">${MODE_ICONS[current.mode]} ${current.label}</strong>`;

      modeCardsEl.innerHTML = modes.map(m => `
        <div class="mode-card${m.active ? ' mode-card--active' : ''}"
             data-mode="${m.value}"
             style="
               flex:1;min-width:160px;padding:12px 14px;border-radius:8px;cursor:pointer;
               border:2px solid ${m.active ? MODE_COLORS[m.value] : 'var(--border)'};
               background:${m.active ? 'rgba(255,255,255,0.04)' : 'transparent'};
               transition:border-color .2s,background .2s
             ">
          <div style="font-size:1.4em;margin-bottom:4px">${MODE_ICONS[m.value]}</div>
          <div style="font-weight:600;color:${MODE_COLORS[m.value]}">${m.label}</div>
          <div style="font-size:0.78em;color:var(--muted);margin-top:4px;line-height:1.4">${m.description}</div>
        </div>
      `).join('');

      modeCardsEl.querySelectorAll('.mode-card').forEach(card => {
        card.addEventListener('click', async () => {
          const mode = card.dataset.mode;
          if (mode === current.mode) return;

          let godModeConfirmed = false;
          if (mode === 'god') {
            godModeConfirmed = confirm(
              '⚡ Ativar God Mode?\n\n' +
              'Neste modo o agente tem acesso ampliado ao sistema.\n' +
              'Audit log permanece ativo. Comandos destrutivos ainda são bloqueados.\n\n' +
              'Confirmar ativação?'
            );
            if (!godModeConfirmed) return;
          }

          try {
            await setCapabilityMode(mode, godModeConfirmed);
            showToast(`✅ Modo alterado para ${mode}`, 'success');
            await renderModeCards();
          } catch (err) {
            showToast(`❌ ${err.message}`, 'error');
          }
        });
      });
    } catch (err) {
      modeStatusEl.textContent = '⚠️ Não foi possível carregar o modo operacional.';
    }
  }

  renderModeCards();
}
