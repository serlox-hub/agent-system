/**
 * Shared context resolution for the agent-system lanes layer.
 *
 * Everything here runs inside hooks, so it must be:
 *   - fast (no network, no subprocess beyond a couple of cheap git calls)
 *   - defensive (a malformed config or a missing dir must never break a hook)
 *   - side-effect free apart from appending to the event log
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { gitLine } from './git.mjs';

export const LANES_DIR = join(homedir(), '.claude', 'lanes');
export const EVENTS_FILE = join(LANES_DIR, 'events.jsonl');
export const EVENTS_PREV = `${EVENTS_FILE}.1`;
export const CONFIG_REL = join('.claude', 'agent-system.json');

/** Rotate at 2 MiB — roughly 10k events, which keeps `lanes ui` startup instant. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Default branch->issue extraction: feat/123-slug -> "123" */
const DEFAULT_BRANCH_PATTERN = '^[a-z]+/(\\d+)-';

export function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * Walk up from `startDir` looking for `.claude/agent-system.json`.
 * Returns null when the directory is not part of an opted-in project —
 * that is the normal case for every repo that has not adopted the system,
 * and it must stay silent rather than warn.
 */
export function findProject(startDir) {
  let dir;
  try {
    dir = resolve(startDir || process.cwd());
  } catch {
    return null;
  }
  for (;;) {
    const candidate = join(dir, CONFIG_REL);
    if (existsSync(candidate)) {
      try {
        return { configPath: candidate, root: dir, config: JSON.parse(readFileSync(candidate, 'utf8')) };
      } catch (err) {
        // A broken config must not take hooks down; degrade to "opted in, no settings".
        return { configPath: candidate, root: dir, config: {}, configError: String(err && err.message) };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Internal: `resolveContext` is the public surface. */
function gitInfo(cwd) {
  const root = gitLine(cwd, ['rev-parse', '--show-toplevel']);
  const branch = gitLine(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { root: root || cwd, branch: branch || null };
}

/**
 * Lane number for a worktree: its 1-based alphabetical position among the
 * direct subdirectories of `worktreesDir`.
 *
 * Alphabetical, not `git worktree list` order, because the lane number is what
 * the dashboard colour and the dev-server port hang off — it has to stay stable.
 * Git lists worktrees in roughly creation order, so removing and re-adding one
 * renumbers the lanes after it, and a lane number that moves is worse than none.
 */
export function resolveLane(worktreeRoot, config) {
  const name = basename(worktreeRoot || '');
  const dir = expandHome(config?.worktreesDir);
  if (!dir || !existsSync(dir)) return { lane: null, worktree: name, lanes: [] };
  let lanes;
  try {
    lanes = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return { lane: null, worktree: name, lanes: [] };
  }
  const idx = lanes.indexOf(name);
  return { lane: idx === -1 ? null : idx + 1, worktree: name, lanes };
}

export function issueFromBranch(branch, config) {
  if (!branch) return null;
  const raw = config?.branch?.pattern || DEFAULT_BRANCH_PATTERN;
  let re;
  try {
    re = new RegExp(raw);
  } catch {
    re = new RegExp(DEFAULT_BRANCH_PATTERN);
  }
  const m = branch.match(re);
  if (!m) return null;
  // Use the first capture group that is all digits.
  for (let i = 1; i < m.length; i += 1) {
    if (m[i] && /^\d+$/.test(m[i])) return m[i];
  }
  return null;
}

/**
 * Full context for an event. Never throws.
 */
export function resolveContext(cwd) {
  const base = cwd || process.cwd();
  const project = findProject(base);
  const { root, branch } = gitInfo(base);
  const config = project?.config || null;
  const { lane, worktree } = resolveLane(root, config);
  return {
    project: config?.project || (project ? basename(project.root) : null),
    optedIn: Boolean(project),
    projectRoot: project?.root || null,
    configPath: project?.configPath || null,
    configError: project?.configError || null,
    config,
    cwd: base,
    worktreeRoot: root,
    worktree,
    lane,
    branch,
    issue: issueFromBranch(branch, config),
    port: lane && config?.basePort ? `${config.basePort}${lane}` : null,
  };
}

/**
 * Append one event. POSIX O_APPEND makes writes below PIPE_BUF (4096 bytes)
 * atomic, so concurrent sessions can share one file without locking. Events
 * are single-line JSON well under that; `detail` is truncated to keep it so.
 */
function rotateIfNeeded() {
  try {
    if (statSync(EVENTS_FILE).size < MAX_LOG_BYTES) return;
    // One generation is enough: the log is a live dashboard feed, not an audit
    // trail. `renameSync` is atomic, so if two sessions rotate at once one wins
    // and the other's call fails harmlessly.
    renameSync(EVENTS_FILE, EVENTS_PREV);
  } catch {
    /* no file yet, or a lost rotation race — both are fine */
  }
}

export function emit(event) {
  try {
    if (!existsSync(LANES_DIR)) mkdirSync(LANES_DIR, { recursive: true });
    rotateIfNeeded();
    const record = { ts: Date.now(), ...event };
    if (typeof record.detail === 'string' && record.detail.length > 300) {
      record.detail = `${record.detail.slice(0, 297)}...`;
    }
    const line = `${JSON.stringify(record)}\n`;
    if (line.length > 4000) return false; // refuse rather than risk an interleaved write
    appendFileSync(EVENTS_FILE, line);
    return true;
  } catch {
    // The event log is observability, never correctness. Failing to write it
    // must never break the user's session.
    return false;
  }
}

export function emitWithContext(ev, cwd, extra = {}) {
  const ctx = resolveContext(cwd);
  if (!ctx.optedIn) return false; // only opted-in projects produce events
  return emit({
    ev,
    project: ctx.project,
    lane: ctx.lane,
    worktree: ctx.worktree,
    branch: ctx.branch,
    issue: ctx.issue,
    ...extra,
  });
}

/** Read stdin fully as JSON. Returns {} on anything unexpected. */
export async function readHookInput() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
