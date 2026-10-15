import {
  listBackups, createSystemBackup, createDatabaseBackup, backupDownloadUrl,
  getBackupConfig, saveBackupConfig, getBackupSchedule, restoreBackup, uploadBackup,
  createKnowledgeBackup, inspectKnowledgeBackup, restoreKnowledgeBackup, importKnowledgeBackup,
} from '../api.js';
import { showToast } from '../components/Toast.js';
import { guideBox } from '../app.js';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(newclawGetLang(), { dateStyle: 'short', timeStyle: 'short' });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>💾 ${t('sidebar_backup')}</h1>
        <p>${t('backup_page_desc')}</p>
      </div>

      ${guideBox(t('bkp_page_guide'))}

      <!-- ADR-020: o pacote único com tudo o que a instalação aprendeu — o caminho principal para leigos. -->
      <details class="cfg-details" open>
        <summary>🧠 ${t('bkp_conh_title')}</summary>
        <div class="cfg-details-body">
          <div class="form-hint" style="margin-bottom:10px">${t('bkp_conh_desc')}</div>
          <label style="display:flex;gap:8px;align-items:center;font-size:.85rem;margin:4px 0"><input type="checkbox" id="bkp-conhHistorico"> ${t('bkp_conh_opt_history')}</label>
          <label style="display:flex;gap:8px;align-items:center;font-size:.85rem;margin:4px 0"><input type="checkbox" id="bkp-conhWorkspace"> ${t('bkp_conh_opt_workspace')}</label>
          <label style="display:flex;gap:8px;align-items:center;font-size:.85rem;margin:4px 0"><input type="checkbox" id="bkp-conhSegredos"> ${t('bkp_conh_opt_secrets')}</label>
          <div class="form-hint" style="margin:2px 0 10px 26px;color:var(--warning,#f59e0b)">${t('bkp_conh_opt_secrets_hint')}</div>
          <button class="btn btn-primary" id="bkp-conhBtn">${t('bkp_conh_btn')}</button>
          <div class="form-hint" style="margin-top:10px">${t('bkp_conh_restore_hint')}</div>
        </div>
      </details>

      <details class="cfg-details" open>
        <summary>${t('backup_schedule_title')}</summary>
        <div class="cfg-details-body">
          <div id="bkp-scheduleInfo" class="form-hint" style="display:flex;align-items:flex-start;gap:8px">
            <span>⏳</span><span>Verificando agendamento de backup…</span>
          </div>
        </div>
      </details>

      <details class="cfg-details" open>
        <summary>${t('backup_retention_title')}</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <label class="form-label">${t('backup_retention_label')}</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="number" class="form-input" id="bkp-retention"
                     min="1" max="100" style="width:90px">
              <button class="btn btn-primary" id="bkp-saveRetention">${t('backup_retention_save_btn')}</button>
            </div>
            <div class="form-hint">${t('backup_retention_hint')}</div>
          </div>
        </div>
      </details>

      <details class="cfg-details" open>
        <summary>${t('backup_manual_title')}</summary>
        <div class="cfg-details-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary" id="bkp-systemBtn">${t('backup_system_btn')}</button>
            <button class="btn btn-secondary" id="bkp-dbBtn">${t('backup_db_btn')}</button>
          </div>
          <div class="form-hint" style="margin-top:10px">${t('backup_path_hint')}</div>
        </div>
      </details>

      <details class="cfg-details" open>
        <summary>${t('backup_list_title')}</summary>
        <div class="cfg-details-body">
          <div id="bkp-list">
            <div style="font-size:.85rem;color:var(--text-soft)">${t('backup_loading')}</div>
          </div>
        </div>
      </details>

      <details class="cfg-details">
        <summary>${t('backup_upload_title')}</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <label class="form-label">${t('backup_upload_hint')}</label>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <label class="btn btn-secondary" style="cursor:pointer">
                ${t('backup_upload_btn')}
                <input type="file" id="bkp-uploadInput" accept=".bak,.db,.zip" style="display:none">
              </label>
              <span id="bkp-uploadName" style="font-size:.82rem;color:var(--text-soft)"></span>
            </div>
          </div>
        </div>
      </details>
    </div>`;

  const listEl       = document.getElementById('bkp-list');
  const retentionEl  = document.getElementById('bkp-retention');
  const saveRetBtn   = document.getElementById('bkp-saveRetention');
  const sysBtn       = document.getElementById('bkp-systemBtn');
  const dbBtn        = document.getElementById('bkp-dbBtn');
  const uploadInput  = document.getElementById('bkp-uploadInput');
  const uploadNameEl = document.getElementById('bkp-uploadName');

  // ── Agendamento (dinâmico via crontab) ───────────────────────────────────
  const scheduleEl = document.getElementById('bkp-scheduleInfo');
  getBackupSchedule().then(s => {
    if (s.found) {
      scheduleEl.innerHTML =
        `<span>🕐</span>` +
        `<span>Backup automático ativo: <strong>${esc(s.humanReadable || s.cronExpr)}</strong></span>`;
    } else {
      scheduleEl.innerHTML =
        `<span>ℹ️</span><span>Nenhum agendamento automático configurado. ` +
        `Os backups manuais abaixo continuam funcionando normalmente.</span>`;
    }
  }).catch(() => {
    scheduleEl.innerHTML = `<span>⚠️</span><span>Não foi possível verificar o agendamento de backup.</span>`;
  });

  // ── Retenção ──────────────────────────────────────────────────────────────
  getBackupConfig().then(cfg => {
    retentionEl.value = cfg.retentionCount ?? 10;
  }).catch(() => { retentionEl.value = 10; });

  saveRetBtn.addEventListener('click', async () => {
    const n = parseInt(retentionEl.value, 10);
    if (!n || n < 1) { showToast(t('backup_invalid_retention'), 'error'); return; }
    saveRetBtn.disabled = true;
    try {
      await saveBackupConfig({ retentionCount: n });
      showToast(t('backup_saved_retention', { n }), 'success');
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
    } finally {
      saveRetBtn.disabled = false;
    }
  });

  // ── Lista ─────────────────────────────────────────────────────────────────
  function renderList(backups) {
    if (!backups.length) {
      listEl.innerHTML = `<div style="font-size:.85rem;color:var(--text-soft)">${t('backup_empty')}</div>`;
      return;
    }
    listEl.innerHTML = `
      <table style="width:100%;font-size:.82rem;border-collapse:collapse">
        <thead>
          <tr style="color:var(--text-soft);text-align:left;border-bottom:1px solid var(--border)">
            <th style="padding:6px 8px">${t('backup_col_file')}</th>
            <th style="padding:6px 8px">${t('backup_col_size')}</th>
            <th style="padding:6px 8px">${t('backup_col_date')}</th>
            <th style="padding:6px 8px"></th>
          </tr>
        </thead>
        <tbody>
          ${backups.map(b => `
            <tr style="border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.06))">
              <td style="padding:6px 8px;font-family:monospace">${esc(b.name)}</td>
              <td style="padding:6px 8px;color:var(--text-soft)">${esc(b.sizeHuman)}</td>
              <td style="padding:6px 8px;color:var(--text-soft)">${fmtDate(b.createdAt)}</td>
              <td style="padding:6px 8px;white-space:nowrap">
                <a href="${backupDownloadUrl(b.name)}" download="${esc(b.name)}"
                   style="font-size:.78rem;color:var(--accent);text-decoration:none;margin-right:12px">${t('backup_download')}</a>
                <a href="#" data-restore="${esc(b.name)}"
                   style="font-size:.78rem;color:var(--warning,#f59e0b);text-decoration:none">${t('backup_restore_btn')}</a>
                ${b.name.endsWith('.zip') ? `<a href="#" data-import="${esc(b.name)}" title="${esc(t('bkp_conh_import_hint'))}"
                   style="font-size:.78rem;color:var(--accent);text-decoration:none;margin-left:12px">${t('bkp_conh_import_btn')}</a>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  async function loadList() {
    try { renderList(await listBackups()); }
    catch { listEl.innerHTML = `<div style="font-size:.85rem;color:var(--danger)">${t('backup_load_error')}</div>`; }
  }

  // ── Restore ───────────────────────────────────────────────────────────────
  // ── Importar (mesclar) — ADR-020 Sprint B ────────────────────────────────
  listEl.addEventListener('click', async (e) => {
    const link = e.target.closest('[data-import]');
    if (!link) return;
    e.preventDefault();
    const name = link.dataset.import;
    let info;
    try { info = await inspectKnowledgeBackup(name); }
    catch (err) { showToast('❌ ' + err.message, 'error'); return; }
    const m = info.manifesto || {};
    const c = m.contagens || {};
    const resumo = t('bkp_conh_restore_summary', {
      data: fmtDate(m.criadoEm), sistema: m.sistema || '?', app: m.app || '?',
      memorias: c.memorias ?? 0, skills: c.skills ?? 0, conversas: c.conversas ?? 0, arquivos: c.arquivosDoWorkspace ?? 0,
    });
    const avisos = (info.avisos || []).map(a => '⚠️ ' + a).join('\n');
    if (!confirm(`${resumo}${avisos ? '\n\n' + avisos : ''}\n\n${t('bkp_conh_import_confirm')}`)) return;
    link.style.opacity = '0.4';
    link.style.pointerEvents = 'none';
    try {
      const r = (await importKnowledgeBackup(name)).relatorio || {};
      const mem = r.memorias || {};
      const sk = r.skills || {};
      showToast(t('bkp_conh_imported_toast', {
        memorias: mem.importadas ?? 0, existiam: mem.jaExistiam ?? 0,
        skills: sk.novas ?? 0, revisar: (mem.paraRevisar ?? 0) + (sk.paraRevisar || []).length,
        conflitos: (mem.preferenciasEmConflito || []).length + (sk.comDiferenca || []).length,
      }), 'success');
      loadList();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    } finally {
      link.style.opacity = '';
      link.style.pointerEvents = '';
    }
  });

  listEl.addEventListener('click', async (e) => {
    const link = e.target.closest('[data-restore]');
    if (!link) return;
    e.preventDefault();
    const name = link.dataset.restore;
    // ADR-020: o pacote de conhecimento mostra o que contém ANTES de restaurar.
    let restaurarSegredos = false;
    if (name.endsWith('.zip')) {
      let info;
      try { info = await inspectKnowledgeBackup(name); }
      catch (err) { showToast('❌ ' + err.message, 'error'); return; }
      const m = info.manifesto || {};
      const c = m.contagens || {};
      const resumo = t('bkp_conh_restore_summary', {
        data: fmtDate(m.criadoEm), sistema: m.sistema || '?', app: m.app || '?',
        memorias: c.memorias ?? 0, skills: c.skills ?? 0, conversas: c.conversas ?? 0, arquivos: c.arquivosDoWorkspace ?? 0,
      });
      const avisos = (info.avisos || []).map(a => '⚠️ ' + a).join('\n');
      if (!confirm(`${resumo}${avisos ? '\n\n' + avisos : ''}\n\n${t('bkp_conh_restore_confirm')}`)) return;
      if (m.conteudo?.segredos) restaurarSegredos = confirm(t('bkp_conh_restore_secrets_confirm'));
    } else if (!confirm(t('backup_restore_confirm', { name }))) return;
    link.style.opacity = '0.4';
    link.style.pointerEvents = 'none';
    showToast(t('backup_restoring_toast'), 'success');
    try {
      if (name.endsWith('.zip')) {
        const r = await restoreKnowledgeBackup(name, restaurarSegredos);
        const rel = r.relatorio || {};
        const revisar = (rel.skillsParaRevisar || []).length;
        showToast(t('bkp_conh_restored_toast', { skills: rel.skills ?? 0, revisar }), 'success');
      } else {
        await restoreBackup(name);
      }
      showToast(t('backup_restored_toast'), 'success');
    } catch (err) {
      link.style.opacity = '';
      link.style.pointerEvents = '';
      showToast('❌ ' + err.message, 'error');
    }
  });

  // ── Upload ────────────────────────────────────────────────────────────────
  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.bak') && !file.name.endsWith('.db') && !file.name.endsWith('.zip')) {
      showToast(t('backup_upload_invalid'), 'error');
      uploadInput.value = '';
      return;
    }
    uploadNameEl.textContent = file.name;
    showToast(t('backup_uploading_toast'), 'success');
    try {
      await uploadBackup(file);
      showToast(t('backup_uploaded_toast', { name: file.name }), 'success');
      uploadInput.value = '';
      uploadNameEl.textContent = '';
      loadList();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  });

  // ── Backup manual ─────────────────────────────────────────────────────────
  async function doBackup(label, fn, btn) {
    btn.disabled = true;
    showToast(t('backup_creating_toast', { label }), 'success');
    try {
      const b = await fn();
      showToast(t('backup_created_toast', { name: b.name, size: b.sizeHuman }), 'success');
      loadList();
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  const conhBtn = document.getElementById('bkp-conhBtn');
  conhBtn.addEventListener('click', () => doBackup(t('bkp_conh_label'), async () => {
    const r = await createKnowledgeBackup({
      historico: document.getElementById('bkp-conhHistorico').checked,
      workspace: document.getElementById('bkp-conhWorkspace').checked,
      segredos:  document.getElementById('bkp-conhSegredos').checked,
    });
    return r.backup;
  }, conhBtn));
  sysBtn.addEventListener('click', () => doBackup(t('sidebar_backup') + ' sistema', createSystemBackup, sysBtn));
  dbBtn.addEventListener('click',  () => doBackup('banco de dados', createDatabaseBackup, dbBtn));

  loadList();
}
