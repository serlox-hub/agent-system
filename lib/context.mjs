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
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { gitLine } from './git.mjs';
import { readLocalOverride } from './local-config.mjs';

export const LANES_DIR = join(homedir(), '.claude', 'lanes');
export const EVENTS_FILE = join(LANES_DIR, 'events.jsonl');
export const EVENTS_PREV = `${EVENTS_FILE}.1`;
export const CONFIG_REL = join('.claude', 'agent-system.json');

/** Rotate at 2 MiB — roughly 10k events, which keeps `lanes status` startup instant. */
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
      let found;
      try {
        found = { configPath: candidate, root: dir, config: JSON.parse(readFileSync(candidate, 'utf8')) };
      } catch (err) {
        // A broken config must not take hooks down; degrade to "opted in, no settings".
        found = { configPath: candidate, root: dir, config: {}, configError: String(err && err.message) };
      }
      // The single merge point (D22): a gitignored per-machine override, shared
      // by every lane of this repo, wins over the committed default.
      const override = readLocalOverride(dir);
      if (override.worktreesDir) found.config = { ...found.config, worktreesDir: override.worktreesDir };
      if (override.basePort != null) found.config = { ...found.config, basePort: override.basePort };
      // Per-service portBase override, applied by name onto dev.services[] —
      // reuses the existing shape so lib/services.mjs needs no change at all,
      // it just reads a config that already has the override baked in.
      if (override.servicePortBase && found.config?.dev?.services?.length) {
        found.config = {
          ...found.config,
          dev: {
            ...found.config.dev,
            services: found.config.dev.services.map((svc) =>
              override.servicePortBase[svc.name] != null
                ? { ...svc, portBase: override.servicePortBase[svc.name] }
                : svc,
            ),
          },
        };
      }
      return found;
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
 * The `lane<N>` naming convention (D26) — the one identity rule the whole
 * lanes feature rests on, defined once and shared by every reader
 * (`resolveLane` below, `lib/worktrees.mjs`'s `laneNames`/`enumerateLanes`/
 * `planCreate`, `bin/lanes.mjs`'s `doctor`), the same reasoning D24 extracted
 * `boundPort` for: two independent copies of an identity rule are a drift bug
 * waiting to happen.
 */
export const LANE_NAME_RE = /^lane(\d+)$/;

/** The lane number encoded in a `lane<N>` directory name, or `null`. */
export function laneNumber(name) {
  const m = LANE_NAME_RE.exec(name || '');
  return m ? Number(m[1]) : null;
}

/**
 * Lane number for a worktree: parsed straight out of its directory name,
 * `lane<N>` (D26). No filesystem read, no sort — the number is baked into the
 * name at creation time, so it can never shift when a sibling lane is added or
 * removed. `config` is accepted for signature symmetry with the rest of the
 * context-resolution surface; nothing here depends on it.
 */
export function resolveLane(worktreeRoot, config) {
  const name = basename(worktreeRoot || '');
  return { lane: laneNumber(name), worktree: name };
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
    path: ctx.worktreeRoot,
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
