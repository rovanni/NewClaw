/**
 * API service layer — all network calls in one place.
 * Uses window.newclawFetch (auth-aware wrapper from shared.js) when available.
 */
const f = (...a) => (window.newclawFetch || fetch)(...a);

async function json(promise) {
  const res = await promise;
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'API error');
  return data;
}

// ── Config ──────────────────────────────────────────────────────────────────

export async function getConfig() {
  const d = await json(f('/api/config'));
  return d.config;
}

export async function saveConfig(config) {
  return json(f('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }));
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export async function getStatus() {
  const d = await json(f('/api/status'));
  return d.status;
}

export async function restartAgent() {
  return f('/api/restart', { method: 'POST' });
}

// ── Providers ────────────────────────────────────────────────────────────────

export async function getProviders() {
  const d = await json(f('/api/providers'));
  return d.providers;
}

export async function pullModel(name) {
  return json(f('/api/ollama/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name }),
  }));
}

export async function modelExists(name) {
  try {
    const d = await json(f(`/api/ollama/exists/${encodeURIComponent(name)}`));
    return d.exists;
  } catch { return false; }
}

export async function addModel(name) {
  return f('/api/models/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name }),
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export async function getTools() {
  const d = await json(f('/api/tools/status'));
  return d.tools;
}

export async function toggleTool(name, enable) {
  return f(`/api/tools/${name}/${enable ? 'enable' : 'disable'}`, { method: 'POST' });
}

// ── Skills ────────────────────────────────────────────────────────────────────

export async function getSkills() {
  try {
    const d = await json(f('/api/skills/auto'));
    return d.skills;
  } catch { return []; }
}

export async function getPatterns() {
  try {
    const d = await json(f('/api/skills/patterns'));
    return d.patterns;
  } catch { return []; }
}

export async function reviewSkill(id, action) {
  return json(fetch(`/api/skills/auto/${id}/${action}`, { method: 'POST' }));
}

// ── Utils ─────────────────────────────────────────────────────────────────────

/** Aggregate per-tool stats from the patterns list. */
export function aggregateToolStats(patterns = []) {
  const stats = {};
  for (const p of patterns) {
    const t = p.tool_name;
    if (!t) continue;
    if (!stats[t]) stats[t] = { calls: 0, success: 0, latSum: 0 };
    const c = (p.success_count || 0) + (p.fail_count || 0);
    stats[t].calls   += c;
    stats[t].success += (p.success_count || 0);
    stats[t].latSum  += (p.avg_latency_ms || 0) * c;
  }
  for (const s of Object.values(stats)) {
    s.successRate = s.calls > 0 ? Math.round(s.success / s.calls * 100) : 0;
    s.avgLat      = s.calls > 0 ? Math.round(s.latSum  / s.calls)       : 0;
  }
  return stats;
}
