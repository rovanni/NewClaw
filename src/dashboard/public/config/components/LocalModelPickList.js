/**
 * LocalModelPickList — lista de modelos locais (.gguf) com botão "usar este modelo", compartilhada
 * entre LocalModelWizard.js (Assistente Rápido) e ConfigWizard.js (Assistente completo).
 *
 * Achado ao vivo (2026-08-24, screenshot real do usuário): as duas listas eram construídas por
 * código quase idêntico, copiado em cada arquivo. Um bug visual (nenhuma separação entre linhas,
 * difícil saber qual botão pertence a qual modelo entre nomes parecidos como
 * `gemma-4-12B-it-Q4_K_M.gguf` / `gemma-4-26B-A4B-it-Q4_K_M.gguf`) corrigido só num dos dois
 * deixaria o outro divergente — exatamente o tipo de dessincronia manual que DRY existe pra evitar.
 *
 * NÃO é a mesma categoria de `formatBytes` duplicado por valor em ConfigWizard.js/
 * LocalModelWizard.js (utilitário puro de 4 linhas, sem estado — ver comentário lá: a diretriz do
 * projeto veta duplicar LÓGICA DE NEGÓCIO, não um utilitário desse tamanho, e importar entre os
 * dois wizards criaria acoplamento sem necessidade real). Este componente é diferente em dois
 * eixos: (1) já causou um bug real de UI ao divergir, não é hipotético; (2) é renderização pura —
 * sem estado de wizard, sem side-effect além do próprio `listEl` que o CHAMADOR já possui e
 * continua controlando — não cria acoplamento entre LocalModelWizard e ConfigWizard, os dois
 * continuam sem se importar um ao outro; só importam este componente-folha, mesma categoria de
 * `Toast.js` (já importado por ambos).
 *
 * A diferença de comportamento pós-clique (LocalModelWizard mostra um cronômetro no PRÓPRIO botão;
 * ConfigWizard transiciona pra uma tela nova `localLoading` com seu próprio loop de render) — a
 * razão real pela qual os dois wizards são mantidos como máquinas de estado independentes — não é
 * tocada aqui: fica inteira do lado de cada `onPick` que o chamador passa.
 */

function formatBytes(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${Math.round(bytes / (1024 ** 2))} MB`;
}

/**
 * Preenche `listEl` (elemento já existente no DOM do chamador — este módulo nunca cria nem
 * localiza o container) com uma linha por modelo. `onPick(modelId, buttonEl)` é chamado no clique;
 * `buttonEl` é o próprio botão, pra quem precisa desabilitá-lo ou escrever um cronômetro nele
 * (uso do Assistente Rápido) — ConfigWizard simplesmente ignora o segundo argumento.
 */
export function renderModelPickList(listEl, models, onPick) {
    listEl.innerHTML = '';
    models.forEach(m => {
        const row = document.createElement('div');
        row.className = 'wizard-model-row';
        const label = document.createElement('span');
        label.textContent = `${m.id} (${formatBytes(m.sizeBytes)})`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary btn-sm';
        btn.textContent = t('ml_local_serve_btn');
        btn.addEventListener('click', () => onPick(m.id, btn));
        row.appendChild(label);
        row.appendChild(btn);
        listEl.appendChild(row);
    });
}
