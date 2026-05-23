import { checkUpdate, applyUpdate } from '../api.js';
import { showToast } from '../components/Toast.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>⬆️ Atualização</h1>
        <p>Verifique e aplique atualizações do NewClaw.</p>
      </div>

      <details class="cfg-details" open>
        <summary>Status da versão</summary>
        <div class="cfg-details-body">
          <div id="upd-status" style="margin-bottom:14px;font-size:.9rem;color:var(--text-soft)">
            Verificando status da atualização...
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-secondary" id="upd-checkBtn">🔍 Verificar Agora</button>
            <button class="btn btn-primary"   id="upd-applyBtn" style="display:none">⬆️ Atualizar e Reiniciar</button>
          </div>
        </div>
      </details>
    </div>`;

  const statusEl = document.getElementById('upd-status');
  const checkBtn = document.getElementById('upd-checkBtn');
  const applyBtn = document.getElementById('upd-applyBtn');

  async function runCheck() {
    checkBtn.disabled = true;
    statusEl.style.color = 'var(--text-soft)';
    statusEl.textContent = '🔄 Verificando atualizações…';
    try {
      const r = await checkUpdate();
      if (r.hasUpdate) {
        const commits = r.commitCount > 1 ? ` (${r.commitCount} commits)` : '';
        statusEl.innerHTML =
          `<span style="color:var(--warning)">⬆️ Atualização disponível${commits}</span><br>` +
          `<span style="font-size:.8rem;color:var(--text-soft)">` +
          `Local: <code>${r.localSha}</code> → Remoto: <code>${r.remoteSha}</code></span>` +
          (r.latestCommit ? `<br><span style="font-size:.8rem;color:var(--text-soft)">${esc(r.latestCommit)}</span>` : '');
        applyBtn.style.display = 'inline-flex';
      } else {
        statusEl.innerHTML = `<span style="color:var(--success)">✅ Sistema atualizado</span> — versão <code>${r.localSha}</code>`;
        applyBtn.style.display = 'none';
      }
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">❌ Erro ao verificar: ${esc(e.message)}</span>`;
    } finally {
      checkBtn.disabled = false;
    }
  }

  checkBtn.addEventListener('click', runCheck);

  applyBtn.addEventListener('click', async () => {
    if (!confirm('Iniciar atualização e reiniciar o NewClaw?\n\nO sistema ficará indisponível por alguns minutos.')) return;
    applyBtn.disabled = true;
    checkBtn.disabled = true;
    statusEl.innerHTML = '<span style="color:var(--warning)">⏳ Atualização em andamento… o sistema será reiniciado automaticamente.</span>';
    try {
      await applyUpdate();
      showToast('⬆️ Atualização iniciada. Aguarde o reinício.', 'success');
      let tries = 0;
      const poll = async () => {
        try { const r = await fetch('/api/status'); if (r.ok) { location.reload(); return; } } catch {}
        if (++tries < 60) setTimeout(poll, 3000);
        else statusEl.innerHTML = '<span style="color:var(--danger)">⚠️ Reinício demorou mais que o esperado. Verifique os logs.</span>';
      };
      setTimeout(poll, 10000);
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
      applyBtn.disabled = false;
      checkBtn.disabled = false;
    }
  });

  runCheck();
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
