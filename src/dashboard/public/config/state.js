/**
 * Reactive store — pub/sub via EventTarget pattern.
 * Each store holds a slice of app state. Views subscribe to keys
 * they care about and re-render when those keys change.
 */
class Store {
  #s; #m = new Map();
  constructor(init = {}) { this.#s = structuredClone(init); }

  get(k)      { return this.#s[k]; }
  snap()      { return structuredClone(this.#s); }

  set(k, v)   { this.#s[k] = v;               this.#emit(k, v); this.#emit('*', this.#s); }
  patch(p)    { Object.assign(this.#s, p);     this.#emit('*', this.#s); }

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
  ollamaModel: 'glm-5.1:cloud',
  ollamaApiKey: '',
  telegramAllowedUserIds: '',
  modelRouter: {
    chat: '', code: '', vision: '', light: '', analysis: '', execution: '',
    classifierModel: '', classifierServer: '', visionServer: '',
    provider_chat: '', provider_code: '', provider_vision: '',
    provider_light: '', provider_analysis: '', provider_execution: '',
    plannerModel: '', riskModel: '', observerModel: '',
  },
  hasGeminiKey: false, hasDeepseekKey: false, hasGroqKey: false, hasOpenrouterKey: false, hasOllamaApiKey: false,
  currentModel: '—',
  geminiKey: '', deepseekKey: '', groqKey: '', openrouterKey: '',
});

export const runtimeStore = new Store({
  status: 'unknown',
  uptime: '—',
  ram: '—',
});

export const providersStore = new Store({
  models: [],
  ollamaOnline: false,
  ollamaModelCount: 0,
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
