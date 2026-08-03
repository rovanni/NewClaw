/**
 * Reactive store — pub/sub via EventTarget pattern.
 * Each store holds a slice of app state. Views subscribe to keys
 * they care about and re-render when those keys change.
 */
// ── Rastro de alterações de configuração ────────────────────────────────────
//
// Motivo (sessão de diagnóstico 02/08/2026): um operador relatou que os botões da aba Modelos
// "não respondiam". Reproduzido: 16 minutos mexendo na tela produziram ZERO linhas de log. O
// servidor só registra quando o Salvar é acionado com sucesso (`POST /api/config`,
// `Provider switched to:`, `Persisted to .env`) — tudo que acontece antes disso, ou que falha
// antes de chegar lá, é invisível. Sem rastro, "cliquei e não aconteceu nada" não é
// diagnosticável nem por quem tem acesso ao servidor, ao banco e ao código.
//
// O `Store` é o funil único por onde toda mudança de configuração passa, então instrumentá-lo
// cobre a superfície inteira — inclusive telas futuras — sem espalhar chamadas de log por view.
//
// `set()` é edição do usuário; `patch()` é hidratação vinda do servidor (único chamador:
// app.js, ao carregar). Distinguir os dois é o que faz o log dizer "você mudou" em vez de
// "mudou", que é a informação que faltava.

// O store guarda credenciais reais (API keys de provedores). Diagnóstico não pode virar
// vazamento: destes campos loga-se apenas a PRESENÇA, nunca o valor.
const CAMPO_SENSIVEL = /key|token|password|secret|senha/i;

function resumirValor(chave, valor) {
  if (CAMPO_SENSIVEL.test(chave)) return valor ? '<definido>' : '<vazio>';
  if (valor === null || valor === undefined) return String(valor);
  if (typeof valor === 'object') {
    const json = JSON.stringify(valor);
    return json.length > 140 ? `${json.slice(0, 137)}…` : json;
  }
  const texto = String(valor);
  return texto.length > 90 ? `${texto.slice(0, 87)}…` : texto;
}

/**
 * Registra uma AÇÃO do operador — clique, seleção, tentativa — independente de ela ter mudado
 * estado ou não.
 *
 * É o complemento indispensável do log de transições: um botão que sai por um `return` mudo não
 * altera nada, e por isso não aparece em lugar nenhum. Era esse o caso de `rt-applyBtn` e
 * `rt-applyAllBtn`, que retornam sem efeito quando não há modelo selecionado — do lado de fora,
 * idêntico a um botão quebrado.
 *
 * `resultado` deve dizer o que aconteceu, inclusive quando nada aconteceu e por quê.
 */
export function logAcaoUI(acao, resultado, detalhe) {
  const extra = detalhe === undefined ? '' : ` ${resumirValor(acao, detalhe)}`;
  console.info(`[ui:acao] ${acao} → ${resultado}${extra}`);
}

class Store {
  #s; #m = new Map(); #auditado;
  constructor(init = {}, auditado = false) { this.#s = structuredClone(init); this.#auditado = auditado; }

  get(k)      { return this.#s[k]; }
  snap()      { return structuredClone(this.#s); }

  /**
   * Registra a transição no console do navegador. Só para o store de configuração — os demais
   * (runtime, providers) mudam a cada polling de status e afogariam o console em ruído,
   * repetindo o erro que já existe no log do servidor com o `discovery failed` de minuto em
   * minuto.
   */
  #auditar(chave, antes, depois, origem) {
    if (!this.#auditado) return;
    const de = resumirValor(chave, antes);
    const para = resumirValor(chave, depois);
    if (de === para) return; // re-render escrevendo o mesmo valor não é uma ação
    console.info(`[ui:config] ${chave}: ${de} → ${para} (${origem})`);
  }

  set(k, v)   { const antes = this.#s[k]; this.#s[k] = v; this.#auditar(k, antes, v, 'alterado na tela — NÃO SALVO');
                this.#emit(k, v); this.#emit('*', this.#s); }
  // Precisa emitir por-chave igual set(), não só '*': quem assina uma chave específica (ex:
  // providersStore.on('catalog', ...)) nunca disparava quando essa chave só era atualizada via
  // patch() (é o caso de 'catalog'/'models' em loadProviders() — nunca usam set()). Bug real
  // encontrado 2026-07-25: modelo baixado não aparecia em "Escolher Modelo" sem F5, porque o
  // re-render de renderModelTable()/renderCategoryPicker() só estava plugado no evento 'catalog'.
  patch(p)    { const antes = { ...this.#s }; Object.assign(this.#s, p);
                for (const k of Object.keys(p)) this.#auditar(k, antes[k], this.#s[k], 'carregado do servidor');
                for (const k of Object.keys(p)) this.#emit(k, this.#s[k]); this.#emit('*', this.#s); }

  /** Subscribe. Returns unsubscribe function. */
  on(k, fn) {
    if (!this.#m.has(k)) this.#m.set(k, new Set());
    this.#m.get(k).add(fn);
    return () => this.#m.get(k)?.delete(fn);
  }
  #emit(k, v) { this.#m.get(k)?.forEach(fn => fn(v)); }
}

export const configStore = new Store({
  defaultProvider: 'ollama',
  language: 'pt-BR',
  maxIterations: 5,
  memoryWindowSize: 20,
  systemPrompt: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'glm-5.2:cloud',
  ollamaApiKey: '',
  telegramAllowedUserIds: '',
  modelRouter: {
    chat: '', code: '', vision: '', light: '', analysis: '', execution: '',
    classifierModel: '', classifierServer: '', visionServer: '',
    provider_chat: '', provider_code: '', provider_vision: '',
    provider_light: '', provider_analysis: '', provider_execution: '',
    plannerModel: '', riskModel: '', observerModel: '',
  },
  hasGeminiKey: false, hasDeepseekKey: false, hasGroqKey: false, hasOpenrouterKey: false, hasAnthropicKey: false, hasOllamaApiKey: false,
  currentModel: '—',
  geminiKey: '', deepseekKey: '', groqKey: '', openrouterKey: '', anthropicKey: '',
  customProviders: [],
  // Vazio por padrão — nunca um caminho de exemplo: um default embutido só valeria na máquina de
  // quem o escreveu, e o projeto roda em Windows, Linux e macOS.
  localModelsDir: '',
  // { "modelo.gguf": "-fit off --n-gpu-layers 12" } — opções de carregamento por modelo local
  localModelOptions: {},
}, /* auditado */ true);

export const runtimeStore = new Store({
  status: 'unknown',
  uptime: '—',
  ram: '—',
  platform: null,
  hostname: null,
  version: null,   // versão do NewClaw, lida do package.json pelo servidor
  arch: null,
});

export const providersStore = new Store({
  models: [],
  ollamaOnline: false,
  ollamaModelCount: 0,
  catalog: [],      // ModelInfo[] — catálogo normalizado (Model Registry)
  health: [],       // ProviderHealth[] — status por provider configurado
  lastSync: null,   // timestamp (ms) da última sincronização bem-sucedida
  lastKnownLocalModel: null, // {file, port} do último modelo local carregado — no ar ou não
});

export const toolsStore = new Store({
  tools: [],
  stats: {},  // aggregated per tool_name from patterns
});

export const skillsStore = new Store({
  skills: [],
  patterns: [],
  activeCount: 0,
  proposedCount: 0,
});
