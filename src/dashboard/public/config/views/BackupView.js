import {
  listBackups, createSystemBackup, createDatabaseBackup, backupDownloadUrl,
  getBackupConfig, saveBackupConfig,
} from '../api.js';
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
        <p>Crie backups manuais e configure a retenção automática.</p>
      </div>

      <!-- Agendamento (info apenas) -->
      <details class="cfg-details" open>
        <summary>🕐 Agendamento</summary>
        <div class="cfg-details-body">
          <div class="form-hint" style="display:flex;align-items:flex-start;gap:8px">
            <span>ℹ️</span>
            <span>
              O backup automático do banco é gerenciado pelo <strong>crontab do sistema</strong>
              (<code>backup_db.sh</code>, a cada 6h). Para alterar o intervalo, edite o crontab no servidor.<br>
              Os arquivos gerados pelo crontab aparecem automaticamente na lista abaixo.
            </span>
          </div>
        </div>
      </details>

      <!-- Retenção -->
      <details class="cfg-details" open>
        <summary>🗑️ Retenção</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <label class="form-label">Manter últimos N backups por tipo</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="number" class="form-input" id="bkp-retention"
                     min="1" max="100" style="width:90px">
              <button class="btn btn-primary" id="bkp-saveRetention">Salvar</button>
            </div>
            <div class="form-hint">
              Ao criar um novo backup, os mais antigos são removidos automaticamente
              para manter o limite configurado. Conta separado por tipo (sistema e banco de dados).
            </div>
          </div>
        </div>
      </details>

      <!-- Backup manual -->
      <details class="cfg-details" open>
        <summary>📦 Backup Manual</summary>
        <div class="cfg-details-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary" id="bkp-systemBtn">📄 Backup do Sistema (.env)</button>
            <button class="btn btn-secondary" id="bkp-dbBtn">🗄️ Backup do Banco de Dados</button>
          </div>
          <div class="form-hint" style="margin-top:10px">
            Arquivos salvos em <code>data/backups/</code>.
          </div>
        </div>
      </details>

      <!-- Lista -->
      <details class="cfg-details" open>
        <summary>📋 Backups Disponíveis</summary>
        <div class="cfg-details-body">
          <div id="bkp-list">
            <div style="font-size:.85rem;color:var(--text-soft)">Carregando…</div>
          </div>
        </div>
      </details>
    </div>`;

  const listEl       = document.getElementById('bkp-list');
  const retentionEl  = document.getElementById('bkp-retention');
  const saveRetBtn   = document.getElementById('bkp-saveRetention');
  const sysBtn       = document.getElementById('bkp-systemBtn');
  const dbBtn        = document.getElementById('bkp-dbBtn');

  // ── Retenção ──────────────────────────────────────────────────────────────
  getBackupConfig().then(cfg => {
    retentionEl.value = cfg.retentionCount ?? 10;
  }).catch(() => { retentionEl.value = 10; });

  saveRetBtn.addEventListener('click', async () => {
    const n = parseInt(retentionEl.value, 10);
    if (!n || n < 1) { showToast('❌ Valor inválido', 'error'); return; }
    saveRetBtn.disabled = true;
    try {
      await saveBackupConfig({ retentionCount: n });
      showToast(`✅ Retenção salva: últimos ${n} backups por tipo`, 'success');
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
    } finally {
      saveRetBtn.disabled = false;
    }
  });

  // ── Lista ─────────────────────────────────────────────────────────────────
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
    try { renderList(await listBackups()); }
    catch { listEl.innerHTML = '<div style="font-size:.85rem;color:var(--danger)">Erro ao carregar backups.</div>'; }
  }

  // ── Backup manual ─────────────────────────────────────────────────────────
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
