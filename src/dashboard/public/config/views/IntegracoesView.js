import { showToast } from '../components/Toast.js';

export function render(container) {
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
          <div style="display: flex; justify-content: flex-end;">
            <button class="btn btn-primary" id="btnInstallPptx">
              <span class="ni">⚡</span> Instalar Suplemento
            </button>
          </div>
        </div>

      </div>
    </div>
  `;

  document.getElementById('btnInstallPptx').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const originalText = btn.innerHTML;
    
    if (!confirm('Deseja instalar o suplemento do PowerPoint? Isso irá abrir processos em segundo plano para compilar e registrar o add-in no seu Office.')) {
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="ni">⏳</span> Instalando...';
    
    try {
      const response = await (window.newclawFetch || fetch)('/api/integrations/install/powerpoint', {
        method: 'POST'
      });
      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      showToast(data.message || 'Instalação iniciada com sucesso!', 'success');
      btn.innerHTML = '<span class="ni">✅</span> Instalação Iniciada';
    } catch (err) {
      showToast('Erro: ' + err.message, 'error');
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  });

  return () => {
    // Cleanup se necessário
  };
}
