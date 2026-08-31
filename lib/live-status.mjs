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

// Strips control/ANSI bytes right here, at the trust boundary — `status`,
// `waitingFor`, `name` and `sessionId` all flow straight into
// ui/dashboard.mjs's render path (`status` as a STATES/NOTIFY lookup key,
// `waitingFor` into a padded cell, `name` into an extra row's BRANCH cell,
// `sessionId` into notification titles/keys), so every consumer is safe by
// construction instead of each one having to remember to sanitize a value
// that looks like plain internal state.
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
    // A `kind` other than "interactive" (e.g. a background/headless run) is
    // not a session a lane row should represent. A `kind` that is missing, or
    // present with some other type this module doesn't recognise, fails open
    // — same posture as every other field below (normalize, don't drop the
    // whole entry) — rather than hiding a live session over an unrecognised
    // field shape.
    if (typeof data.kind === 'string' && data.kind !== 'interactive') continue;
    // The file is named `<pid>.json` and `pid` is already proven live above,
    // so it is always available as a stable identity — used whenever the
    // file itself carries no usable `sessionId` (missing, wrong-typed, or
    // present but empty/control-bytes-only after stripping), so every entry
    // this function returns has one real, non-empty value to key on (Phase
    // 2's ordering tiebreak, Phase 3's extra-row label, Phase 5's per-session
    // notification dedup).
    const rawSessionId = typeof data.sessionId === 'string' ? stripControlBytes(data.sessionId) : '';
    const sessionId = rawSessionId || String(data.pid);
    // A name that strips down to '' (e.g. purely control/ANSI bytes) is just
    // as unusable as one that was never there — one falsy representation
    // (`null`), not two, for "no usable name".
    const name = typeof data.name === 'string' ? stripControlBytes(data.name) : '';
    out.push({
      cwd: data.cwd,
      status: stripControlBytes(data.status),
      waitingFor: typeof data.waitingFor === 'string' ? stripControlBytes(data.waitingFor) : null,
      statusUpdatedAt: Number.isFinite(data.statusUpdatedAt) ? data.statusUpdatedAt : null,
      sessionId,
      name: name || null,
      startedAt: Number.isFinite(data.startedAt) ? data.startedAt : null,
    });
  }
  return out;
}
