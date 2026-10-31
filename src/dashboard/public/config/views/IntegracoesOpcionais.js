// Integrações opcionais (ADR-030, Etapa 5): um cartão para cada integração do catálogo, montado pelo manifesto dela.
// Nada aqui sabe qual integração é. Todo texto que vem do manifesto ou dos comandos da integração passa por esc():
// ele vem de fora do NewClaw e não pode virar HTML.
import { showToast } from '../components/Toast.js';

const API = '/api/integrations/opcionais';
const pedir = (url, opcoes) => (window.newclawFetch || fetch)(url, opcoes);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function json(url, opcoes) {
  const r = await pedir(url, opcoes);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { motivo: d.motivo });
  return d;
}

const post = (url, corpo) => json(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo ?? {}),
});

export function renderOpcionais(alvo) {
  let parado = false;
  const timers = [];
  alvo.innerHTML = `<div class="provider-card wide" style="color: var(--text-soft);">⏳ ${t('opc_carregando')}</div>`;

  (async () => {
    try {
      const { integracoes } = await json(API);
      if (parado) return;
      alvo.innerHTML = '';
      for (const i of integracoes) {
        const card = document.createElement('div');
        card.className = 'provider-card wide';
        card.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
        alvo.appendChild(card);
        desenhar(card, i);
      }
    } catch (e) {
      alvo.innerHTML = `<div class="provider-card wide" style="color: var(--danger);">${esc(t('opc_erro'))} ${esc(e.message)}</div>`;
    }
  })();

  function cabecalho(i) {
    return `
      <div>
        <div style="font-size: 1.1rem; font-weight: 600; margin-bottom: 6px;">${esc(i.nome || i.id)}</div>
        <p style="font-size: 0.9rem; color: var(--text-soft); line-height: 1.4; margin: 0 0 6px;">${esc(i.descricao || '')}</p>
        <div style="font-size: 0.78rem; color: var(--text-soft);">
          ${t('opc_origem')} <a href="${esc(i.site)}" target="_blank" rel="noopener noreferrer">${esc(i.site)}</a> · ${t('opc_textos_da_integracao')}
        </div>
      </div>`;
  }

  function desenhar(card, i) {
    if (i.erro) {
      card.innerHTML = `<div style="color: var(--danger);">${esc(t('opc_erro'))} <strong>${esc(i.id)}</strong> — ${esc(i.erro)}</div>`;
      return;
    }
    if (i.instalada) return desenharInstalada(card, i);
    card.style.borderLeft = '';
    card.innerHTML = `${cabecalho(i)}
      <button class="btn btn-primary" style="align-self: flex-end;"><span class="ni">⚙️</span> ${t('opc_configurar')}</button>`;
    card.querySelector('button').addEventListener('click', () => configurar(card, i));
  }

  function desenharInstalada(card, i) {
    card.style.borderLeft = '3px solid var(--success)';
    const quando = i.instalada_em ? new Date(i.instalada_em).toLocaleString() : '';
    const atualizada = i.atualizada_em ? ` · ${t('opc_atualizada_em')} ${esc(new Date(i.atualizada_em).toLocaleString())}` : '';
    card.innerHTML = `${cabecalho(i)}
      <div style="font-size: 0.85rem;">
        ${i.ligada ? `🟢 ${t('opc_ligada')}` : `⚪ ${t('opc_desligada')}`} · ${t('opc_instalada_em')} ${esc(quando)}${atualizada} · <code>${esc(i.pasta)}</code>
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;">
        <a class="btn btn-primary" href="${esc(i.abrir)}" target="_blank" rel="noopener noreferrer"><span class="ni">↗</span> ${t('opc_abrir')}</a>
        <button class="btn" data-acao="atualizar" title="${esc(t('opc_atualizar_dica'))}"><span class="ni">⟳</span> ${t('opc_atualizar')}</button>
        <button class="btn" data-acao="${i.ligada ? 'desligar' : 'ligar'}">${i.ligada ? t('opc_desligar') : t('opc_ligar')}</button>
        <button class="btn btn-danger" data-acao="desinstalar"><span class="ni">🗑️</span> ${t('opc_desinstalar')}</button>
      </div>`;
    card.querySelectorAll('button[data-acao]').forEach((b) => b.addEventListener('click', async () => {
      const acao = b.dataset.acao;
      if (acao === 'atualizar') return atualizar(card, i, b);
      if (acao === 'desinstalar' && !confirm(t('opc_desinstalar_confirma').replace('{pasta}', i.pasta))) return;
      b.disabled = true;
      try {
        if (acao === 'desinstalar') await json(`${API}/${encodeURIComponent(i.id)}`, { method: 'DELETE' });
        else await post(`${API}/${encodeURIComponent(i.id)}/${acao}`);
        desenhar(card, await json(`${API}/${encodeURIComponent(i.id)}`));
      } catch (e) {
        showToast(`${t('ui_error_prefix')}: ${e.message}`, 'error');
        b.disabled = false;
      }
    }));
  }

  async function configurar(card, i) {
    card.innerHTML = `${cabecalho(i)}<div style="color: var(--text-soft);">⏳ ${t('opc_carregando')}</div>`;
    try {
      const detalhe = await json(`${API}/${encodeURIComponent(i.id)}`);
      const faltando = detalhe.requisitos.filter((r) => !r.ok);
      const requisitos = `
        <div><strong>${t('opc_requisitos')}</strong>
          <ul style="margin: 6px 0 0; padding-left: 18px; font-size: 0.9rem;">
            ${detalhe.requisitos.map((r) => `<li>${r.ok ? '✅' : '❌'} ${esc(r.nome)}${r.ok ? '' : ` — ${t('opc_falta')}: ${esc(r.como_instalar)}`}</li>`).join('')}
          </ul>
        </div>`;
      if (faltando.length) {
        card.innerHTML = `${cabecalho(i)}${requisitos}`;
        return;
      }
      const { opcoes } = await json(`${API}/${encodeURIComponent(i.id)}/opcoes`);
      card.innerHTML = `${cabecalho(i)}${requisitos}
        <div><strong>${t('opc_escolhas')}</strong><div class="opc-escolhas" style="display: grid; gap: 10px; margin-top: 8px;"></div></div>
        <div class="opc-licencas"></div>
        <div style="display: flex; justify-content: flex-end;">
          <button class="btn" data-ver-licencas disabled>${t('opc_ver_licencas')}</button>
        </div>`;
      const caixa = card.querySelector('.opc-escolhas');
      const escolhas = {};
      const visivel = (o) => !o.visivel_se || Object.entries(o.visivel_se).every(([k, v]) => escolhas[k] === v);
      const completas = () => opcoes.filter(visivel).every((o) => escolhas[o.id]);
      const verLicencas = card.querySelector('[data-ver-licencas]');
      const redesenhar = () => {
        caixa.innerHTML = '';
        for (const o of opcoes.filter(visivel)) {
          const linha = document.createElement('label');
          linha.style.cssText = 'display: grid; gap: 4px; font-size: 0.9rem;';
          linha.innerHTML = `<span>${esc(o.rotulo)}</span>
            <select class="input"><option value="">${t('opc_escolha_placeholder')}</option>
              ${o.opcoes.map((x) => `<option value="${esc(x.valor)}" ${escolhas[o.id] === x.valor ? 'selected' : ''}>${esc(x.rotulo)}${x.detalhe ? ` — ${esc(x.detalhe)}` : ''}</option>`).join('')}
            </select>
            ${o.nota ? `<small style="color: var(--text-soft);">${esc(o.nota)}</small>` : ''}`;
          linha.querySelector('select').addEventListener('change', (ev) => {
            escolhas[o.id] = ev.target.value || undefined;
            // Esconder uma escolha apaga o valor dela: só vai para a instalação o que está na tela.
            for (const x of opcoes) if (!visivel(x)) delete escolhas[x.id];
            card.querySelector('.opc-licencas').innerHTML = '';
            redesenhar();
          });
          caixa.appendChild(linha);
        }
        verLicencas.disabled = !completas();
      };
      redesenhar();
      verLicencas.addEventListener('click', () => mostrarLicencas(card, i, { ...escolhas }));
    } catch (e) {
      card.innerHTML = `${cabecalho(i)}<div style="color: var(--danger);">${esc(t('opc_erro'))} ${esc(e.message)}</div>`;
    }
  }

  async function mostrarLicencas(card, i, escolhas) {
    const area = card.querySelector('.opc-licencas');
    area.innerHTML = `<div style="color: var(--text-soft);">⏳ ${t('opc_carregando')}</div>`;
    try {
      const { itens } = await post(`${API}/${encodeURIComponent(i.id)}/licencas`, { escolhas });
      area.innerHTML = `
        <strong>${t('opc_licencas_titulo')}</strong>
        <p style="font-size: 0.85rem; color: var(--text-soft); margin: 4px 0 8px;">${t('opc_licencas_aviso')}</p>
        <ol style="font-size: 0.88rem; padding-left: 20px; margin: 0; display: grid; gap: 8px;">
          ${itens.map((x) => `<li>
            <strong>${esc(x.nome)}</strong> — ${esc(x.papel)}<br>
            ${esc(x.licenca)} · <a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.link)}</a>
            ${x.atencao ? `<div style="color: var(--warning, #c27c00); margin-top: 2px;">⚠️ ${t('opc_atencao')} ${esc(x.atencao)}</div>` : ''}
          </li>`).join('')}
        </ol>
        <label style="display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; font-size: 0.9rem;">
          <input type="checkbox" data-aceito> <span>${t('opc_aceito')}</span>
        </label>
        <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
          <button class="btn btn-primary" data-instalar disabled><span class="ni">⚡</span> ${t('opc_instalar')}</button>
        </div>`;
      const aceito = area.querySelector('[data-aceito]');
      const instalar = area.querySelector('[data-instalar]');
      aceito.addEventListener('change', () => { instalar.disabled = !aceito.checked; });
      instalar.addEventListener('click', () => comecar(card, i, escolhas, aceito.checked));
    } catch (e) {
      area.innerHTML = `<div style="color: var(--danger);">${esc(t('opc_erro'))} ${esc(e.message)}</div>`;
    }
  }

  function comecar(card, i, escolhas, aceito) {
    acompanhar(card, i, t('opc_instalando'), t('opc_concluida'),
      () => post(`${API}/${encodeURIComponent(i.id)}/instalar`, { escolhas, aceito }));
  }

  /** Mesmas escolhas e mesmo aceite; se as licenças ou as escolhas mudaram, a pessoa revê tudo (a configuração abre). */
  async function atualizar(card, i, botao) {
    if (!confirm(t('opc_atualizar_confirma'))) return;
    botao.disabled = true;
    try {
      const { andamento } = await post(`${API}/${encodeURIComponent(i.id)}/atualizar`);
      acompanhar(card, i, t('opc_atualizando'), t('opc_atualizacao_concluida'), async () => ({ andamento }));
    } catch (e) {
      if (e.motivo === 'revisar') {
        showToast(e.message, 'error');
        configurar(card, i);
      } else {
        showToast(`${t('ui_error_prefix')}: ${e.message}`, 'error');
        botao.disabled = false;
      }
    }
  }

  async function acompanhar(card, i, textoRodando, textoConcluida, iniciar) {
    card.innerHTML = `${cabecalho(i)}
      <div class="opc-estado">⏳ ${textoRodando}</div>
      <pre class="opc-linhas" style="max-height: 280px; overflow: auto; font-size: 0.78rem; background: var(--bg-soft, rgba(0,0,0,.2)); padding: 10px; border-radius: 6px; white-space: pre-wrap; margin: 0;"></pre>`;
    const estado = card.querySelector('.opc-estado');
    const linhas = card.querySelector('.opc-linhas');
    try {
      const { andamento } = await iniciar();
      const consultar = async () => {
        if (parado) return;
        try {
          const a = await json(`${API}/${encodeURIComponent(i.id)}/andamento/${encodeURIComponent(andamento)}`);
          linhas.textContent = a.linhas.slice(-60).join('\n');
          linhas.scrollTop = linhas.scrollHeight;
          if (a.estado === 'rodando') { timers.push(setTimeout(consultar, 1500)); return; }
          if (a.estado === 'concluida') {
            showToast(textoConcluida, 'success');
            desenhar(card, await json(`${API}/${encodeURIComponent(i.id)}`));
          } else {
            estado.innerHTML = `<span style="color: var(--danger);">❌ ${t('opc_falhou')}${a.erro ? ` ${esc(a.erro)}` : ''}</span>`;
          }
        } catch (e) {
          estado.innerHTML = `<span style="color: var(--danger);">${esc(t('opc_erro'))} ${esc(e.message)}</span>`;
        }
      };
      consultar();
    } catch (e) {
      estado.innerHTML = `<span style="color: var(--danger);">${esc(t('opc_erro'))} ${esc(e.message)}</span>`;
    }
  }

  return () => { parado = true; timers.forEach(clearTimeout); };
}
