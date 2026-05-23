import { listBackups, createSystemBackup, createDatabaseBackup, backupDownloadUrl } from '../api.js';
import { showToast } from '../components/Toast.js';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>💾 Backup</h1>
        <p>Crie e baixe backups do sistema e do banco de dados.</p>
      </div>

      <details class="cfg-details" open>
        <summary>Criar Backup</summary>
        <div class="cfg-details-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary" id="bkp-systemBtn">📄 Backup do Sistema (.env)</button>
            <button class="btn btn-secondary" id="bkp-dbBtn">🗄️ Backup do Banco de Dados</button>
          </div>
          <div class="form-hint" style="margin-top:10px">
            Os arquivos são salvos em <code>data/backups/</code> e ficam disponíveis para download na lista abaixo.
          </div>
        </div>
      </details>

      <details class="cfg-details" open>
        <summary>Backups Disponíveis</summary>
        <div class="cfg-details-body">
          <div id="bkp-list">
            <div style="font-size:.85rem;color:var(--text-soft)">Carregando…</div>
          </div>
        </div>
      </details>
    </div>`;

  const listEl  = document.getElementById('bkp-list');
  const sysBtn  = document.getElementById('bkp-systemBtn');
  const dbBtn   = document.getElementById('bkp-dbBtn');

  function renderList(backups) {
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
              <td style="padding:6px 8px;font-family:monospace">${esc(b.name)}</td>
              <td style="padding:6px 8px;color:var(--text-soft)">${esc(b.sizeHuman)}</td>
              <td style="padding:6px 8px;color:var(--text-soft)">${fmtDate(b.createdAt)}</td>
              <td style="padding:6px 8px">
                <a href="${backupDownloadUrl(b.name)}" download="${esc(b.name)}"
                   style="font-size:.78rem;color:var(--accent);text-decoration:none">⬇️ baixar</a>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  async function loadList() {
    try {
      renderList(await listBackups());
    } catch {
      listEl.innerHTML = '<div style="font-size:.85rem;color:var(--danger)">Erro ao carregar backups.</div>';
    }
  }

  async function doBackup(label, fn, btn) {
    btn.disabled = true;
    showToast(`⏳ Criando backup do ${label}...`, 'success');
    try {
      const b = await fn();
      showToast(`✅ Backup criado: ${b.name} (${b.sizeHuman})`, 'success');
      loadList();
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  sysBtn.addEventListener('click', () => doBackup('sistema', createSystemBackup, sysBtn));
  dbBtn.addEventListener('click',  () => doBackup('banco de dados', createDatabaseBackup, dbBtn));

  loadList();
}
