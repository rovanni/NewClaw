import { checkUpdate, applyUpdate } from '../api.js';
import { showToast } from '../components/Toast.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>⬆️ ${t('sidebar_update')}</h1>
        <p>${t('update_page_desc')}</p>
      </div>

      <details class="cfg-details" open>
        <summary>${t('update_version_title')}</summary>
        <div class="cfg-details-body">
          <div id="upd-status" style="margin-bottom:14px;font-size:.9rem;color:var(--text-soft)">
            ${t('update_checking')}
          </div>
          <div id="upd-changelog" style="display:none;margin-bottom:14px"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-secondary" id="upd-checkBtn">${t('update_check_btn')}</button>
            <button class="btn btn-primary"   id="upd-applyBtn" style="display:none">${t('update_apply_btn')}</button>
          </div>
        </div>
      </details>
    </div>`;

  const statusEl    = document.getElementById('upd-status');
  const changelogEl = document.getElementById('upd-changelog');
  const checkBtn    = document.getElementById('upd-checkBtn');
  const applyBtn    = document.getElementById('upd-applyBtn');

  async function runCheck() {
    checkBtn.disabled = true;
    statusEl.style.color = 'var(--text-soft)';
    statusEl.textContent = t('update_checking_progress');
    changelogEl.style.display = 'none';
    try {
      const r = await checkUpdate();
      if (r.hasUpdate) {
        const countLabel = r.commitCount !== 1 ? t('update_commits_label') : t('update_commit_label');
        statusEl.innerHTML =
          `<span style="color:var(--warning)">${t('update_available_label')} — ${r.commitCount} ${countLabel}</span><br>` +
          `<span style="font-size:.8rem;color:var(--text-soft)">` +
          `Local: <code>${r.localSha}</code> → Remoto: <code>${r.remoteSha}</code></span>`;
        applyBtn.style.display = 'inline-flex';
        renderChangelog(r.commits || []);
      } else {
        statusEl.innerHTML =
          `<span style="color:var(--success)">${t('update_uptodate')}</span>` +
          ` — ${t('update_version_label')} <code>${r.localSha}</code>`;
        applyBtn.style.display = 'none';
        changelogEl.style.display = 'none';
      }
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">${t('update_error_prefix')} ${esc(e.message)}</span>`;
    } finally {
      checkBtn.disabled = false;
    }
  }

  function renderChangelog(commits) {
    if (!commits.length) return;
    changelogEl.innerHTML = `
      <div style="font-size:.8rem;color:var(--text-soft);margin-bottom:6px">${t('update_changelog_label')}</div>
      <div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;max-height:220px;overflow-y:auto">
        ${commits.map((c, i) => `
          <div style="display:flex;align-items:baseline;gap:8px;padding:6px 10px;
                      ${i < commits.length - 1 ? 'border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.06))' : ''}">
            <code style="font-size:.75rem;color:var(--accent);flex-shrink:0">${esc(c.sha)}</code>
            <span style="font-size:.82rem;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.msg)}</span>
            <span style="font-size:.75rem;color:var(--text-soft);flex-shrink:0">${esc(c.when)}</span>
          </div>`).join('')}
      </div>`;
    changelogEl.style.display = 'block';
  }

  checkBtn.addEventListener('click', runCheck);

  applyBtn.addEventListener('click', async () => {
    if (!confirm(t('update_confirm'))) return;
    applyBtn.disabled = true;
    checkBtn.disabled = true;
    changelogEl.style.display = 'none';
    statusEl.innerHTML = `<span style="color:var(--warning)">${t('update_in_progress')}</span>`;
    try {
      await applyUpdate();
      showToast(t('update_started_toast'), 'success');
      let tries = 0;
      const poll = async () => {
        try { const r = await fetch('/api/status'); if (r.ok) { location.reload(); return; } } catch {}
        if (++tries < 60) setTimeout(poll, 3000);
        else statusEl.innerHTML = `<span style="color:var(--danger)">${t('update_timeout_warn')}</span>`;
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
