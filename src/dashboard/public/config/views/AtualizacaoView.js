import { checkUpdate, applyUpdate } from '../api.js';
import { showToast } from '../components/Toast.js';

const TELEGRAM_WAIT = 30; // segundos fixos — limite do Telegram para liberar polling

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>⬆️ ${t('sidebar_update')}</h1>
        <p>${t('update_page_desc')}</p>
      </div>

      <details class="cfg-details" open>
        <summary>${t('update_version_title')}</summary>
        <div class="cfg-details-body">
          <div id="upd-status" style="margin-bottom:14px;font-size:.9rem;color:var(--text-soft)">
            ${t('update_checking')}
          </div>
          <div id="upd-changelog" style="display:none;margin-bottom:14px"></div>

          <!-- Progresso da atualização (oculto até iniciar) -->
          <div id="upd-progress-wrap" style="display:none;margin-bottom:16px">

            <!-- Fase 1: Telegram -->
            <div id="upd-phase1">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                <span style="font-size:.82rem;color:var(--text-soft)">
                  📱 Aguardando Telegram liberar conexão…
                </span>
                <span id="upd-countdown-num"
                      style="font-size:.9rem;font-weight:700;color:var(--warning);min-width:32px;text-align:right">
                  ${TELEGRAM_WAIT}s
                </span>
              </div>
              <div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden">
                <div id="upd-countdown-bar"
                     style="height:100%;background:var(--warning);border-radius:3px;width:100%;transition:width 1s linear">
                </div>
              </div>
            </div>

            <!-- Fase 2: terminal de logs (oculto até fase 1 terminar) -->
            <div id="upd-phase2" style="display:none;margin-top:12px">
              <div style="display:flex;align-items:center;gap:8px;font-size:.78rem;color:var(--text-soft);margin-bottom:6px">
                <span id="upd-pulse"
                      style="width:7px;height:7px;border-radius:50%;flex-shrink:0;
                             background:var(--accent);display:inline-block;animation:upd-blink 1s infinite">
                </span>
                <span id="upd-phase2-label">🔧 Compilando e reiniciando…</span>
              </div>
              <div id="upd-log-term"
                   style="background:var(--code-bg,#0d1117);border:1px solid var(--border);
                          border-radius:6px;padding:10px 12px;font-family:monospace;
                          font-size:.74rem;line-height:1.55;max-height:220px;overflow-y:auto;
                          color:#c9d1d9;white-space:pre-wrap;word-break:break-all">
              </div>
            </div>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-secondary" id="upd-checkBtn">${t('update_check_btn')}</button>
            <button class="btn btn-primary"   id="upd-applyBtn" style="display:none">${t('update_apply_btn')}</button>
          </div>
        </div>
      </details>
    </div>

    <style>
      @keyframes upd-blink {
        0%,100% { opacity:1; transform:scale(1); }
        50%      { opacity:.3; transform:scale(.7); }
      }
    </style>`;

  const statusEl      = document.getElementById('upd-status');
  const changelogEl   = document.getElementById('upd-changelog');
  const checkBtn      = document.getElementById('upd-checkBtn');
  const applyBtn      = document.getElementById('upd-applyBtn');
  const progressWrap  = document.getElementById('upd-progress-wrap');
  const phase1El      = document.getElementById('upd-phase1');
  const phase2El      = document.getElementById('upd-phase2');
  const countdownNum  = document.getElementById('upd-countdown-num');
  const countdownBar  = document.getElementById('upd-countdown-bar');

  // ── Verificar atualização ─────────────────────────────────────────────────
  async function runCheck() {
    checkBtn.disabled = true;
    statusEl.style.color = 'var(--text-soft)';
    statusEl.textContent = t('update_checking_progress');
    changelogEl.style.display = 'none';
    try {
      const r = await checkUpdate();
      if (r.hasUpdate) {
        const countLabel = r.commitCount !== 1 ? t('update_commits_label') : t('update_commit_label');
        statusEl.innerHTML =
          `<span style="color:var(--warning)">${t('update_available_label')} — ${r.commitCount} ${countLabel}</span><br>` +
          `<span style="font-size:.8rem;color:var(--text-soft)">` +
          `Local: <code>${r.localSha}</code> → Remoto: <code>${r.remoteSha}</code></span>`;
        applyBtn.style.display = 'inline-flex';
        renderChangelog(r.commits || []);
      } else {
        statusEl.innerHTML =
          `<span style="color:var(--success)">${t('update_uptodate')}</span>` +
          ` — ${t('update_version_label')} <code>${r.localSha}</code>`;
        applyBtn.style.display = 'none';
        changelogEl.style.display = 'none';
      }
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">${t('update_error_prefix')} ${esc(e.message)}</span>`;
    } finally {
      checkBtn.disabled = false;
    }
  }

  function renderChangelog(commits) {
    if (!commits.length) return;
    changelogEl.innerHTML = `
      <div style="font-size:.8rem;color:var(--text-soft);margin-bottom:6px">${t('update_changelog_label')}</div>
      <div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;max-height:220px;overflow-y:auto">
        ${commits.map((c, i) => `
          <div style="display:flex;align-items:baseline;gap:8px;padding:6px 10px;
                      ${i < commits.length - 1 ? 'border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.06))' : ''}">
            <code style="font-size:.75rem;color:var(--accent);flex-shrink:0">${esc(c.sha)}</code>
            <span style="font-size:.82rem;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.msg)}</span>
            <span style="font-size:.75rem;color:var(--text-soft);flex-shrink:0">${esc(c.when)}</span>
          </div>`).join('')}
      </div>`;
    changelogEl.style.display = 'block';
  }

  checkBtn.addEventListener('click', runCheck);

  // ── Fluxo de atualização em duas fases ───────────────────────────────────
  applyBtn.addEventListener('click', async () => {
    if (!confirm(t('update_confirm'))) return;

    applyBtn.disabled = true;
    checkBtn.disabled = true;
    changelogEl.style.display = 'none';
    statusEl.innerHTML = `<span style="color:var(--warning)">${t('update_in_progress')}</span>`;

    try {
      await applyUpdate();
      showToast(t('update_started_toast'), 'success');
      progressWrap.style.display = 'block';

      // ── Fase 1: 30s fixos (Telegram precisa deste tempo para liberar) ─────
      runPhase1(TELEGRAM_WAIT, () => {

        // ── Fase 2: terminal SSE + poll de fallback ──────────────────────────
        phase1El.style.display = 'none';
        phase2El.style.display = 'block';

        const logTerm    = document.getElementById('upd-log-term');
        const phase2Lbl  = document.getElementById('upd-phase2-label');

        function appendLog(line, color) {
          const el = document.createElement('div');
          if (color) el.style.color = color;
          el.textContent = line;
          logTerm.appendChild(el);
          logTerm.scrollTop = logTerm.scrollHeight;
        }

        function startPoll() {
          phase2Lbl.textContent = '🔄 Aguardando servidor reiniciar…';
          let tries = 0;
          const poll = async () => {
            try { const r = await fetch('/api/status'); if (r.ok) { location.reload(); return; } } catch {}
            if (++tries < 60) setTimeout(poll, 3000);
            else {
              progressWrap.style.display = 'none';
              statusEl.innerHTML = `<span style="color:var(--danger)">${t('update_timeout_warn')}</span>`;
            }
          };
          poll();
        }

        let hasReceived = false;
        const es = new EventSource('/api/maintenance/update/stream');

        es.onmessage = (e) => {
          hasReceived = true;
          try {
            const { line } = JSON.parse(e.data);
            const color = /error|❌|fail/i.test(line) ? '#f85149'
                        : /✅|success|concluíd|done/i.test(line) ? '#3fb950'
                        : /warn|⚠️/i.test(line) ? '#d29922' : '';
            appendLog(line, color);
          } catch {}
        };

        es.addEventListener('done', () => {
          es.close();
          appendLog('✅ Build concluído — aguardando PM2 reiniciar…', '#3fb950');
          startPoll();
        });

        es.onerror = () => {
          es.close();
          if (hasReceived) {
            appendLog('🔄 Servidor reiniciando…', '#d29922');
          }
          startPoll();
        };
      });

    } catch (e) {
      showToast('❌ ' + e.message, 'error');
      applyBtn.disabled = false;
      checkBtn.disabled = false;
      progressWrap.style.display = 'none';
    }
  });

  function runPhase1(seconds, onDone) {
    let remaining = seconds;
    countdownNum.textContent = remaining + 's';
    countdownBar.style.width = '100%';
    void countdownBar.offsetWidth; // força reflow para a transição CSS iniciar do 100%

    const tick = () => {
      remaining--;
      countdownNum.textContent = remaining + 's';
      countdownBar.style.width = (remaining / seconds * 100) + '%';
      if (remaining <= 0) { onDone(); return; }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  }

  runCheck();
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
