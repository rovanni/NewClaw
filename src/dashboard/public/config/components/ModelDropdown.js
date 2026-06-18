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

function _renderDropdown(inputId, input, dropdown, onPull) {
  const val    = input.value.trim();
  const filter = val.toLowerCase();
  const clouds = _models.filter(m => m.includes('cloud') || m.includes('groq') || m.includes('gemini'));
  const locals = _models.filter(m => !clouds.includes(m));
  const f      = list => filter ? list.filter(m => m.toLowerCase().includes(filter)) : list;
  const fc     = f(clouds);
  const fl     = f(locals);

  let html = '';

  if (val && !_models.includes(val)) {
    html += `<div class="mia" onclick="window.__ddAddSelect('${inputId}','${val}')">
               <span class="mn">✨ Usar "${val}"</span>
               <span class="badge" style="background:#5c6bc0;color:#fff">custom</span>
             </div>`;
  }
  if (fc.length) {
    html += `<div class="mdg">Cloud Models</div>`;
    fc.forEach(m => { html += `<div class="mi" onclick="window.__ddSelect('${inputId}','${m}')"><span class="mn">${m}</span><span class="badge badge-cloud">cloud</span></div>`; });
  }
  if (fl.length) {
    html += `<div class="mdg">Local Models</div>`;
    fl.forEach(m => { html += `<div class="mi" onclick="window.__ddSelect('${inputId}','${m}')"><span class="mn">${m}</span><span class="badge badge-local">local</span></div>`; });
  }
  if (filter && !fc.length && !fl.length && !_models.includes(val)) {
    html += `<div class="mip" onclick="window.__ddPull('${inputId}','${val}')">⬇️ Baixar "${val}"...</div>`;
  }
  dropdown.innerHTML = html || `<div style="padding:10px;font-size:.79rem;color:var(--text-soft);text-align:center">Nenhum modelo disponível</div>`;
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
