import { showToast } from '../components/Toast.js';
import { runtimeStore } from '../state.js';

export function render(container) {
  const isWindows = runtimeStore.snap().platform === 'win32';

  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔌 ${t('sidebar_integrations')}</h1>
        <p>${t('integrations_page_desc')}</p>
      </div>

      <div class="provider-grid" style="margin-top: 24px;">

        <div id="pptx-card" class="provider-card wide" style="display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div style="margin-bottom: 8px;">
              <span style="font-size: 1.1rem; font-weight: 600;">${t('pptx_addin_title')}</span>
            </div>
            <p style="font-size: 0.9rem; color: var(--text-soft); line-height: 1.4; margin-bottom: 16px;">
              ${t('pptx_addin_desc')}
              <br><br>
              <strong>${t('req_label')}</strong> ${t('req_pptx')}
            </p>
          </div>
          <div id="pptx-actions" style="display: flex; flex-direction: column; gap: 12px; align-items: stretch;">
            <div style="text-align: center; color: var(--text-soft); font-size: 0.9rem; padding: 12px;">
              <span class="ni">⏳</span> ${t('loading') || 'Loading...'}
            </div>
          </div>
        </div>

      </div>
    </div>
  `;

  let pollInterval = null;

  const setupUI = (installed) => {
    const card = document.getElementById('pptx-card');
    const actions = document.getElementById('pptx-actions');
    if (!card || !actions) return;

    if (installed) {
        card.classList.add('is-enabled');
        card.style.borderLeft = '3px solid var(--success)';
        actions.innerHTML = `
            <button class="btn btn-danger" id="btnUninstallPptx" style="align-self: flex-end;">
              <span class="ni">🗑️</span> ${t('pptx_uninstall_btn')}
            </button>
        `;
    } else {
        card.classList.remove('is-enabled');
        card.style.borderLeft = '';
        actions.innerHTML = !isWindows ? `
            <div style="font-size: 0.85rem; color: var(--danger); background: var(--danger-bg); padding: 12px; border-radius: 4px; line-height: 1.5; text-align: left;">
              ⚠️ ${t('pptx_remote_not_supported')}
            </div>
            <button class="btn btn-primary" disabled style="opacity: 0.5; align-self: flex-end;">
              <span class="ni">⚡</span> ${t('pptx_install_unavailable')}
            </button>
        ` : `
            <button class="btn btn-primary" id="btnInstallPptx" style="align-self: flex-end;">
              <span class="ni">⚡</span> ${t('pptx_install_windows')}
            </button>
        `;
    }

    const btnInstall = document.getElementById('btnInstallPptx');
    if (btnInstall) {
      btnInstall.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (!confirm(t('pptx_install_confirm'))) return;

        btn.disabled = true;
        btn.innerHTML = `<span class="ni">⏳</span> ${t('pptx_installing')}`;

        try {
          const response = await (window.newclawFetch || fetch)('/api/integrations/install/powerpoint', { method: 'POST' });
          const data = await response.json();

          if (response.status === 409) {
            showToast(data.error, 'error');
            btn.innerHTML = `<span class="ni">⚡</span> ${t('pptx_install_windows')}`;
            btn.disabled = false;
            return;
          }
          if (data.error) throw new Error(data.error);

          if (response.status === 202 && data.jobId) {
              let attempts = 0;
              pollInterval = setInterval(async () => {
                  attempts++;
                  if (attempts >= 150) {
                      clearInterval(pollInterval);
                      btn.innerHTML = `<span class="ni">⚠️</span> ${t('pptx_status_unknown')}`;
                      return;
                  }
                  try {
                      const statusRes = await (window.newclawFetch || fetch)(`/api/integrations/install/powerpoint/status/${data.jobId}`);
                      if (statusRes.status === 404) {
                          clearInterval(pollInterval);
                          btn.innerHTML = `<span class="ni">⚠️</span> ${t('pptx_status_unavailable')}`;
                          return;
                      }
                      const statusData = await statusRes.json();
                      if (statusData.status === 'succeeded') {
                          clearInterval(pollInterval);
                          showToast(t('pptx_install_success_toast'), 'success');
                          btn.innerHTML = `<span class="ni">✅</span> ${t('pptx_install_success')}`;
                          setTimeout(() => setupUI(true), 1500);
                      } else if (statusData.status === 'failed') {
                          clearInterval(pollInterval);
                          showToast(t('pptx_install_failed_toast'), 'error');
                          btn.innerHTML = `<span class="ni">❌</span> ${t('pptx_install_failed')}`;
                          setTimeout(() => { btn.disabled = false; btn.innerHTML = `<span class="ni">⚡</span> ${t('pptx_install_windows')}`; }, 5000);
                      }
                  } catch (err) {
                      console.warn("Falha transitória no polling:", err);
                  }
              }, 2000);
          } else {
              showToast(data.message, 'success');
              btn.innerHTML = `<span class="ni">✅</span> ${t('pptx_install_success')}`;
              setTimeout(() => setupUI(true), 1500);
          }
        } catch (err) {
          showToast(t('pptx_install_error') + ': ' + err.message, 'error');
          btn.innerHTML = `<span class="ni">❌</span> ${t('pptx_install_error')}`;
          setTimeout(() => { btn.disabled = false; btn.innerHTML = `<span class="ni">⚡</span> ${t('pptx_install_windows')}`; }, 3000);
        }
      });
    }

    const btnUninstall = document.getElementById('btnUninstallPptx');
    if (btnUninstall) {
        btnUninstall.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            if (!confirm(t('pptx_uninstall_confirm'))) return;

            btn.disabled = true;
            btn.innerHTML = `<span class="ni">⏳</span> ${t('pptx_uninstalling')}`;

            try {
                const response = await (window.newclawFetch || fetch)('/api/integrations/install/powerpoint', { method: 'DELETE' });
                const data = await response.json();

                if (data.error) throw new Error(data.error);

                showToast(data.message || 'Suplemento desinstalado.', 'success');
                setupUI(false);
            } catch (err) {
                showToast('Erro: ' + err.message, 'error');
                btn.disabled = false;
                btn.innerHTML = `<span class="ni">🗑️</span> ${t('pptx_uninstall_btn')}`;
            }
        });
    }
  };

  (async () => {
      try {
          const res = await (window.newclawFetch || fetch)('/api/integrations/powerpoint/status');
          const data = await res.json();
          setupUI(data.installed);
      } catch (e) {
          setupUI(false);
      }
  })();

  return () => {
    if (pollInterval) clearInterval(pollInterval);
  };
}
