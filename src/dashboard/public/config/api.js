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

// ── Model Registry ──────────────────────────────────────────────────────────

export async function getModelCatalog(refresh = false) {
  const d = await json(f(`/api/models/catalog${refresh ? '?refresh=true' : ''}`));
  return d;
}

export async function addCustomProvider({ label, baseUrl, apiKey }) {
  return json(f('/api/providers/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, baseUrl, apiKey }),
  }));
}

export async function removeCustomProvider(label) {
  return json(f(`/api/providers/custom/${encodeURIComponent(label)}`, { method: 'DELETE' }));
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
  return json(f(`/api/skills/auto/${id}/${action}`, { method: 'POST' }));
}

export async function activateSkill(id) {
  return json(f(`/api/skills/auto/${id}/activate`, { method: 'POST' }));
}

export async function deactivateSkill(id) {
  return json(f(`/api/skills/auto/${id}/deactivate`, { method: 'POST' }));
}

export async function deleteAutoSkill(id) {
  return json(f(`/api/skills/auto/${id}`, { method: 'DELETE' }));
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export async function checkUpdate({ channel, branch } = {}) {
  const qs = new URLSearchParams();
  if (channel) qs.set('channel', channel);
  if (branch) qs.set('branch', branch);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const d = await json(f(`/api/maintenance/update/check${suffix}`));
  return d;
}

export async function applyUpdate({ channel, branch } = {}) {
  return json(f('/api/maintenance/update/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, branch }),
  }));
}

export async function getUpdateBranches() {
  const d = await json(f('/api/maintenance/update/branches'));
  return d.branches || [];
}

export async function getBackupSchedule() {
  try {
    return await json(f('/api/maintenance/backup/schedule'));
  } catch { return { found: false }; }
}

export async function listBackups() {
  const d = await json(f('/api/maintenance/backup/list'));
  return d.backups;
}

export async function createSystemBackup() {
  const d = await json(f('/api/maintenance/backup/system', { method: 'POST' }));
  return d.backup;
}

export async function createDatabaseBackup() {
  const d = await json(f('/api/maintenance/backup/database', { method: 'POST' }));
  return d.backup;
}

export function backupDownloadUrl(filename) {
  // Include the auth token in the URL so the browser's native <a download> request
  // is authenticated without relying on the SameSite:strict cookie, which is not
  // sent in all download contexts (e.g. retrying from the download bar).
  const token = window.newclawGetToken?.();
  const base = `/api/maintenance/backup/${encodeURIComponent(filename)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export async function getBackupConfig() {
  const d = await json(f('/api/maintenance/backup/config'));
  return d.config;
}

export async function saveBackupConfig(config) {
  const d = await json(f('/api/maintenance/backup/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }));
  return d.config;
}

export async function restoreBackup(filename) {
  return json(f('/api/maintenance/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  }));
}

export async function uploadBackup(file) {
  return json(f('/api/maintenance/backup/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
    },
    body: file,
  }));
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function getAuthStatus() {
  try {
    const d = await json(f('/api/auth/status'));
    return d.auth;
  } catch { return { enabled: false, hasPassword: false }; }
}

export async function changePassword(newPassword, enable) {
  return json(f('/api/auth/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: newPassword, enabled: enable }),
  }));
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
