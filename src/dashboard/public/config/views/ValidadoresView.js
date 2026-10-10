import { getValidatorReports } from '../api.js';
import { guideBox } from '../app.js';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(newclawGetLang(), { dateStyle: 'short', timeStyle: 'short' });
}

/** Nome do juiz em linguagem de gente; tipo desconhecido (ou juiz antigo) aparece como está gravado. */
function nomeDoJuiz(tipo) {
  const chave = `validator_name_${String(tipo).replace(/^validacao_/, '')}`;
  const v = t(chave);
  return v && v !== chave ? v : tipo;
}

/**
 * Tela "Validadores" (ADR-016, adendo 3): o que cada juiz relatou de si mesmo — o que lhe FALTOU e o que DIFICULTOU a decisão —
 * por extenso, agrupado pelo que é fato (qual juiz, qual campo, quando). Agrupar por TEMA é interpretar o texto, e isso é do
 * modelo, não de uma regra escrita aqui: por isso o filtro é só de texto.
 */
export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>⚖️ ${t('sidebar_validators')}</h1>
        <p>${t('validators_page_desc')}</p>
      </div>
      ${guideBox(t('validators_guide'))}
      <div id="vl-body"><div class="form-hint">${t('validators_loading')}</div></div>
    </div>`;

  let dados = null;
  let filtro = '';

  const body = container.querySelector('#vl-body');

  function desenhar() {
    if (!dados) return;
    if (!dados.disponivel) { body.innerHTML = `<div class="form-hint">${t('validators_unavailable')}</div>`; return; }

    const linhasResumo = dados.porJuiz.map(j => {
      const com = Math.max(j.comFaltou, j.comDificuldade);
      const pct = j.avaliacoes ? Math.round((com / j.avaliacoes) * 100) : 0;
      return `<tr><td>${esc(nomeDoJuiz(j.avaliador))}</td><td>${j.avaliacoes}</td><td>${j.comFaltou} / ${j.comDificuldade}</td><td>${pct}%</td></tr>`;
    }).join('');
    const semTexto = dados.porJuiz.reduce((a, j) => a + j.semTexto, 0);

    const q = filtro.trim().toLowerCase();
    const visiveis = dados.relatos.filter(r => !q || `${r.faltou ?? ''} ${r.dificuldade ?? ''}`.toLowerCase().includes(q));
    const porJuiz = new Map();
    for (const r of visiveis) (porJuiz.get(r.avaliador) || porJuiz.set(r.avaliador, []).get(r.avaliador)).push(r);

    const blocos = [...porJuiz.entries()].map(([avaliador, lista]) => `
      <details class="cfg-details" open>
        <summary>${esc(nomeDoJuiz(avaliador))} (${lista.length})</summary>
        <div class="cfg-details-body">
          ${lista.map(r => `
            <div class="vl-relato" style="border-bottom:1px solid var(--border);padding:10px 0;">
              <div class="form-hint" style="margin-bottom:6px;">${esc(fmtDate(r.ts))} · ${esc(r.modelo)} · ${esc(r.desfecho)}${r.estado ? ` / ${esc(r.estado)}` : ''}</div>
              ${r.faltou ? `<div><strong>${t('validators_missing')}:</strong> ${esc(r.faltou)}</div>` : ''}
              ${r.dificuldade ? `<div style="margin-top:4px;"><strong>${t('validators_difficulty')}:</strong> ${esc(r.dificuldade)}</div>` : ''}
            </div>`).join('')}
        </div>
      </details>`).join('');

    body.innerHTML = `
      <details class="cfg-details" open>
        <summary>${t('validators_summary_title')}</summary>
        <div class="cfg-details-body">
          <div class="model-table-wrap"><table class="model-table">
            <thead><tr><th>${t('validators_col_judge')}</th><th>${t('validators_col_total')}</th><th>${t('validators_missing')} / ${t('validators_difficulty')}</th><th>${t('validators_col_pct')} ${t('validators_col_reports')}</th></tr></thead>
            <tbody>${linhasResumo || `<tr><td colspan="4" class="empty">${t('validators_none')}</td></tr>`}</tbody>
          </table></div>
          ${semTexto ? `<div class="form-hint" style="margin-top:8px;">${t('validators_no_text', { n: String(semTexto) })}</div>` : ''}
        </div>
      </details>
      <h3 style="margin:18px 0 8px;">${t('validators_reports_title')}</h3>
      <input type="text" class="form-input" id="vl-filtro" placeholder="${esc(t('validators_search'))}" value="${esc(filtro)}" style="max-width:420px;margin-bottom:10px;">
      ${blocos || `<div class="form-hint">${t('validators_none')}</div>`}`;

    const campo = body.querySelector('#vl-filtro');
    campo.addEventListener('input', e => {
      filtro = e.target.value;
      desenhar();
      const novo = body.querySelector('#vl-filtro');
      novo.focus();
      novo.setSelectionRange(filtro.length, filtro.length);
    });
  }

  getValidatorReports().then(d => { dados = d; desenhar(); })
    .catch(e => { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}
