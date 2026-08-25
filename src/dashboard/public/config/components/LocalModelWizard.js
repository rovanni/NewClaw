/**
 * Assistente de Configuração Rápida — guia opcional pra configurar um modelo local (.gguf) sem
 * precisar saber de antemão a ordem das abas Provedores → Adicionar Modelo → Escolher Modelo.
 *
 * Aberto só por clique explícito no botão — nunca por `ready === false` ou qualquer outro estado
 * operacional: isso não significa que a pessoa quer modelo local (alguém com Ollama Cloud mal
 * configurado também tem `ready===false`, sem nunca ter demonstrado interesse em modelo local).
 * Inferir intenção a partir de estado violaria a Regra 10 (determinismo valida, nunca adivinha).
 *
 * Não guarda progresso: cada abertura recalcula o passo atual a partir do estado real (pasta,
 * catálogo, servidor, prontidão) — as mesmas fontes que as 4 abas já usam, nunca uma segunda fonte
 * de verdade. `localStorage` guarda só se o CONVITE (destaque visual do botão) já foi dispensado —
 * nunca progresso nem estado operacional. O botão em si nunca desaparece.
 *
 * `ensureLocalProvider`/`computeSystemReady` chegam por referência no mount() em vez de serem
 * importadas de `ModelosView.js`: esse módulo já importa este arquivo pra montá-lo, e importar de
 * volta criaria um ciclo entre os dois.
 */
import { configStore, providersStore } from '../state.js';
import { getLocalModels, serveLocalModel } from '../api.js';
import { doSave, loadProviders } from '../app.js';
import { showToast } from './Toast.js';
import { renderModelPickList } from './LocalModelPickList.js';

/** Convenção de chave já usada por outras preferências de UI (`sidebar_collapsed`/`tts` em
 *  index.html) — reproduzida aqui como literal porque `config.html` é uma página separada, sem
 *  acesso às constantes `SKEY`/`SKEY_VERSION` daquele módulo inline. */
