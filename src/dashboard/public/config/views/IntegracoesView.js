import { showToast } from '../components/Toast.js';
import { runtimeStore } from '../state.js';

export function render(container) {
  const isWindows = runtimeStore.snap().platform === 'win32';
  const serverOs = runtimeStore.snap().platform === 'darwin' ? 'macOS' : (runtimeStore.snap().platform === 'win32' ? 'Windows' : 'Linux');

  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔌 ${t('sidebar_integrations')}</h1>
        <p>${t('integrations_page_desc')}</p>
      </div>

      <div class="provider-grid" style="margin-top: 24px;">
        
        <div class="provider-card wide" style="display: flex; flex-direction: column; justify-content: space-between;">
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
          <div style="display: flex; flex-direction: column; gap: 12px; align-items: stretch;">
            ${!isWindows ? `
              <div style="font-size: 0.85rem; color: #ffb86c; background: rgba(255,184,108,0.1); padding: 12px; border-radius: 4px; line-height: 1.5; text-align: left;">
                ⚠️ ${t('pptx_remote_not_supported')}
              </div>
              <button class="btn btn-primary" disabled style="opacity: 0.5; align-self: flex-end;">
                <span class="ni">⚡</span> ${t('pptx_install_unavailable')}
              </button>
            ` : `
              <button class="btn btn-primary" id="btnInstallPptx" style="align-self: flex-end;">
                <span class="ni">⚡</span> ${t('pptx_install_windows')}
              </button>
            `}
          </div>
        </div>

      </div>
    </div>
  `;

  let pollInterval = null;

  const btnInstall = document.getElementById('btnInstallPptx');
  if (btnInstall) {
    btnInstall.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      
      if (!confirm(t('pptx_install_confirm'))) {
        return;
      }

      btn.disabled = true;
      btn.innerHTML = `<span class="ni">⏳</span> ${t('pptx_installing')}`;
      
      try {
        const response = await (window.newclawFetch || fetch)('/api/integrations/install/powerpoint', {
          method: 'POST'
        });
        const data = await response.json();
        
        if (response.status === 409) {
          showToast(data.error, 'error');
          btn.innerHTML = `<span class="ni">⚡</span> ${t('pptx_install_windows')}`;
          btn.disabled = false;
          return;
        }

        if (data.error) {
          throw new Error(data.error);
        }
        
        if (response.status === 202 && data.jobId) {
            let attempts = 0;
            const maxAttempts = 150; // 5 minutos a 2s
            
            pollInterval = setInterval(async () => {
                attempts++;
                if (attempts >= maxAttempts) {
                    clearInterval(pollInterval);
                    btn.innerHTML = '<span class="ni">⚠️</span> Status desconhecido/continue verificando';
                    return;
                }

                try {
                    const statusRes = await (window.newclawFetch || fetch)(`/api/integrations/install/powerpoint/status/${data.jobId}`);
                    
                    if (statusRes.status === 404) {
                        clearInterval(pollInterval);
                        btn.innerHTML = '<span class="ni">⚠️</span> Status da instalação indisponível; o servidor pode ter sido reiniciado.';
                        return;
                    }

                    const statusData = await statusRes.json();
                    
                    if (statusData.status === 'succeeded') {
                        clearInterval(pollInterval);
                        showToast('Instalação concluída no servidor Windows.', 'success');
                        btn.innerHTML = '<span class="ni">✅</span> Instalação concluída no servidor';
                    } else if (statusData.status === 'failed') {
                        clearInterval(pollInterval);
                        showToast('Falha na instalação. Verifique os logs.', 'error');
                        btn.innerHTML = '<span class="ni">❌</span> Erro na instalação no servidor';
                        setTimeout(() => { btn.disabled = false; btn.innerHTML = '<span class="ni">⚡</span> Instalar neste Servidor Windows'; }, 5000);
                    }
                    // if 'running', do nothing, just wait next tick
                } catch (err) {
                    // Ignora falha transitória (rede, etc) e tenta de novo no próximo tick
                    console.warn("Falha transitória no polling:", err);
                }
            }, 2000);
        } else {
            // Fallback caso responda 200 síncrono por algum motivo (embora a nova API use 202)
            showToast(data.message, 'success');
            btn.innerHTML = '<span class="ni">✅</span> Instalação concluída no servidor';
        }
      } catch (err) {
        showToast('Erro: ' + err.message, 'error');
        btn.innerHTML = '<span class="ni">❌</span> Erro na instalação';
        setTimeout(() => { btn.disabled = false; btn.innerHTML = '<span class="ni">⚡</span> Instalar neste Servidor Windows'; }, 3000);
      }
    });
  }

  return () => {
    if (pollInterval) {
        clearInterval(pollInterval);
    }
  };
}
