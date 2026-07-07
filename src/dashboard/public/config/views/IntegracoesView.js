import { showToast } from '../components/Toast.js';
import { runtimeStore } from '../state.js';

export function render(container) {
  const isWindows = runtimeStore.snap().platform === 'win32';
  const serverOs = runtimeStore.snap().platform === 'darwin' ? 'macOS' : (runtimeStore.snap().platform === 'win32' ? 'Windows' : 'Linux');

  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔌 Integrações</h1>
        <p>Instale e gerencie extensões e integrações do NewClaw com outros softwares.</p>
      </div>

      <div class="model-cards" style="display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); margin-top: 24px;">
        
        <div class="m-card" style="display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div class="m-card-header" style="margin-bottom: 8px;">
              <span class="m-card-title" style="font-size: 1.1rem; font-weight: 600;">Suplemento PowerPoint</span>
            </div>
            <p style="font-size: 0.9rem; color: var(--text-soft); line-height: 1.4; margin-bottom: 16px;">
              Gere slides e apresentações diretamente dentro do Microsoft PowerPoint usando o NewClaw.
              <br><br>
              <strong>Requisitos:</strong> Windows, Office 365 ou 2019+, Node.js instalado.
            </p>
          </div>
          <div style="display: flex; justify-content: flex-end; align-items: center; gap: 12px;">
            ${!isWindows ? `
              <div style="font-size: 0.85rem; color: #ffb86c; background: rgba(255,184,108,0.1); padding: 8px; border-radius: 4px; line-height: 1.4; text-align: left; flex: 1;">
                ⚠️ <strong>A instalação remota neste servidor não é suportada.</strong> O suplemento precisa ser instalado no computador Windows onde o PowerPoint está disponível. (Alternativa temporária: instale localmente via código-fonte).
              </div>
              <button class="btn btn-primary" disabled style="opacity: 0.5;">
                <span class="ni">⚡</span> Instalação Indisponível
              </button>
            ` : `
              <button class="btn btn-primary" id="btnInstallPptx">
                <span class="ni">⚡</span> Instalar neste Servidor Windows
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
      
      if (!confirm('Deseja instalar o suplemento neste Servidor Windows? Isso compilará e registrará o add-in localmente.')) {
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="ni">⏳</span> Instalando neste servidor Windows...';
      
      try {
        const response = await (window.newclawFetch || fetch)('/api/integrations/install/powerpoint', {
          method: 'POST'
        });
        const data = await response.json();
        
        if (response.status === 409) {
          showToast(data.error, 'error');
          btn.innerHTML = '<span class="ni">⚡</span> Instalar neste Servidor Windows';
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
