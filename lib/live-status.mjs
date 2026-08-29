/**
 * Reads Claude Code's own live per-session status files, so `lanes status`
 * can show whether a lane's session is actually busy/idle/waiting for input
 * right now, instead of relying solely on hook-emitted events — which can
 * miss an interrupted turn entirely (see issue #12).
 *
 * `~/.claude/sessions/<pid>.json` is undocumented internal Claude Code
 * state, not a public API — any unexpected shape here must degrade to
 * "no override", never throw.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

// Signal 0 sends nothing — it only probes whether the process could be
// signalled. ESRCH means the pid is gone; anything else (most commonly
// EPERM, a pid that exists but is owned by another user) means it is alive.
function isLivePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

// Strips control/ANSI bytes right here, at the trust boundary — `status` and
// `waitingFor` both flow straight into ui/dashboard.mjs's render path
// (`status` as a STATES/NOTIFY lookup key, `waitingFor` into a padded cell),
// so every consumer is safe by construction instead of each one having to
// remember to sanitize a value that looks like plain internal state.
function stripControlBytes(s) {
  return s.replace(/[\x00-\x1f\x7f]/g, '');
}

export function readLiveStatuses() {
  let files;
  try {
    files = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!data || typeof data.cwd !== 'string' || typeof data.status !== 'string') continue;
    if (!Number.isInteger(data.pid) || data.pid <= 0 || !isLivePid(data.pid)) continue;
    out.push({
      cwd: data.cwd,
      status: stripControlBytes(data.status),
      waitingFor: typeof data.waitingFor === 'string' ? stripControlBytes(data.waitingFor) : null,
      statusUpdatedAt: Number.isFinite(data.statusUpdatedAt) ? data.statusUpdatedAt : null,
    });
  }
  return out;
}
