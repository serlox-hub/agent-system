/**
 * Lane lifecycle: enumerate, create, remove, and decide which lanes are free.
 *
 * A "lane" is a worktree under `worktreesDir`, named `lane<N>` — the number is
 * baked into the directory name at creation time (D26), never recomputed from
 * position. Lanes are long-lived infrastructure — you create them once and
 * then cycle branches through them — so `new` and `rm` are setup operations,
 * not per-task ones.
 */

import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { git, gitLine, gitTry } from './git.mjs';
import { expandHome, LANE_NAME_RE, laneNumber } from './context.mjs';
import { resolveServices, status as serviceStatus } from './services.mjs';

export function baseBranch(config) {
  return config?.branch?.base || 'main';
}

export function worktreesDir(config) {
  const dir = expandHome(config?.worktreesDir);
  return dir && existsSync(dir) ? dir : null;
}

/** Directory names under `worktreesDir` matching `lane<N>`, in numeric order. */
function laneNames(config) {
  const dir = worktreesDir(config);
  if (!dir) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && LANE_NAME_RE.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => laneNumber(a) - laneNumber(b));
  } catch {
    return [];
  }
}

/**
 * Full state of every lane. Three synchronous git subprocesses per lane (5s
 * timeout each, `lib/git.mjs`), so it blocks its caller — `ui/dashboard.mjs`
 * throttles it to one refresh per 20 paint ticks rather than running it on
 * every redraw.
 */
