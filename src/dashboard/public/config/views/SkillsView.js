import { skillsStore, toolsStore } from '../state.js';
import { reviewSkill, activateSkill, deactivateSkill, deleteAutoSkill, getSkills, getPatterns, aggregateToolStats } from '../api.js';
import { showToast } from '../components/Toast.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-view page-view--narrow">
      <div class="page-header">
        <h1>🎓 SkillLearner</h1>
        <p>${t('skills_page_desc')}</p>
      </div>

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
    </div>`;

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
