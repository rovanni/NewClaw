import { skillsStore, toolsStore } from '../state.js';
import { reviewSkill, activateSkill, deactivateSkill, deleteAutoSkill, getSkills, getPatterns, aggregateToolStats,
  getSkillPortability, markSkillWorkedHere, saveSkillFolders } from '../api.js';
import { showToast } from '../components/Toast.js';
import { guideBox } from '../app.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🎓 SkillLearner</h1>
        <p>${t('skills_page_desc')}</p>
      </div>

      ${guideBox(t('sk_page_guide'))}

      <div class="skills-metrics">
        <div class="skill-metric">
          <div class="skill-metric-val green" id="sk-active">—</div>
          <div class="skill-metric-lbl">${t('metric_active')}</div>
        </div>
        <div class="skill-metric">
          <div class="skill-metric-val warn" id="sk-proposed">—</div>
          <div class="skill-metric-lbl">${t('metric_awaiting_review')}</div>
        </div>
        <div class="skill-metric">
          <div class="skill-metric-val" id="sk-patterns">—</div>
          <div class="skill-metric-lbl">${t('metric_patterns_registered')}</div>
        </div>
      </div>

      <div class="two-col">
        <div>
          <div class="sec-title">${t('agent_skills_title')}</div>
          <div id="sk-skillsList"><div class="empty">${t('loading')}</div></div>
        </div>
        <div>
          <div class="sec-title">${t('detected_patterns_title')}</div>
          <div id="sk-patternsList"><div class="empty">${t('loading')}</div></div>
        </div>
      </div>

      <div class="sec-title" style="margin-top:18px">🌐 ${t('skport_title')}</div>
      <div class="form-hint" style="margin-bottom:8px">${t('skport_desc')}</div>
      <div id="sk-portList"><div class="empty">${t('loading')}</div></div>
      <div class="sec-title" style="margin-top:14px">📁 ${t('skport_folders_title')}</div>
      <div class="form-hint" style="margin-bottom:8px">${t('skport_folders_desc')}</div>
      <div id="sk-folders"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-secondary" id="sk-folderAdd">${t('skport_folder_add')}</button>
        <button class="btn btn-primary" id="sk-folderSave">${t('skport_folder_save')}</button>
      </div>
    </div>`;

  // ── ADR-035: portabilidade (fatos medidos; a decisão de usar a skill continua do agente) ──
  const escP = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let pastasAtuais = {};
  function renderFolders(extra) {
    const linhas = Object.entries(pastasAtuais);
    if (extra) linhas.push(['', '']);
    document.getElementById('sk-folders').innerHTML = linhas.length
      ? linhas.map(([n, c]) => `<div class="sk-folder-row" style="display:flex;gap:6px;margin:4px 0">
          <input class="form-input sk-folder-nome" style="max-width:160px" placeholder="aulas" value="${escP(n)}">
          <input class="form-input sk-folder-caminho" placeholder="${escP(t('skport_folder_path_ph'))}" value="${escP(c)}"></div>`).join('')
      : `<div class="empty">${t('skport_folders_none')}</div>`;
  }
  async function loadPortability() {
    const box = document.getElementById('sk-portList');
    try {
      const d = await getSkillPortability();
      pastasAtuais = d.pastas || {};
      renderFolders(false);
      const lista = d.skills || [];
      box.innerHTML = lista.length ? lista.map(s => `
        <div class="pattern-card" style="align-items:flex-start">
          <div style="flex:1">
            <div><b>${escP(s.nome)}</b>${s.sistemaOrigem ? ` <span style="color:var(--text-soft)">· ${t('skport_origin')}: ${escP(s.sistemaOrigem)}</span>` : ''}</div>
            <div style="font-size:.78rem;color:var(--text-soft)">${s.validadaEm.length ? `${t('skport_validated')}: ${s.validadaEm.map(v => escP(v.sistema + '@' + v.resumo)).join(', ')}` : t('skport_unknown')}</div>
            ${s.avisos.length ? `<div style="font-size:.78rem;color:var(--warning,#f59e0b)">⚠️ ${s.avisos.map(escP).join(' · ')}</div>` : ''}
          </div>
          ${s.pasta ? (s.validadaAqui
            ? `<span style="font-size:.78rem;color:var(--success)">✓ ${t('skport_validated_here')}</span>`
            : `<button class="s-btn approve" data-funcionou="${escP(s.pasta)}">${t('skport_worked_here')}</button>`) : ''}
        </div>`).join('') : `<div class="empty">${t('skport_none')}</div>`;
      box.querySelectorAll('[data-funcionou]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        try { await markSkillWorkedHere(b.dataset.funcionou); showToast(t('skport_worked_toast'), 'success'); loadPortability(); }
        catch (e) { showToast('❌ ' + e.message, 'error'); b.disabled = false; }
      }));
    } catch (e) { box.innerHTML = `<div class="empty">❌ ${escP(e.message)}</div>`; }
  }
  document.getElementById('sk-folderAdd').addEventListener('click', () => {
    pastasAtuais = Object.fromEntries([...document.querySelectorAll('.sk-folder-row')].map(r => [r.querySelector('.sk-folder-nome').value.trim(), r.querySelector('.sk-folder-caminho').value.trim()]).filter(([n]) => n));
    renderFolders(true);
  });
  document.getElementById('sk-folderSave').addEventListener('click', async () => {
    const tabela = Object.fromEntries([...document.querySelectorAll('.sk-folder-row')].map(r => [r.querySelector('.sk-folder-nome').value.trim(), r.querySelector('.sk-folder-caminho').value.trim()]).filter(([n, c]) => n && c));
    try { await saveSkillFolders(tabela); showToast(t('skport_folders_saved'), 'success'); loadPortability(); }
    catch (e) { showToast('❌ ' + e.message, 'error'); }
  });
  loadPortability();

  function update(s) {
    const el = id => document.getElementById(id);
    if (el('sk-active'))   el('sk-active').textContent   = s.activeCount   ?? '—';
    if (el('sk-proposed')) el('sk-proposed').textContent = s.proposedCount ?? '—';
    if (el('sk-patterns')) el('sk-patterns').textContent = (s.patterns||[]).length;

    // Skills list
    const skills = s.skills || [];
    const sl = el('sk-skillsList');
    if (sl) {
      sl.innerHTML = skills.length
        ? skills.map(sk => {
            const pct     = Math.min(100, (sk.hits || 0) * 10);
            const fillCls = pct >= 70 ? 'high' : pct >= 40 ? 'med' : '';
            const cardCls = sk.status === 'active' ? 'active-card' : sk.status === 'rejected' ? 'rejected-card' : 'proposed-card';

            let actions = '';
            if (sk.status === 'proposed') {
              actions = `<div class="skill-actions">
                <button class="s-btn approve" data-id="${sk.id}" data-action="approve">${t('approve_btn')}</button>
                <button class="s-btn reject"  data-id="${sk.id}" data-action="reject">${t('reject_btn')}</button>
                <button class="s-btn delete"  data-id="${sk.id}" data-action="delete">${t('delete')}</button>
              </div>`;
            } else if (sk.status === 'active') {
              actions = `<div class="skill-actions">
                <button class="s-btn deactivate" data-id="${sk.id}" data-action="deactivate">${t('deactivate_btn')}</button>
                <button class="s-btn delete"     data-id="${sk.id}" data-action="delete">${t('delete')}</button>
              </div>`;
            } else {
              actions = `<div class="skill-actions">
                <button class="s-btn approve" data-id="${sk.id}" data-action="activate">${t('reactivate_btn')}</button>
                <button class="s-btn delete"  data-id="${sk.id}" data-action="delete">${t('delete')}</button>
              </div>`;
            }

            return `
              <div class="skill-card ${cardCls}">
                <div class="skill-card-header">
                  <div class="skill-card-name">${sk.name}</div>
                  <div class="skill-hits">${sk.hits || 0} hits</div>
                  ${statusBadge(sk.status)}
                </div>
                <div class="skill-desc">${sk.description || ''}</div>
                <div class="skill-meta">${t('priority_label')} ${sk.priority} · ${safeJsonList(sk.tool_sequence)}</div>
                <div class="skill-confidence">
                  <div class="skill-confidence-fill ${fillCls}" style="width:${pct}%"></div>
                </div>
                ${actions}
              </div>`;
          }).join('')
        : `<div class="empty">${t('no_skills_yet')}</div>`;

      sl.onclick = async e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const { id, action } = btn.dataset;

        const confirmDelete = action === 'delete'
          && !confirm(t('delete_skill_confirm'));
        if (confirmDelete) return;

        try {
          if (action === 'approve' || action === 'reject') {
            await reviewSkill(id, action);
            showToast(action === 'approve' ? t('skill_approved_toast') : t('skill_rejected_toast'), 'success');
          } else if (action === 'activate') {
            await activateSkill(id);
            showToast(t('skill_reactivated_toast'), 'success');
          } else if (action === 'deactivate') {
            await deactivateSkill(id);
            showToast(t('skill_deactivated_toast'), 'success');
          } else if (action === 'delete') {
            await deleteAutoSkill(id);
            showToast(t('skill_deleted_toast'), 'success');
          }

          const [newSkills, patterns] = await Promise.all([getSkills(), getPatterns()]);
          const stats = aggregateToolStats(patterns);
          skillsStore.patch({
            skills: newSkills,
            patterns,
            activeCount:   newSkills.filter(s => s.status === 'active').length,
            proposedCount: newSkills.filter(s => s.status === 'proposed').length,
          });
          toolsStore.set('stats', stats);
        } catch (err) {
          showToast('❌ ' + err.message, 'error');
        }
      };
    }

    // Patterns list
    const patterns = s.patterns || [];
    const pl = el('sk-patternsList');
    if (pl) {
      pl.innerHTML = patterns.length
        ? patterns.slice(0, 12).map(p => {
            const total    = (p.success_count||0) + (p.fail_count||0);
            const rate     = total > 0 ? Math.round(p.success_count / total * 100) : 0;
            const dotColor = rate >= 80 ? 'var(--success)' : rate >= 50 ? 'var(--warning)' : 'var(--danger)';
            return `
              <div class="pattern-card">
                <div class="pc-dot" style="background:${dotColor}"></div>
                <div class="pc-pattern">${p.pattern}</div>
                <div class="pc-tool">${p.tool_name}</div>
                <div class="pc-stats">${total} · ${rate}% ✓ · ${p.avg_latency_ms}ms</div>
              </div>`;
          }).join('')
        : `<div class="empty">${t('no_patterns_detected')}</div>`;
    }
  }

  update(skillsStore.snap());
  const unsub = skillsStore.on('*', update);
  return () => unsub();
}

function statusBadge(s) {
  if (s === 'active')   return `<span class="badge badge-active">${t('badge_active')}</span>`;
  if (s === 'inactive') return `<span class="badge badge-rejected">${t('badge_inactive')}</span>`;
  if (s === 'rejected') return `<span class="badge badge-rejected">${t('badge_rejected') || 'REJEITADA'}</span>`;
  return `<span class="badge badge-proposed">${t('badge_proposed')}</span>`;
}

function safeJsonList(v) {
  try {
    const p = JSON.parse(v || '[]');
    return Array.isArray(p) && p.length ? p.join(', ') : '—';
  } catch { return '—'; }
}