export function enumerateLanes(config) {
  const dir = worktreesDir(config);
  if (!dir) return [];
  const base = baseBranch(config);
  return laneNames(config).map((name) => {
    const path = join(dir, name);
    const lane = laneNumber(name);
    const rawBranch = gitLine(path, ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
    const porcelain = git(path, ['status', '--porcelain']);
    const counts = gitLine(path, ['rev-list', '--left-right', '--count', `origin/${base}...HEAD`]);
    const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [0, 0];

    // A detached HEAD (`rawBranch === 'HEAD'`) sitting on the exact commit
    // `origin/<base>` resolves to is the state both a fresh `new` and a
    // `reset` leave a lane in — reported as the base branch name, not the
    // literal "HEAD", with isBase: true, so the MARKS column needs no
    // special-casing for it. No extra subprocess needed: an
    // empty symmetric difference (ahead === 0 && behind === 0) between
    // origin/<base> and HEAD means they are the same commit — the ahead/behind
    // counts above already answer this for free.
    let branch = rawBranch;
    let isBase = rawBranch === base;
    if (rawBranch === 'HEAD' && counts !== '' && ahead === 0 && behind === 0) {
      branch = base;
      isBase = true;
    }

    return {
      lane,
      name,
      path,
      branch,
      isBase,
      dirty: porcelain.trim().length > 0,
      dirtyCount: porcelain.trim() ? porcelain.trim().split('\n').length : 0,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
      baseKnown: counts !== '',
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
 * Divergence tokens for a lane vs its base, as `{ text, tone }` pairs — the
 * single formula `ui/dashboard.mjs`'s MARKS column renders, applying its own
 * colour and width handling.
 *
 * `dirty` is measured independently of the base ref (`git status`, not
 * `rev-list`), so an unresolvable base must not suppress it — only ahead/behind
 * are replaced by a single `unknown` token, never folded into "free": one means
 * nothing would be lost, the other means divergence could not be measured at
 * all, and conflating them would make a lane with real unpushed work look safe
 * to reuse. `baseKnown` is checked with `=== false` on purpose: rows with no
 * git data at all (`baseKnown` left `undefined`) must stay empty rather than
 * claim a measurement was attempted and failed.
 */
export function laneMarks(lane) {
  const tokens = [];
  if (lane.dirty) tokens.push({ text: `~${lane.dirtyCount}`, tone: 'dirty' });
  if (lane.baseKnown === false) {
    tokens.push({ text: '?', tone: 'unknown' });
  } else {
    if (lane.ahead) tokens.push({ text: `+${lane.ahead}`, tone: 'ahead' });
    if (lane.behind) tokens.push({ text: `-${lane.behind}`, tone: 'behind' });
  }
  if (!tokens.length && isFree(lane)) tokens.push({ text: 'free', tone: 'free' });
  return tokens;
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
 * Plan the next lane. `N` = `max(existing lane numbers) + 1` — not a plain
 * count, so a partial hand-migration (a stray non-conforming directory sitting
 * alongside real `lane<N>` ones) can never collide with a name the count would
 * produce. Returns `{ path, lane, createdDir }`.
 */
export function planCreate(config) {
  const raw = expandHome(config?.worktreesDir);
  if (!raw) return { error: 'worktreesDir is not configured — run `lanes worktrees-dir <path>`, or set it in .claude/agent-system.json' };

  // `worktreesDir()` treats a missing directory as "disabled" for read-only
  // callers (`doctor`/`status`) — correct there, but `new` is itself an act of
  // creation, so an explicitly configured path that just doesn't exist yet
  // (e.g. right after `lanes adopt` proposed it) should be created, not refused.
  // Requiring the *parent* to already exist keeps that case working (the parent
  // is the repo's own directory) while still refusing a stale or mistyped path —
  // e.g. after cloning the repo to a different machine — instead of silently
  // materializing it wherever it happens to point.
  let createdDir = null;
  if (!existsSync(raw)) {
    if (!existsSync(dirname(raw))) {
      return {
        error: `worktreesDir ${raw} does not exist, and neither does its parent — check .claude/agent-system.json or this machine's override (\`lanes worktrees-dir\`)`,
      };
    }
    try {
      mkdirSync(raw, { recursive: true });
      createdDir = raw;
    } catch (err) {
      return { error: `could not create worktreesDir ${raw}: ${err.message}` };
    }
  }

  const existing = laneNames(config).map(laneNumber);
  const lane = existing.length ? Math.max(...existing) + 1 : 1;
  const path = join(raw, `lane${lane}`);
  if (existsSync(path)) {
    return { error: `${path} already exists — remove it, or something is out of sync under ${raw}` };
  }
  return { path, lane, createdDir };
}

/** Create the next lane, always detached at `fromRef` (or `origin/<base>`). */
export function createWorktree(config, fromRef) {
  const plan = planCreate(config);
  if (plan.error) return plan;
  const anyLane = laneNames(config)[0];
  const dir = worktreesDir(config);
  // Run git from an existing worktree so it knows which repo we mean.
  const cwd = anyLane ? join(dir, anyLane) : process.cwd();
  const base = fromRef || `origin/${baseBranch(config)}`;
  git(cwd, ['fetch', 'origin', '--quiet']);
  // `--detach` is explicit, not incidental: without it, an unqualified `--from
  // <branch>` with exactly one matching remote triggers git's own DWIM and
  // creates (and checks out) a local branch instead of landing detached.
  const res = gitTry(cwd, ['worktree', 'add', '--detach', plan.path, base]);
  if (!res.ok || !existsSync(plan.path)) {
    return { ...plan, error: res.stderr || 'git worktree add failed' };
  }
  return plan;
}

/**
 * Remove one or more lanes. The selection must be a contiguous run ending at
 * the current top lane — pop doesn't compose with an arbitrary multi-select
 * otherwise: removing a middle lane strands its number permanently, since
 * `planCreate` is `max(existing)+1` and never backfills a gap (see its own
 * docblock) — lane numbers, and the colours and ports hanging off them, would
 * drift upward without bound. Popping the top is what makes a freed number
 * come back for the next `new` to reuse. Refuses outright (not just warns) if
 * any selected lane still has a running declared service: under deterministic
 * number reuse, a popped-then-reappended lane number always inherits the
 * previous occupant's pid-file key (`lib/services.mjs`, keyed by worktree
 * name) — the exact class of bug D18 exists to prevent, guaranteed here
 * rather than just possible. Dirty/unpushed-work blockers are otherwise
 * unchanged from before, and everything is checked before anything is
 * touched; only then are the lanes actually removed, in descending order.
 *
 * `wholeStack: true` (only `lanes clear`) skips the contiguous-run check:
 * that check exists solely to stop a *partial* removal from stranding a
 * freed number in the middle of the stack, and removing every lane strands
 * nothing — `planCreate` restarts at 1 regardless of what the numbering
 * looked like before. Without the opt-out, a stack with a gap in the middle
 * (a lane directory removed by hand, outside `lanes`) would refuse `clear`
 * entirely and point at an `lanes rm <n>` the caller never asked for.
 */
export function removeWorktree(config, lanes, { force = false, wholeStack = false } = {}) {
  if (!lanes || !lanes.length) return { error: 'no such lane' };

  // laneNames() is a directory listing (no git calls) — enumerateLanes()
  // would recompute the same numbers through 3-5 git subprocesses per lane
  // just to learn the single largest one.
  const names = laneNames(config);
  const top = names.length ? laneNumber(names[names.length - 1]) : 0;
  const nums = [...new Set(lanes.map((l) => l.lane))].sort((a, b) => a - b);
  const contiguousAtTop = nums[nums.length - 1] === top && nums.every((n, i) => n === nums[0] + i);
  if (!wholeStack && !contiguousAtTop) {
    return { error: `only the top of the stack can be removed — top is lane ${top}, try \`lanes rm ${top}\`` };
  }

  for (const lane of lanes) {
    const running = resolveServices(config, lane).filter((s) => serviceStatus(s).running);
    if (running.length) {
      return {
        error: `refusing to remove lane ${lane.lane} (${lane.name}): ${running.map((s) => s.name).join(', ')} still running — \`lanes stop ${lane.lane}\` first`,
      };
    }
  }

  const blockersByLane = new Map();
  for (const lane of lanes) {
    const blockers = [];
    if (lane.dirty) blockers.push(`${lane.dirtyCount} uncommitted change(s)`);
    if (lane.ahead > 0) blockers.push(`${lane.ahead} commit(s) not in origin/${baseBranch(config)}`);
    if (blockers.length && !force) {
      return { error: `refusing to remove lane ${lane.lane} (${lane.name}): ${blockers.join(', ')}` };
    }
    blockersByLane.set(lane.lane, blockers);
  }

  const removed = [];
  for (const lane of [...lanes].sort((a, b) => b.lane - a.lane)) {
    const res = gitTry(lane.path, ['worktree', 'remove', ...(force ? ['--force'] : []), lane.path]);
    if (!res.ok || existsSync(lane.path)) {
      return { removed, error: res.stderr || `git worktree remove failed for lane ${lane.lane}` };
    }
    // `git worktree remove` leaves the branch behind, and a detached HEAD
    // carries no branch to leave — `!lane.isBase` alone would misreport the
    // literal string "HEAD" as a kept branch for a lane detached at a
    // non-base ref (possible via `new --from <ref>`), so it is excluded too.
    removed.push({
      lane: lane.lane,
      name: lane.name,
      branch: lane.branch,
      path: lane.path,
      wasForced: force && blockersByLane.get(lane.lane).length > 0,
      blockers: blockersByLane.get(lane.lane),
      branchKept: lane.branch && lane.branch !== 'HEAD' && !lane.isBase ? lane.branch : null,
    });
  }
  return { removed };
}

/**
 * Return a lane to a clean, branch-free state tracking base: detach at
 * `origin/<base>` after a fresh fetch, deleting the branch just vacated if it
 * turned out to be fully merged (kept, reported, otherwise). Refuses unless
 * the lane is free (`isFree`) or `force` is passed — this can discard
 * whatever the lane was holding.
 */
export function resetLane(config, lane, { force = false } = {}) {
  if (!lane) return { error: 'no such lane' };
  if (!force && !isFree(lane)) {
    return {
      error: `lane ${lane.lane} (${lane.name}) is not free — uncommitted changes or unpushed commits. Use --force to reset anyway.`,
    };
  }

  const base = baseBranch(config);
  const fetch = gitTry(lane.path, ['fetch', 'origin']);
  if (!fetch.ok) return { error: fetch.stderr || 'git fetch origin failed' };

  // Same HEAD-literal exclusion as removeWorktree's branchKept: nothing to
  // delete for a detached lane, whether or not it happened to sit on base.
  const outgoingBranch = lane.branch && lane.branch !== 'HEAD' && !lane.isBase ? lane.branch : null;

  const checkout = gitTry(lane.path, ['checkout', '--detach', `origin/${base}`]);
  if (!checkout.ok) return { error: checkout.stderr || 'git checkout --detach failed' };

  let branchDeleted = null;
  if (outgoingBranch) {
    // `-d`, not `-D`: only deletes when fully merged into the branch it is
    // currently pointed at — now `origin/<base>`, since checkout already
    // moved HEAD — and fails harmlessly (branchDeleted stays null) otherwise.
    const del = gitTry(lane.path, ['branch', '-d', outgoingBranch]);
    branchDeleted = del.ok ? outgoingBranch : null;
  }

  return { lane: lane.lane, name: lane.name, branch: base, branchDeleted };
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
