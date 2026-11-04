import { guideBox } from '../app.js';
import { renderOpcionais } from './IntegracoesOpcionais.js';

// Integrações opcionais (ADR-030, Etapa 5; ADR-031): cada uma mora no próprio repositório e é instalada pelo manifesto.
// O suplemento do PowerPoint tinha um cartão próprio aqui; saiu do núcleo em 04/11/2026 (repositório newclaw-powerpoint).
export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🔌 ${t('sidebar_integrations')}</h1>
        <p>${t('integrations_page_desc')}</p>
      </div>

      ${guideBox(t('ig_page_guide'))}

      <div class="provider-grid" style="margin-top: 24px;">
        <div id="integracoes-opcionais" style="display: contents;"></div>
      </div>
    </div>
  `;

  const pararOpcionais = renderOpcionais(document.getElementById('integracoes-opcionais'));
  return () => { pararOpcionais(); };
}