const DISMISS_KEY = 'newclaw_v1_ml_wizard_convite_dispensado';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function mountLocalModelWizard(container, { ensureLocalProvider, computeSystemReady }) {
  if (!container) return () => {};

  let open = false;
  let busy = false; // um carregamento em andamento — evita clique duplo em modelos diferentes
  // Verdadeiro depois que ModelosView desmonta esta instância (troca de aba). Nenhuma continuação
  // assíncrona iniciada por ESTA instância (refresh, saveDirAndRefresh, loadModel, o listener de
  // providersStore) pode alterar DOM/painel/render depois disso — a mesma regra em todo ponto de
  // retomada após `await`, sem exceção. Necessário porque #ml-wizardPanel é um id fixo: uma
  // instância antiga ainda em voo consegue reencontrar o painel de uma instância NOVA remontada no
  // mesmo container e mexer nele por engano (bug crítico achado por /review e reproduzido por /qa,
  // 2026-08-19).
  let destroyed = false;

  function isDismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  }
  function dismiss() {
    // Único caminho de código que grava este flag — nunca compartilhado com o que muta
    // configStore/providersStore, então não há risco de o destaque de UI vazar pra estado
    // operacional por acidente.
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* sem localStorage: só fica sem destaque, nada quebra */ }
    renderEntry();
  }

  function renderEntry() {
    // Sempre reconstrói com o painel fechado (o template abaixo é hardcoded display:none) — `open`
    // precisa acompanhar isso, senão um clique later em #ml-wizardBtn parte de um `open` desatualizado
    // e alterna pro estado errado. Achado ao vivo: dismiss() chama renderEntry() (fecha o DOM) sem
    // isso, e o botão seguinte simplesmente não abria mais o painel.
    open = false;
    const dismissed = isDismissed();
    container.innerHTML = `
      <button type="button" id="ml-wizardBtn" class="btn btn-sm ${dismissed ? 'btn-ghost' : 'btn-primary'}">
        🧭 ${t('ml_wizard_entry_btn')}
      </button>
      <div id="ml-wizardPanel" style="display:none;margin-top:10px;"></div>`;
    document.getElementById('ml-wizardBtn')?.addEventListener('click', () => {
      open = !open;
      if (open) refresh(); else closePanel();
    });
  }

  function closePanel() {
    const panel = document.getElementById('ml-wizardPanel');
    if (panel) panel.style.display = 'none';
  }

  async function refresh() {
    const panel = document.getElementById('ml-wizardPanel');
    if (!panel) return;
    panel.style.display = '';
    panel.className = 'ml-guide-box';
    panel.innerHTML = `<div class="form-hint">${t('ml_wizard_loading')}</div>`;
    const state = await determineState();
    if (destroyed) return; // instância desmontada durante o scan — nada a renderizar
    if (document.getElementById('ml-wizardPanel') === panel) renderStep(panel, state);
  }

  /** estado real → próximo passo. Nenhum dos 7 é inventado — cada um mapeia direto pra um campo
   *  já devolvido por GET /api/models/local ou por computeSystemReady(). */
  async function determineState() {
    const dir = (configStore.get('localModelsDir') || '').trim();
    if (!dir) return { step: 'folder', dir: '' };

    let r;
    try {
      r = await getLocalModels(dir);
    } catch (err) {
      return { step: 'folder_error', dir, error: err.message };
    }
    if (r.error) return { step: 'folder_error', dir, error: r.error };

    const models = r.models || [];
    if (models.length === 0) return { step: 'no_models', dir };
    if (!r.serverBinary) return { step: 'no_binary', dir };

    // "Rodando" só conta se o arquivo em execução ainda está entre os listados AGORA — trocar de
    // pasta pode deixar `running` apontando pra um modelo que nem aparece mais nesta listagem.
    const runningListed = r.running && models.some(m => m.id === r.running.file);
    if (!runningListed) return { step: 'ready_to_load', dir, models };

    if (computeSystemReady()) return { step: 'done', file: r.running.file };
    // Carregado, mas a prontidão global ainda não refletiu (janela entre o modelo responder e
    // loadProviders(true) atualizar health/catálogo). Fica visível; a assinatura de providersStore
    // abaixo recalcula sozinha quando o polling de saúde chegar — sem um setTimeout próprio.
    return { step: 'confirming', file: r.running.file };
  }

  function saveDirAndRefresh(inputId) {
    return async () => {
      const v = document.getElementById(inputId)?.value.trim() || '';
      if (!v) return;
      configStore.set('localModelsDir', v);
      const state = await determineState();
      if (destroyed) return; // instância desmontada durante o scan — não salva nem renderiza por ela
      // Buscar com sucesso É a declaração "esta é a minha pasta" — mesmo critério que a aba
      // Adicionar Modelo já usa (só persiste quando o scan não deu erro).
      if (state.step !== 'folder_error') await doSave();
      if (destroyed) return;
      const panel = document.getElementById('ml-wizardPanel');
      if (panel) renderStep(panel, state);
    };
  }

  function renderStep(panel, state) {
    if (state.step === 'folder') {
      panel.className = 'ml-guide-box';
      panel.innerHTML = `
        <div class="ml-test-title">${t('ml_wizard_step1_title')}</div>
        <div class="form-hint" style="margin:6px 0 10px;">${t('ml_wizard_step1_hint')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input type="text" class="form-input" id="ml-wizardDir" placeholder="${t('ml_local_dir_placeholder')}" style="flex:1;min-width:220px;">
          <button type="button" class="btn btn-primary btn-sm" id="ml-wizardScanBtn">${t('ml_local_scan_btn')}</button>
        </div>`;
      document.getElementById('ml-wizardScanBtn')?.addEventListener('click', saveDirAndRefresh('ml-wizardDir'));
      document.getElementById('ml-wizardDir')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('ml-wizardScanBtn')?.click();
      });
    } else if (state.step === 'folder_error') {
      panel.className = 'ml-test-result ml-test-fail';
      panel.innerHTML = `
        <div class="ml-test-title">${t('ml_local_dir_error')}</div>
        <div class="form-hint" style="margin:6px 0;"><code>${esc(state.error)}</code></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <input type="text" class="form-input" id="ml-wizardDir" value="${esc(state.dir)}" style="flex:1;min-width:220px;">
          <button type="button" class="btn btn-primary btn-sm" id="ml-wizardScanBtn">${t('ml_local_scan_btn')}</button>
        </div>`;
      document.getElementById('ml-wizardScanBtn')?.addEventListener('click', saveDirAndRefresh('ml-wizardDir'));
    } else if (state.step === 'no_models') {
      panel.className = 'ml-test-result ml-test-pending';
      panel.innerHTML = `
        <div class="ml-test-title">${t('ml_local_empty')}</div>
        <div class="form-hint" style="margin:6px 0;"><code>${esc(state.dir)}</code></div>
        <button type="button" class="btn btn-primary btn-sm" id="ml-wizardRescan">${t('ml_local_scan_btn')}</button>`;
      document.getElementById('ml-wizardRescan')?.addEventListener('click', refresh);
    } else if (state.step === 'no_binary') {
      panel.className = 'ml-test-result ml-test-fail';
      panel.innerHTML = `
        <div class="ml-test-title">${t('ml_local_nobinary_title')}</div>
        <div class="form-hint" style="margin:6px 0;">${t('ml_local_nobinary_hint')}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="ml-wizardRescan">${t('ml_local_scan_btn')}</button>`;
      document.getElementById('ml-wizardRescan')?.addEventListener('click', refresh);
    } else if (state.step === 'ready_to_load') {
      panel.className = 'ml-guide-box';
      panel.innerHTML = `
        <div class="ml-test-title">${t('ml_wizard_step_load_title')}</div>
        <div class="form-hint" style="margin:6px 0 10px;">${t('ml_wizard_step_load_hint')}</div>
        <div id="ml-wizardModelList"></div>`;
      const list = document.getElementById('ml-wizardModelList');
      // DOM construído via createElement/textContent (não innerHTML de string) para nome de
      // arquivo vindo do disco — mesma disciplina que corrigiu o XSS real do CodeQL #14 em
      // ModelDropdown.js. Renderização em si vem de LocalModelPickList.js, compartilhada com
      // ConfigWizard.js — ver docstring do módulo pra por que essa duplicação específica valia a
      // pena eliminar (bug visual real) sem violar a independência entre os dois wizards.
      renderModelPickList(list, state.models, loadModel);
    } else if (state.step === 'confirming') {
      panel.className = 'ml-test-result ml-test-pending';
      panel.innerHTML = `<div class="ml-test-title">${t('ml_wizard_step_confirming', { model: esc(state.file) })}</div>`;
    } else if (state.step === 'done') {
      panel.className = 'ml-test-result ml-test-ok';
      panel.innerHTML = `
        <div class="ml-test-title">${t('ml_wizard_step_done', { model: esc(state.file) })}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button type="button" class="btn btn-ghost btn-sm" id="ml-wizardClose">${t('ml_wizard_close_btn')}</button>
          <button type="button" class="btn btn-ghost btn-sm" id="ml-wizardDismiss">${t('ml_wizard_dismiss_btn')}</button>
        </div>`;
      document.getElementById('ml-wizardDismiss')?.addEventListener('click', dismiss);
    }
    document.getElementById('ml-wizardClose')?.addEventListener('click', () => {
      // Fechar não é dispensar — só esconde o painel. Reabrir recalcula do zero.
      open = false;
      closePanel();
    });
  }

  async function loadModel(file, btn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    const original = btn.textContent;
    const startedAt = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      btn.textContent = `${t('ml_local_serving')} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    try {
      const r = await serveLocalModel(file);
      await ensureLocalProvider(r.url, file);
      await loadProviders(true); // health/catálogo refletem o modelo recém-carregado
      showToast(t('ml_local_served_toast', { model: file }), 'success');
    } catch (err) {
      showToast('❌ ' + (err.message === 'no_server_binary' ? t('ml_local_nobinary_title') : err.message), 'error');
    } finally {
      clearInterval(timer);
      busy = false;
      if (btn.isConnected) { btn.disabled = false; btn.textContent = original; }
      // O carregamento em si (serveLocalModel/ensureLocalProvider/loadProviders) segue até o fim
      // mesmo se a instância foi desmontada — é efeito real no servidor de modelo, não efeito de
      // UI, e abortá-lo deixaria o servidor num estado pela metade. Só o passo seguinte (reabrir
      // o painel) é efeito de instância, e por isso é o que fica condicionado a `!destroyed`.
      if (!destroyed && open) await refresh();
    }
  }

  renderEntry();

  // Enquanto o painel está aberto, recalcula quando o polling de saúde já em andamento trouxer
  // novidade (ex.: transição "confirming" → "done") — reaproveita o mesmo mecanismo de
  // atualização que a página já roda, sem criar um segundo polling.
  const unsubHealth = providersStore.on('*', () => { if (!destroyed && open) refresh(); });

  return () => { destroyed = true; unsubHealth(); };
}
