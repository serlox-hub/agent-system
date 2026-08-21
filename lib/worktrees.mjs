/**
 * Lane lifecycle: enumerate, create, remove, and decide which lanes are free.
 *
 * A "lane" is a worktree under `worktreesDir`, numbered by its 1-based
 * alphabetical position (D9). Lanes are long-lived infrastructure — you create
 * them once and then cycle branches through them — so `new` and `rm` are setup
 * operations, not per-task ones.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitLine, gitTry } from './git.mjs';
import { expandHome } from './context.mjs';

export function baseBranch(config) {
  return config?.branch?.base || 'main';
}

export function worktreesDir(config) {
  const dir = expandHome(config?.worktreesDir);
  return dir && existsSync(dir) ? dir : null;
}

/** Directory names under `worktreesDir`, sorted — the lane order. */
function laneNames(config) {
  const dir = worktreesDir(config);
  if (!dir) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Full state of every lane. One git call set per lane, so it stays fast enough
 * to run on every dashboard tick if we ever want to.
 */
export function enumerateLanes(config) {
  const dir = worktreesDir(config);
  if (!dir) return [];
  const base = baseBranch(config);
  return laneNames(config).map((name, i) => {
    const path = join(dir, name);
    const branch = gitLine(path, ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
    const porcelain = git(path, ['status', '--porcelain']);
    const counts = gitLine(path, ['rev-list', '--left-right', '--count', `origin/${base}...HEAD`]);
    const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [0, 0];
    return {
      lane: i + 1,
      name,
      path,
      branch,
      isBase: branch === base,
      dirty: porcelain.trim().length > 0,
      dirtyCount: porcelain.trim() ? porcelain.trim().split('\n').length : 0,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  });
}

/**
 * A lane is free when nothing would be lost by taking it over: clean tree, and
 * either sitting on the base branch or holding a branch with nothing unpushed.
 * `ahead === 0` is the honest test — a merged branch has no commits the base
 * does not already have.
 */
export function isFree(lane) {
  return !lane.dirty && (lane.isBase || lane.ahead === 0);
}


/**
 * Parse a lane selector: `1`, `1,3`, `2-4`, `.` (the lane you are standing in),
 * `all`, or empty (all). Unknown lanes are reported rather than ignored —
 * silently doing nothing to lane 9 is worse than an error.
 */
export function parseSelector(selector, lanes, cwd = process.cwd()) {
  const raw = String(selector ?? '').trim();
  if (raw === '' || raw === 'all') return { lanes, unknown: [] };

  if (raw === '.') {
    const here = lanes.find((l) => cwd === l.path || cwd.startsWith(`${l.path}/`));
    return here ? { lanes: [here], unknown: [] } : { lanes: [], unknown: ['.'] };
  }

  const wanted = new Set();
  const unknown = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) wanted.add(n);
      continue;
    }
    if (/^\d+$/.test(part)) {
      wanted.add(Number(part));
      continue;
    }
    const byName = lanes.find((l) => l.name === part);
    if (byName) wanted.add(byName.lane);
    else unknown.push(part);
  }
  const picked = [];
  for (const n of [...wanted].sort((a, b) => a - b)) {
    const found = lanes.find((l) => l.lane === n);
    if (found) picked.push(found);
    else unknown.push(String(n));
  }
  return { lanes: picked, unknown };
}

/**
 * Create a lane. Returns `{ path, lane, renumbered }`.
 *
 * `renumbered` lists lanes whose number changes because the new name sorts
 * before them — a real hazard, since the lane number drives the colour and the
 * port. Callers must surface it; this function does not decide for the user.
 */
export function planCreate(config, name) {
  const dir = worktreesDir(config);
  if (!dir) return { error: 'worktreesDir is not configured or does not exist' };
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { error: `invalid worktree name: ${name} (letters, digits, . _ - only)` };
  }
  const existing = laneNames(config);
  if (existing.includes(name)) return { error: `${name} already exists` };
  const after = [...existing, name].sort();
  const lane = after.indexOf(name) + 1;
  const renumbered = existing
    .map((n) => ({ name: n, from: existing.indexOf(n) + 1, to: after.indexOf(n) + 1 }))
    .filter((x) => x.from !== x.to);
  return { path: join(dir, name), lane, renumbered };
}

export function createWorktree(config, name, branch, fromRef) {
  const plan = planCreate(config, name);
  if (plan.error) return plan;
  const anyLane = laneNames(config)[0];
  const dir = worktreesDir(config);
  // Run git from an existing worktree so it knows which repo we mean.
  const cwd = anyLane ? join(dir, anyLane) : process.cwd();
  const base = fromRef || `origin/${baseBranch(config)}`;
  git(cwd, ['fetch', 'origin', '--quiet']);
  const args = branch
    ? ['worktree', 'add', '-b', branch, plan.path, base]
    : ['worktree', 'add', plan.path, base];
  const res = gitTry(cwd, args);
  if (!res.ok || !existsSync(plan.path)) {
    return { ...plan, error: res.stderr || 'git worktree add failed' };
  }
  return plan;
}

/**
 * Remove a lane. Refuses when work would be lost unless `force`.
 * `git worktree remove` already refuses on a dirty tree, but it happily drops a
 * branch with unpushed commits — so we check `ahead` ourselves.
 */
export function removeWorktree(config, lane, { force = false } = {}) {
  if (!lane) return { error: 'no such lane' };
  const blockers = [];
  if (lane.dirty) blockers.push(`${lane.dirtyCount} uncommitted change(s)`);
  if (lane.ahead > 0) blockers.push(`${lane.ahead} commit(s) not in origin/${baseBranch(config)}`);
  if (blockers.length && !force) {
    return { error: `refusing to remove lane ${lane.lane} (${lane.name}): ${blockers.join(', ')}` };
  }
  const res = gitTry(lane.path, ['worktree', 'remove', ...(force ? ['--force'] : []), lane.path]);
  if (!res.ok || existsSync(lane.path)) {
    return { error: res.stderr || 'git worktree remove failed' };
  }
  // `git worktree remove` leaves the branch behind, so re-creating a lane with
  // the same name fails on "branch already exists". Say so rather than let the
  // next `lanes new` be a mystery.
  return {
    removed: lane.name,
    wasForced: force && blockers.length > 0,
    blockers,
    branchKept: lane.branch && !lane.isBase ? lane.branch : null,
  };
}

/** Point an existing lane at a different branch, creating it if needed. */
export function switchBranch(config, lane, branch, { create = false } = {}) {
  if (!lane) return { error: 'no such lane' };
  if (lane.dirty) return { error: `lane ${lane.lane} (${lane.name}) has uncommitted changes` };
  git(lane.path, ['fetch', 'origin', '--quiet']);
  const args = create
    ? ['checkout', '-b', branch, `origin/${baseBranch(config)}`]
    : ['checkout', branch];
  const res = gitTry(lane.path, args);
  const now = gitLine(lane.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (now !== branch) return { error: res.stderr || 'checkout failed' };
  return { lane: lane.lane, name: lane.name, branch };
}
