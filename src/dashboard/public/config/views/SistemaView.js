import {
  checkUpdate, applyUpdate,
  listBackups, createSystemBackup, createDatabaseBackup, backupDownloadUrl,
} from '../api.js';
import { showToast } from '../components/Toast.js';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔧 Sistema</h1>
        <p>Atualização do sistema e backups de dados.</p>
      </div>

      <!-- ── Atualização ─────────────────────────────────────────── -->
      <details class="cfg-details" open>
        <summary>⬆️ Atualização</summary>
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

      <!-- ── Backup ──────────────────────────────────────────────── -->
      <details class="cfg-details" open>
        <summary>💾 Backup</summary>
        <div class="cfg-details-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
            <button class="btn btn-secondary" id="bkp-systemBtn">📄 Backup do Sistema (.env)</button>
            <button class="btn btn-secondary" id="bkp-dbBtn">🗄️ Backup do Banco de Dados</button>
          </div>
          <div id="bkp-list">
            <div style="font-size:.85rem;color:var(--text-soft)">Carregando backups...</div>
          </div>
        </div>
      </details>
    </div>`;

  // ── Update logic ──────────────────────────────────────────────────────────
  const statusEl  = document.getElementById('upd-status');
  const checkBtn  = document.getElementById('upd-checkBtn');
  const applyBtn  = document.getElementById('upd-applyBtn');

  async function runCheckUpdate() {
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
          (r.latestCommit ? `<br><span style="font-size:.8rem;color:var(--text-soft)">${escHtml(r.latestCommit)}</span>` : '');
        applyBtn.style.display = 'inline-flex';
      } else {
        statusEl.innerHTML = `<span style="color:var(--success)">✅ Sistema atualizado</span> — versão <code>${r.localSha}</code>`;
        applyBtn.style.display = 'none';
      }
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">❌ Erro ao verificar: ${escHtml(e.message)}</span>`;
    } finally {
      checkBtn.disabled = false;
    }
  }

  checkBtn.addEventListener('click', runCheckUpdate);

  applyBtn.addEventListener('click', async () => {
    if (!confirm('Iniciar atualização e reiniciar o NewClaw?\n\nO sistema ficará indisponível por alguns minutos.')) return;
    applyBtn.disabled = true;
    checkBtn.disabled = true;
    statusEl.innerHTML = '<span style="color:var(--warning)">⏳ Atualização em andamento… o sistema será reiniciado automaticamente.</span>';
    try {
      await applyUpdate();
      showToast('⬆️ Atualização iniciada. Aguarde o reinício.', 'success');
      // Poll for restart
      let tries = 0;
      const poll = async () => {
        try {
          const r = await fetch('/api/status');
          if (r.ok) { location.reload(); return; }
        } catch {}
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

  // Run check automatically on load
  runCheckUpdate();

  // ── Backup logic ──────────────────────────────────────────────────────────
  const listEl   = document.getElementById('bkp-list');
  const sysBtn   = document.getElementById('bkp-systemBtn');
  const dbBtn    = document.getElementById('bkp-dbBtn');

  function renderBackupList(backups) {
    if (!backups.length) {
      listEl.innerHTML = '<div style="font-size:.85rem;color:var(--text-soft)">Nenhum backup encontrado.</div>';
      return;
    }
    listEl.innerHTML = `
      <table style="width:100%;font-size:.82rem;border-collapse:collapse">
        <thead>
          <tr style="color:var(--text-soft);text-align:left;border-bottom:1px solid var(--border)">
            <th style="padding:6px 8px">Arquivo</th>
            <th style="padding:6px 8px">Tamanho</th>
            <th style="padding:6px 8px">Data</th>
            <th style="padding:6px 8px"></th>
          </tr>
        </thead>
        <tbody>
          ${backups.map(b => `
            <tr style="border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.06))">
              <td style="padding:6px 8px;font-family:monospace">${escHtml(b.name)}</td>
              <td style="padding:6px 8px;color:var(--text-soft)">${escHtml(b.sizeHuman)}</td>
              <td style="padding:6px 8px;color:var(--text-soft)">${fmtDate(b.createdAt)}</td>
              <td style="padding:6px 8px">
                <a href="${backupDownloadUrl(b.name)}" download="${escHtml(b.name)}"
                   style="font-size:.78rem;color:var(--accent);text-decoration:none">⬇️ baixar</a>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  async function loadBackups() {
    try {
      const backups = await listBackups();
      renderBackupList(backups);
    } catch {
      listEl.innerHTML = '<div style="font-size:.85rem;color:var(--danger)">Erro ao carregar backups.</div>';
    }
  }

  async function doBackup(label, fn) {
    const btn = label === 'sistema' ? sysBtn : dbBtn;
    btn.disabled = true;
    showToast(`⏳ Criando backup do ${label}...`, 'success');
    try {
      const b = await fn();
      showToast(`✅ Backup criado: ${b.name} (${b.sizeHuman})`, 'success');
      loadBackups();
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  sysBtn.addEventListener('click', () => doBackup('sistema', createSystemBackup));
  dbBtn.addEventListener('click',  () => doBackup('banco de dados', createDatabaseBackup));

  loadBackups();
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
