/**
 * ModelDropdown — reusable autocomplete dropdown for Ollama models.
 * Works on any input+dropdown pair already in the DOM.
 *
 * Usage:
 *   import { initDropdowns, updateDropdownModels } from '../components/ModelDropdown.js';
 *   initDropdowns(['inputId1', 'inputId2'], modelsList, onSelect);
 */

let _models = [];

export function updateDropdownModels(models) {
  _models = models || [];
}

/**
 * Attach dropdown behaviour to a list of input IDs.
 * @param {string[]} ids    - Array of input element IDs
 * @param {Function} onPull - Called with model name when user chooses to pull
 */
export function initDropdowns(ids, onPull) {
  for (const id of ids) {
    const input     = document.getElementById(id);
    const dropdown  = document.getElementById(`dropdown-${id}`);
    const container = document.getElementById(`container-${id}`);
    if (!input || !dropdown) continue;

    const show = () => {
      _renderDropdown(id, input, dropdown, onPull);
      dropdown.classList.remove('drop-up');
      dropdown.classList.add('show');
      // Flip upward if dropdown would overflow the viewport bottom
      const rect = dropdown.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 8) dropdown.classList.add('drop-up');
    };

    input.addEventListener('focus', show);
    input.addEventListener('click', show);
    input.addEventListener('input', show);
    document.addEventListener('click', e => {
      if (container && !container.contains(e.target)) {
        dropdown.classList.remove('show');
        dropdown.classList.remove('drop-up');
      }
    });
  }
}

/**
 * Constrói o dropdown via DOM (createElement/textContent), não innerHTML de string.
 *
 * CodeQL js/xss-through-dom: a versão anterior interpolava `val` (texto digitado pelo usuário)
 * e `m` (nome de modelo) direto numa string HTML, inclusive dentro de `onclick="fn('${val}')"` —
 * uma aspa simples ou dupla em `val` quebrava o atributo/a string JS embutida (self-XSS: usuário
 * digita `x'); alert(1); //` na busca de modelo). Escapar corretamente exigiria dois níveis
 * (HTML do atributo + string JS dentro do onclick) — frágil e fácil de errar de novo. Construir
 * via textContent/addEventListener elimina a classe inteira: nada vira string HTML, então não há
 * fronteira de atributo/JS-inline pra escapar nem pra quebrar.
 */
function _renderDropdown(inputId, input, dropdown, onPull) {
  const val    = input.value.trim();
  const filter = val.toLowerCase();
  const clouds = _models.filter(m => m.includes('cloud') || m.includes('groq') || m.includes('gemini'));
  const locals = _models.filter(m => !clouds.includes(m));
  const f      = list => filter ? list.filter(m => m.toLowerCase().includes(filter)) : list;
  const fc     = f(clouds);
  const fl     = f(locals);

  dropdown.innerHTML = '';

  const addRow = (className, onClick, build) => {
    const row = document.createElement('div');
    row.className = className;
    row.addEventListener('click', onClick);
    build(row);
    dropdown.appendChild(row);
  };
  const addSpan = (row, className, text) => {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    row.appendChild(span);
  };
  const addGroupLabel = (text) => {
    const label = document.createElement('div');
    label.className = 'mdg';
    label.textContent = text;
    dropdown.appendChild(label);
  };

  let hasAny = false;

  if (val && !_models.includes(val)) {
    hasAny = true;
    addRow('mia', () => window.__ddAddSelect(inputId, val), (row) => {
      addSpan(row, 'mn', `✨ Usar "${val}"`);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.background = '#5c6bc0';
      badge.style.color = '#fff';
      badge.textContent = 'custom';
      row.appendChild(badge);
    });
  }
  if (fc.length) {
    hasAny = true;
    addGroupLabel('Cloud Models');
    fc.forEach(m => addRow('mi', () => window.__ddSelect(inputId, m), (row) => {
      addSpan(row, 'mn', m);
      addSpan(row, 'badge badge-cloud', 'cloud');
    }));
  }
  if (fl.length) {
    hasAny = true;
    addGroupLabel('Local Models');
    fl.forEach(m => addRow('mi', () => window.__ddSelect(inputId, m), (row) => {
      addSpan(row, 'mn', m);
      addSpan(row, 'badge badge-local', 'local');
    }));
  }
  if (filter && !fc.length && !fl.length && !_models.includes(val)) {
    hasAny = true;
    addRow('mip', () => window.__ddPull(inputId, val), (row) => {
      row.textContent = `⬇️ Baixar "${val}"...`;
    });
  }

  if (!hasAny) {
    const empty = document.createElement('div');
    Object.assign(empty.style, { padding: '10px', fontSize: '.79rem', color: 'var(--text-soft)', textAlign: 'center' });
    empty.textContent = 'Nenhum modelo disponível';
    dropdown.appendChild(empty);
  }
}

/** Install global helpers used by dropdown onclick handlers. */
export function installGlobalHelpers(onPull, onAdd, onSelect) {
  window.__ddSelect = (id, model) => {
    const el = document.getElementById(id);
    if (el) el.value = model;
    document.getElementById(`dropdown-${id}`)?.classList.remove('show');
    onSelect?.(id, model);
  };

  window.__ddAddSelect = async (id, model) => {
    const el = document.getElementById(id);
    if (el) el.value = model;
    document.getElementById(`dropdown-${id}`)?.classList.remove('show');
    onAdd?.(id, model);
    onSelect?.(id, model);
  };

  window.__ddPull = (id, model) => {
    const el = document.getElementById(id);
    if (el) el.value = model;
    document.getElementById(`dropdown-${id}`)?.classList.remove('show');
    onPull?.(model);
    onSelect?.(id, model);
  };
}
