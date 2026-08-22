#!/usr/bin/env node
/**
 * Smoke tests. Run with `npm test`.
 *
 * A system whose whole pitch is quality gates has no business shipping without
 * any of its own. These cover the logic that is easy to break silently and
 * expensive to notice: issue extraction, lane numbering, event folding, review
 * marker staleness, and every branch of the commit guard.
 *
 * Zero dependencies — node:assert and a real throwaway git repo in os.tmpdir().
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ESC = String.fromCharCode(27);

// ── Fixture: a real repo with three real worktrees ──────────────────
// realpath matters: on macOS os.tmpdir() is /var/... which is a symlink to
// /private/var/..., and `git rev-parse --show-toplevel` reports the real path.
// Without this the fixture's own paths would not compare equal to git's.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'agent-system-test-')));

// Sandbox HOME *before* importing anything, so the event log lands in TMP.
// LANES_DIR is resolved from os.homedir() at module load, and the guard emits
// real events — without this, running the suite would pollute the developer's
// own dashboard with a fake project. Child processes inherit it too.
process.env.HOME = TMP;
mkdirSync(join(TMP, '.claude'));

const { resolveContext, issueFromBranch, resolveLane, findProject, LANES_DIR } =
  await import(`${ROOT}/lib/context.mjs`);
const { mainWorktreeRoot, readLocalOverride, writeLocalOverride, isGitignored } = await import(
  `${ROOT}/lib/local-config.mjs`
);
const { diffFingerprint, changedLineCount, writeMark, readMark, REVIEW_MARK } = await import(`${ROOT}/lib/marks.mjs`);
const { createState, applyEvents, render, notifyTitle } = await import(`${ROOT}/ui/dashboard.mjs`);
const { readColors, setColor, laneColorFor, ansi, DEFAULT_PALETTE } = await import(`${ROOT}/lib/colors.mjs`);
const worktrees = await import(`${ROOT}/lib/worktrees.mjs`);
const sv = await import(`${ROOT}/lib/services.mjs`);

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const repo = join(TMP, 'demo');
mkdirSync(repo);
git(repo, 'init', '-q');
git(repo, 'config', 'user.email', 'test@test.test');
git(repo, 'config', 'user.name', 'test');
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
mkdirSync(join(repo, '.claude'));
const wtDir = join(TMP, 'wts');
mkdirSync(wtDir);
writeFileSync(
  join(repo, '.claude', 'agent-system.json'),
  JSON.stringify({ project: 'demo', worktreesDir: wtDir, basePort: 300, review: { largeDiffThreshold: 400 } }),
);
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'init');
for (const n of [1, 2, 3]) {
  git(repo, 'worktree', 'add', '-q', join(wtDir, `demo-${n}`), '-b', `feat/${400 + n}-thing`);
}
const lane2 = join(wtDir, 'demo-2');

// ── Pure logic ──────────────────────────────────────────────────────
test('issueFromBranch pulls the number out of the default pattern', () => {
  assert.equal(issueFromBranch('feat/412-alert-filters', {}), '412');
  assert.equal(issueFromBranch('fix/7-x', {}), '7');
  assert.equal(issueFromBranch('main', {}), null);
  assert.equal(issueFromBranch(null, {}), null);
});

test('issueFromBranch honours a custom pattern and ignores non-digit groups', () => {
  const cfg = { branch: { pattern: '^([A-Z]+)-(\\d+)-' } };
  assert.equal(issueFromBranch('SPA-123-thing', cfg), '123');
});

test('issueFromBranch survives an invalid pattern instead of throwing', () => {
  assert.equal(issueFromBranch('feat/9-x', { branch: { pattern: '([' } }), '9');
});

test('lane numbers are the 1-based alphabetical position under worktreesDir', () => {
  const cfg = { worktreesDir: wtDir };
  assert.equal(resolveLane(join(wtDir, 'demo-1'), cfg).lane, 1);
  assert.equal(resolveLane(join(wtDir, 'demo-3'), cfg).lane, 3);
  assert.equal(resolveLane('/nowhere/demo-9', cfg).lane, null);
  assert.equal(resolveLane(join(wtDir, 'demo-2'), {}).lane, null, 'no worktreesDir means no lanes');
});

test('findProject walks up to the config and returns null outside a project', () => {
  assert.equal(findProject(join(repo, 'src'))?.root, repo);
  assert.equal(findProject(tmpdir()), null);
});

test('a malformed config degrades to opted-in-with-no-settings, never throws', () => {
  const broken = join(TMP, 'broken');
  mkdirSync(join(broken, '.claude'), { recursive: true });
  writeFileSync(join(broken, '.claude', 'agent-system.json'), '{ not json');
  const found = findProject(broken);
  assert.deepEqual(found.config, {});
  assert.ok(found.configError, 'the parse error is reported, not swallowed');
});

// ── Context in a real worktree ──────────────────────────────────────
test('resolveContext ties worktree, lane, port, branch and issue together', () => {
  const ctx = resolveContext(lane2);
  assert.equal(ctx.optedIn, true);
  assert.equal(ctx.project, 'demo');
  assert.equal(ctx.lane, 2);
  assert.equal(ctx.worktree, 'demo-2');
  assert.equal(ctx.port, '3002');
  assert.equal(ctx.branch, 'feat/402-thing');
  assert.equal(ctx.issue, '402');
  // The config is committed, so every worktree carries its own copy — which is
  // the point: adopting the system is a commit, not per-machine setup.
  assert.equal(ctx.configPath, join(lane2, '.claude', 'agent-system.json'));
  assert.equal(ctx.configError, null);
});

// ── Per-machine worktreesDir override (D22) ──────────────────────────
test('readLocalOverride returns {} when the file is missing or malformed', () => {
  const fresh = join(TMP, 'lc-empty');
  mkdirSync(fresh);
  git(fresh, 'init', '-q');
  assert.deepEqual(readLocalOverride(fresh), {});

  mkdirSync(join(fresh, '.claude'));
  writeFileSync(join(fresh, '.claude', 'agent-system.local.json'), '{ not json');
  assert.deepEqual(readLocalOverride(fresh), {});
});

test('writeLocalOverride shallow-merges, and every lane of the same repo shares the file', () => {
  const main = join(TMP, 'lc-main');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@test.test');
  git(main, 'config', 'user.name', 'test');
  writeFileSync(join(main, 'f.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  const linked = join(TMP, 'lc-main-linked');
  git(main, 'worktree', 'add', '-q', linked, '-b', 'lc-linked');

  assert.equal(mainWorktreeRoot(linked), main, 'resolves the MAIN worktree root, not the linked one');

  const written = writeLocalOverride(linked, { worktreesDir: '/somewhere' });
  assert.deepEqual(written, { worktreesDir: '/somewhere' });
  assert.equal(existsSync(join(main, '.claude', 'agent-system.local.json')), true);
  assert.equal(
    existsSync(join(linked, '.claude', 'agent-system.local.json')),
    false,
    'lives at the shared root, not per-worktree',
  );
  assert.deepEqual(readLocalOverride(main), { worktreesDir: '/somewhere' }, 'the other lane sees it too');

  writeLocalOverride(main, { extra: 'kept' });
  assert.deepEqual(
    readLocalOverride(linked),
    { worktreesDir: '/somewhere', extra: 'kept' },
    'shallow merge, not overwrite',
  );
});

test('mainWorktreeRoot resolves correctly from a subdirectory, not just the worktree root', () => {
  // `--git-common-dir` prints relative to CWD, not to `--show-toplevel` — a
  // regression here silently climbs out of the repo from any subdirectory.
  const main = join(TMP, 'lc-subdir-main');
  mkdirSync(join(main, 'src', 'deep'), { recursive: true });
  git(main, 'init', '-q');
  assert.equal(mainWorktreeRoot(main), main, 'from the root itself');
  assert.equal(mainWorktreeRoot(join(main, 'src')), main, 'one level down');
  assert.equal(mainWorktreeRoot(join(main, 'src', 'deep')), main, 'two levels down');
});

test('findProject: no local override present, the committed worktreesDir behaves exactly as today', () => {
  const solo = join(TMP, 'merge-none');
  mkdirSync(solo);
  git(solo, 'init', '-q');
  mkdirSync(join(solo, '.claude'));
  writeFileSync(
    join(solo, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'merge-none', worktreesDir: '/committed/path' }),
  );
  assert.equal(findProject(solo).config.worktreesDir, '/committed/path');
});

test('findProject: a local override wins over the committed worktreesDir, from every lane', () => {
  const main = join(TMP, 'merge-main');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@test.test');
  git(main, 'config', 'user.name', 'test');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'merge-main', worktreesDir: '/committed/path' }),
  );
  writeFileSync(join(main, 'f.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  const linked = join(TMP, 'merge-main-linked');
  git(main, 'worktree', 'add', '-q', linked, '-b', 'merge-linked');

  writeLocalOverride(main, { worktreesDir: '/override/path' });

  assert.equal(findProject(main).config.worktreesDir, '/override/path');
  assert.equal(
    findProject(linked).config.worktreesDir,
    '/override/path',
    'the linked worktree sees the same override',
  );
});

test('findProject: a local basePort override wins over the committed default too', () => {
  const main = join(TMP, 'merge-baseport');
  mkdirSync(main);
  git(main, 'init', '-q');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'merge-baseport', basePort: 300 }),
  );
  assert.equal(findProject(main).config.basePort, 300, 'no override present, committed default behaves as before');

  writeLocalOverride(main, { basePort: 400 });
  assert.equal(findProject(main).config.basePort, 400);
});

// ── Review markers ──────────────────────────────────────────────────
test('the review marker goes stale the moment the tree changes', () => {
  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const b = 2;\n');
  const fp = diffFingerprint(lane2);
  writeMark(lane2, REVIEW_MARK, fp);
  assert.equal(readMark(lane2, REVIEW_MARK), fp, 'fresh marker matches');

  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const c = 3;\n');
  assert.notEqual(diffFingerprint(lane2), fp, 'one more line invalidates it');
});

test('changedLineCount sums staged and unstaged, not one or the other', () => {
  git(lane2, 'add', 'src/a.ts'); //  2 staged insertions
  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const d = 4;\n'); // 1 unstaged
  assert.equal(changedLineCount(lane2), 3);
});

test('untracked files are part of the fingerprint', () => {
  const before = diffFingerprint(lane2);
  writeFileSync(join(lane2, 'src', 'brand-new.ts'), 'export const e = 5;\n');
  assert.notEqual(diffFingerprint(lane2), before);
});

// ── Commit guard, every branch ──────────────────────────────────────
const guard = (cwd, command) => {
  const payload = JSON.stringify({ cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const out = execFileSync('node', [join(ROOT, 'hooks', 'commit-guard.mjs')], { input: payload, encoding: 'utf8' });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};

test('the guard ignores commands that are not commits', () => {
  assert.equal(guard(lane2, 'ls -la'), 'allow');
  assert.equal(guard(lane2, 'git status'), 'allow');
});

test('the guard blocks an unreviewed commit through every option form', () => {
  assert.equal(guard(lane2, 'git commit -m wip'), 'deny');
  assert.equal(guard(lane2, 'git -C . commit -m wip'), 'deny', '-C takes a value');
  assert.equal(guard(lane2, 'git --no-pager commit -m wip'), 'deny');
  assert.equal(guard(lane2, 'git --git-dir=.git commit -m wip'), 'deny');
  assert.equal(guard(lane2, 'git -c user.name=x commit -m wip'), 'deny', '-c takes a value');
  assert.equal(guard(lane2, 'npm run build && git commit -m wip'), 'deny', 'chained commands count');
});

test('the guard does not fire on git commands that merely mention commit', () => {
  assert.equal(guard(lane2, 'git log --grep commit'), 'allow');
  assert.equal(guard(lane2, 'git commit-tree abc'), 'allow');
  assert.equal(guard(lane2, 'echo "commit later"'), 'allow');
});

test('the guard allows once the current diff is marked reviewed', () => {
  writeMark(lane2, REVIEW_MARK, diffFingerprint(lane2));
  assert.equal(guard(lane2, 'git commit -m wip'), 'allow');
  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const f = 6;\n');
  assert.equal(guard(lane2, 'git commit -m wip'), 'deny', 'stale marker must not pass');
});

test('the guard stays silent in a repo that has not opted in', () => {
  const plain = join(TMP, 'plain');
  mkdirSync(plain);
  git(plain, 'init', '-q');
  assert.equal(guard(plain, 'git commit -m wip'), 'allow');
});

test('commitGuard: false disables the block entirely', () => {
  const off = join(TMP, 'off');
  mkdirSync(join(off, '.claude'), { recursive: true });
  git(off, 'init', '-q');
  writeFileSync(
    join(off, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'off', review: { commitGuard: false } }),
  );
  writeFileSync(join(off, 'x.ts'), 'export const x = 1;\n');
  assert.equal(guard(off, 'git commit -m wip'), 'allow');
});

// ── Dashboard state ─────────────────────────────────────────────────
const ev = (ts, e, extra = {}) => ({ ts, ev: e, project: 'demo', lane: 1, worktree: 'demo-1', ...extra });

test('applyEvents keeps only the latest state per lane', () => {
  const s = applyEvents(createState(), [ev(1, 'session_start'), ev(2, 'agent_start', { agent: 'code-reviewer' })]);
  assert.equal(s.lanes.size, 1);
  assert.equal(s.lanes.get('demo#demo-1').ev, 'agent_start');
  assert.equal(s.lanes.get('demo#demo-1').agent, 'code-reviewer');
});

test('agent_end clears the running agent; busy is kept out of history', () => {
  const s = applyEvents(createState(), [
    ev(1, 'agent_start', { agent: 'test-writer' }),
    ev(2, 'agent_end'),
    ev(3, 'busy'),
  ]);
  assert.equal(s.lanes.get('demo#demo-1').agent, null);
  assert.equal(s.history.length, 2, 'busy is noise, it fires on every message');
});

test('lane_removed deletes the lane outright, so a same-named lane never inherits its state', () => {
  const s = applyEvents(createState(), [
    ev(1, 'session_start', { issue: '402' }),
    ev(2, 'stage', { stage: 'review' }),
    ev(3, 'lane_removed'),
  ]);
  assert.equal(s.lanes.has('demo#demo-1'), false, 'the removed lane must leave no trace to inherit from');

  const recreated = applyEvents(s, [ev(4, 'lane_created', { branch: 'feat/999-other' })]);
  const row = recreated.lanes.get('demo#demo-1');
  assert.equal(row.issue, undefined, 'a fresh lane must not inherit the old occupant\'s issue');
  assert.equal(row.stage, undefined, 'nor its stage');
  assert.equal(row.branch, 'feat/999-other');
});

test('applyEvents is incremental — folding twice equals folding once', () => {
  const events = [ev(1, 'session_start'), ev(2, 'stage', { stage: 'review' })];
  const once = applyEvents(createState(), events);
  const twice = applyEvents(applyEvents(createState(), [events[0]]), [events[1]]);
  assert.deepEqual(twice.lanes.get('demo#demo-1'), once.lanes.get('demo#demo-1'));
});

test('a stage event is a milestone, not a liveness signal — it must not overwrite the lane state', () => {
  const onlyStage = applyEvents(createState(), [ev(1, 'stage', { stage: 'implement' })]);
  const row = onlyStage.lanes.get('demo#demo-1');
  assert.equal(row.ev, null, 'no session/agent event was ever seen for this lane');
  assert.equal(row.stage, 'implement');

  const withSession = applyEvents(createState(), [ev(1, 'session_start'), ev(2, 'stage', { stage: 'review' })]);
  const row2 = withSession.lanes.get('demo#demo-1');
  assert.equal(row2.ev, 'session_start', 'the stage marker must not clobber the last real state');
  assert.equal(row2.stage, 'review');
});

test('render puts stage and state in separate columns, and never paints a bare stage as live', () => {
  const frame = render(resolveContext(lane2), applyEvents(createState(), [ev(1, 'stage', { stage: 'implement' })]));
  const table = frame.slice(0, frame.indexOf('RECENT')); // RECENT is a log; the merged "stage: X" label is fine there
  assert.ok(table.includes('implement'), 'the stage still shows');
  assert.ok(table.includes('no session seen'), 'a bare stage marker is not a state, and must not be painted as one');
  assert.ok(!table.includes('stage: implement'), 'the old merged "stage: X" state label must be gone from the table');
});

test('history is capped so a long-running dashboard cannot grow without bound', () => {
  const many = Array.from({ length: 500 }, (_, i) => ev(i + 1, 'stage', { stage: `s${i}` }));
  assert.ok(applyEvents(createState(), many).history.length <= 12);
});

test('an event carrying fields the fold does not know is tolerated', () => {
  const s = applyEvents(createState(), [null, {}, ev(1, 'session_start'), { ts: 2, nope: true }]);
  assert.equal(s.lanes.size, 1, 'malformed events are skipped, not fatal');
});

test('render emits no clear-screen — that is the caller’s choice', () => {
  const ctx = resolveContext(lane2);
  const frame = render(ctx, applyEvents(createState(), [ev(1, 'idle')]));
  assert.ok(!frame.includes(`${ESC}[2J`), 'lanes status must not wipe the terminal');
  assert.ok(frame.includes('demo-2'), 'declared lanes appear even with no events of their own');
});

test('render shows a declared lane with no events at all as offline', () => {
  const frame = render(resolveContext(lane2), createState());
  assert.ok(frame.includes('demo-3'));
  assert.ok(frame.includes('offline'));
});

test('MARKS renders ? when the base ref cannot be resolved — never free, never a bare —', () => {
  // The fixture repo has no `origin` remote, so `enumerateLanes` can never
  // resolve `origin/main...HEAD` — every lane's baseKnown is false.
  const frame = render(resolveContext(lane2), createState());
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.includes('demo-3'));
  assert.ok(row, 'demo-3 must have a row');
  // Column order: # (3) WORKTREE (20) BRANCH (40) MARKS (12) ...
  const marks = row.slice(3 + 20 + 40, 3 + 20 + 40 + 12).trim();
  assert.equal(marks, '?', 'unknown divergence must render as ?, distinct from both free and —');
});

test('MARKS renders dirty, ahead and behind together through the laneInfo seam, without shifting ISSUE', () => {
  // Fabricated laneInfo, bypassing the real `enumerateLanes` git read — this
  // is the only way to exercise the coloured, non-"?" formatting path, since
  // the fixture repo (no `origin`) always makes the real read baseKnown: false.
  const fabricated = [{
    lane: 1, name: 'demo-1', path: join(wtDir, 'demo-1'), branch: 'feat/9-x',
    isBase: false, dirty: true, dirtyCount: 3, ahead: 2, behind: 1, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.includes('demo-1') && !l.includes('demo-10'));
  assert.ok(row, 'demo-1 must have a row');
  const marks = row.slice(3 + 20 + 40, 3 + 20 + 40 + 12).trim();
  assert.equal(marks, '~3 +2 -1', 'dirty, ahead and behind must all render together when the base is known');
  // The ANSI codes wrapped around each token must not shift where ISSUE
  // starts — the regression the pad-then-colour ordering in marksCell guards
  // against — and the issue must follow the fabricated branch, not be blank.
  const issue = row.slice(3 + 20 + 40 + 12, 3 + 20 + 40 + 12 + 8).trim();
  assert.equal(issue, '#9', 'ISSUE must read correctly right after a coloured MARKS cell');
});

test('MARKS renders free for a clean lane on base once the base ref actually resolves', () => {
  const fabricated = [{
    lane: 1, name: 'demo-1', path: join(wtDir, 'demo-1'), branch: 'main',
    isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.includes('demo-1') && !l.includes('demo-10'));
  const marks = row.slice(3 + 20 + 40, 3 + 20 + 40 + 12).trim();
  assert.equal(marks, 'free', 'clean and on base, with a resolvable base ref, must render free — never ?');
});

test('rowsFor clears a stale issue once the branch is read and encodes none, rather than keeping an event-log leftover', () => {
  const state = applyEvents(createState(), [ev(1, 'session_start', { issue: '402' })]);
  // The branch read succeeded and the lane is back on `main` — no issue
  // number in it, which must win over the stale '402' from the event log.
  const backOnBase = [{
    lane: 1, name: 'demo-1', path: join(wtDir, 'demo-1'), branch: 'main',
    isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), state, Date.now(), backOnBase);
  const row = frame.split('\n').find((l) => l.includes('demo-1') && !l.includes('demo-10'));
  assert.ok(row, 'demo-1 must have a row');
  assert.ok(!row.includes('#402'), 'a resolved branch with no issue in it must clear the stale one, not keep displaying it');
});

test('rowsFor keeps the last known issue when the branch read itself fails', () => {
  const state = applyEvents(createState(), [ev(1, 'session_start', { issue: '402' })]);
  // `branch: null` is how a failed git read is represented — must not be
  // treated the same as a successful read that found no issue in the branch.
  const failedRead = [{
    lane: 1, name: 'demo-1', path: join(wtDir, 'demo-1'), branch: null,
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: false,
  }];
  const frame = render(resolveContext(lane2), state, Date.now(), failedRead);
  const row = frame.split('\n').find((l) => l.includes('demo-1') && !l.includes('demo-10'));
  assert.ok(row, 'demo-1 must have a row');
  assert.ok(row.includes('#402'), 'a failed branch read must not blank a previously known issue');
});

test('notifyTitle falls back to worktree, never to an unidentified "lane ?"', () => {
  assert.equal(notifyTitle(ev(1, 'idle', { lane: null, issue: '12' })), 'demo · demo-1 · #12');
  assert.equal(notifyTitle(ev(1, 'idle')), 'demo · lane 1');
});

test('RECENT rows fall back to worktree too — a lane-less event must still say which one', () => {
  const frame = render(
    resolveContext(lane2),
    applyEvents(createState(), [ev(1, 'idle', { lane: null, worktree: 'demo-7' })]),
  );
  assert.ok(frame.includes('demo-7'), 'the worktree name must appear somewhere, not just a bare "·"');
});

test('a lane whose worktree was removed outside the dashboard is dropped, not stuck forever', () => {
  const state = createState();
  state.lanes.set('demo#demo-ghost', {
    project: 'demo', worktree: 'demo-ghost', ev: 'busy', since: 1,
    path: join(wtDir, 'demo-ghost'), // never created — existsSync must say so
  });
  const frame = render(resolveContext(lane2), state);
  assert.ok(!frame.includes('demo-ghost'), 'its path is gone — it must not linger as a live row');
});

test('a ghost row from another project is dropped too — liveness is checked by path, not by project', () => {
  const state = createState();
  state.lanes.set('other-project#some-worktree', {
    project: 'other-project', worktree: 'some-worktree', ev: 'busy', since: 1,
    path: join(wtDir, 'not-there'),
  });
  const frame = render(resolveContext(lane2), state);
  assert.ok(!frame.includes('some-worktree'), 'existsSync needs no project match to tell this path is gone');
});

test('a ghost row with no recorded path fails open — events written before that field existed cannot be verified', () => {
  const state = createState();
  state.lanes.set('other-project#some-worktree', { project: 'other-project', worktree: 'some-worktree', ev: 'busy', since: 1 });
  const frame = render(resolveContext(lane2), state);
  assert.ok(frame.includes('some-worktree'), 'no path recorded means it cannot be checked, so it must not be hidden');
});

test('a currently-declared lane bypasses the existsSync liveness check entirely, even with a stale path', () => {
  const state = createState();
  state.lanes.set('demo#demo-1', {
    project: 'demo', worktree: 'demo-1', ev: 'idle', since: 1,
    // A path left over from before a rename, say — must never be consulted:
    // declared lanes are matched by name against the live directory listing,
    // not verified against a path recorded in a past event.
    path: join(wtDir, 'demo-1-stale-path-from-before-a-rename'),
  });
  const frame = render(resolveContext(lane2), state);
  const row = frame.split('\n').find((l) => l.includes('demo-1') && !l.includes('demo-10'));
  assert.ok(row, 'demo-1 must still get a row');
  assert.ok(row.includes('waiting for you'), 'a declared lane must keep its real state regardless of a stale path');
  assert.ok(!row.includes('offline'), 'it must not fall back to the no-events default either');
});

// ── Lane lifecycle ──────────────────────────────────────────────────
const wtCfg = { project: 'demo', worktreesDir: wtDir, basePort: 300, branch: { base: 'main' } };

test('enumerateLanes reports branch, dirty state and position', () => {
  const all = worktrees.enumerateLanes(wtCfg);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((l) => l.name), ['demo-1', 'demo-2', 'demo-3']);
  assert.equal(all[1].lane, 2);
  assert.equal(all[1].branch, 'feat/402-thing');
  assert.equal(all[1].dirty, true, 'earlier tests left changes in demo-2');
  assert.equal(all[0].dirty, false);
});

test('a lane is free only when nothing would be lost', () => {
  const [one, two] = worktrees.enumerateLanes(wtCfg);
  assert.equal(worktrees.isFree(one), true, 'clean and level with base');
  assert.equal(worktrees.isFree(two), false, 'dirty tree is never free');
  assert.equal(worktrees.isFree({ dirty: false, isBase: false, ahead: 2 }), false, 'unpushed commits are not free');
  assert.equal(worktrees.isFree({ dirty: false, isBase: true, ahead: 5 }), true, 'the base branch itself is free');
});

test('laneMarks: dirty is measured independently of baseKnown — a dirty lane with an unresolvable base still gets ~N, not just ?', () => {
  const marks = worktrees.laneMarks({ dirty: true, dirtyCount: 4, baseKnown: false, ahead: 9, behind: 9, isBase: false });
  assert.deepEqual(marks, [
    { text: '~4', tone: 'dirty' },
    { text: '?', tone: 'unknown' },
  ], 'ahead/behind are dropped in favour of one ? token once the base is unresolvable, but the dirty token survives');
});

test('laneMarks: ahead and behind render as their own tokens once the base is known', () => {
  const marks = worktrees.laneMarks({ dirty: false, dirtyCount: 0, baseKnown: true, ahead: 2, behind: 1, isBase: false });
  assert.deepEqual(marks, [
    { text: '+2', tone: 'ahead' },
    { text: '-1', tone: 'behind' },
  ]);
});

test('laneMarks: a clean lane level with a known base renders a single free token', () => {
  assert.deepEqual(
    worktrees.laneMarks({ dirty: false, dirtyCount: 0, baseKnown: true, ahead: 0, behind: 0, isBase: false }),
    [{ text: 'free', tone: 'free' }],
  );
});

test('laneMarks: a lane with no git data at all stays empty — it must not claim free or ? for a measurement never attempted', () => {
  // No `baseKnown` field at all (as opposed to `baseKnown: false`, which means
  // "attempted and failed") must not be treated as an unresolvable base.
  assert.deepEqual(worktrees.laneMarks({}), []);
});

test('lanes list shows a dirty lane as ~N and documents the new ? token in its legend', () => {
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['list'], { cwd: repo, encoding: 'utf8' });
  const row = output.split('\n').find((l) => l.includes('demo-2'));
  assert.ok(row, 'demo-2 must have a row');
  assert.match(row, /~\d+/, 'demo-2 has real uncommitted changes from earlier tests, so ~N must still show in `lanes list`');
  assert.match(
    output,
    /\? = origin\/main could not be resolved/,
    'the legend must document the ? token, alongside the pre-existing ~n/+n/-n/svc! ones',
  );
});

test('planCreate detects the lanes a new name would renumber', () => {
  const early = worktrees.planCreate(wtCfg, 'aaa');
  assert.equal(early.lane, 1);
  assert.deepEqual(early.renumbered.map((r) => `${r.name}:${r.from}->${r.to}`), [
    'demo-1:1->2', 'demo-2:2->3', 'demo-3:3->4',
  ]);
  const late = worktrees.planCreate(wtCfg, 'demo-4');
  assert.equal(late.lane, 4);
  assert.deepEqual(late.renumbered, [], 'a name that sorts last disturbs nothing');
});

test('planCreate refuses duplicates and unsafe names', () => {
  assert.match(worktrees.planCreate(wtCfg, 'demo-1').error, /already exists/);
  assert.match(worktrees.planCreate(wtCfg, '../escape').error, /invalid worktree name/);
  assert.match(worktrees.planCreate(wtCfg, 'a b').error, /invalid worktree name/);
});

test('planCreate creates worktreesDir itself when configured but missing', () => {
  const freshDir = join(TMP, 'fresh-wts');
  assert.equal(existsSync(freshDir), false, 'precondition: not created yet');
  const plan = worktrees.planCreate({ worktreesDir: freshDir }, 'first');
  assert.equal(plan.error, undefined);
  assert.equal(existsSync(freshDir), true);
  assert.equal(plan.createdDir, freshDir);
  assert.equal(plan.lane, 1);
  assert.equal(plan.path, join(freshDir, 'first'));

  const again = worktrees.planCreate({ worktreesDir: freshDir }, 'second');
  assert.equal(again.createdDir, null, 'does not report a re-creation once the dir exists');
});

test('planCreate refuses a name when worktreesDir was never configured', () => {
  assert.match(worktrees.planCreate({}, 'x').error, /not configured/);
});

test('planCreate validates the name before touching the filesystem', () => {
  const notYet = join(TMP, 'not-yet-wts');
  assert.equal(existsSync(notYet), false);
  assert.match(worktrees.planCreate({ worktreesDir: notYet }, 'a b').error, /invalid worktree name/);
  assert.equal(existsSync(notYet), false, 'a rejected name must not create the directory as a side effect');
});

test('planCreate refuses to create worktreesDir when its parent is also missing', () => {
  const orphan = join(TMP, 'no-such-parent', 'wts');
  const plan = worktrees.planCreate({ worktreesDir: orphan }, 'first');
  assert.match(plan.error, /does not exist, and neither does its parent/);
  assert.equal(existsSync(orphan), false);
});

test('lane selectors cover every form and report the unknown ones', () => {
  const all = worktrees.enumerateLanes(wtCfg);
  const pick = (sel, cwd) => worktrees.parseSelector(sel, all, cwd).lanes.map((l) => l.lane);
  assert.deepEqual(pick(''), [1, 2, 3], 'empty means all');
  assert.deepEqual(pick('all'), [1, 2, 3]);
  assert.deepEqual(pick('2'), [2]);
  assert.deepEqual(pick('3,1'), [1, 3], 'normalised to lane order');
  assert.deepEqual(pick('1-2'), [1, 2]);
  assert.deepEqual(pick('demo-3'), [3], 'by name');
  assert.deepEqual(pick('.', join(lane2, 'src')), [2], 'a subdirectory still resolves');
  assert.deepEqual(worktrees.parseSelector('9,nope', all).unknown, ['nope', '9']);
});

// ── Dev services ────────────────────────────────────────────────────
const svcCfg = {
  ...wtCfg,
  dev: { services: [
    { name: 'web', command: 'echo web {port} in {worktree} && sleep 30', portBase: 300, url: 'http://localhost:{port}' },
    { name: 'api', cwd: 'src', command: 'echo api {port} && sleep 30', portBase: 400 },
    { name: 'broken' },
  ] },
};

test('ports concatenate base and lane, so services with close bases cannot collide', () => {
  // Surprising on purpose, and pinned here: base 300 lane 2 is 3002, not 302.
  assert.equal(sv.portFor(300, 2), '3002');
  assert.equal(sv.portFor(400, 2), '4002');
  assert.equal(sv.portFor(300, 10), '30010');
});

test('services resolve placeholders, cwd and their own port series', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[1]; // lane 2, demo-2
  const svcs = sv.resolveServices(svcCfg, lane);
  assert.deepEqual(svcs.map((s) => s.name), ['web', 'api'], 'a service with no command is skipped');
  assert.equal(svcs[0].port, '3002');
  assert.equal(svcs[1].port, '4002', 'each service has its own base');
  assert.match(svcs[0].command, /echo web 3002 in demo-2/);
  assert.equal(svcs[0].cwd, lane.path);
  assert.equal(svcs[1].cwd, join(lane.path, 'src'), 'cwd is relative to the worktree');
  assert.equal(svcs[0].url, 'http://localhost:3002');
});

test('service bookkeeping is keyed by worktree name, not lane number', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[2]; // lane 3, demo-3
  const [web] = sv.resolveServices(svcCfg, lane);
  assert.match(web.pidFile, /demo-demo-3-web\.pid$/, 'lane 3 does not appear in the key');
  assert.match(web.logFile, /demo-demo-3-web\.log$/);
});

test('a project with no dev.services declared resolves to none', () => {
  assert.deepEqual(sv.resolveServices(wtCfg, worktrees.enumerateLanes(wtCfg)[0]), []);
});

test('start records pid and port, and stop kills the whole process group', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[0];
  const [web] = sv.resolveServices(svcCfg, lane);

  const started = sv.start(web);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  assert.equal(sv.status(web).running, true);
  assert.equal(sv.status(web).port, '3001', 'the port it bound to is recorded, not recomputed');
  assert.equal(sv.start(web).already, true, 'starting twice is a no-op');

  // The `sleep` is a grandchild of the pid we track. Killing only the wrapper
  // shell would orphan it, which is the whole reason services spawn detached.
  const grandchildren = () => {
    try {
      return execFileSync('pgrep', ['-f', 'sleep 30'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  assert.ok(grandchildren().length > 0, 'the grandchild should be running');

  const stopped = sv.stop(web, { graceMs: 1500 });
  assert.equal(stopped.pid, started.pid);
  assert.equal(sv.status(web).running, false, 'the pid file is cleared');
  assert.equal(grandchildren().length, 0, 'no orphaned grandchild survived stop');
  assert.equal(sv.stop(web).notRunning, true);
});

// ── Lane colours ────────────────────────────────────────────────────
test('lane colours fall back to the built-in palette and cycle past its end', () => {
  const colorFor = laneColorFor({});
  assert.equal(colorFor(1), ansi(DEFAULT_PALETTE[0]));
  assert.equal(colorFor(DEFAULT_PALETTE.length + 1), ansi(DEFAULT_PALETTE[0]), 'cycles');
  assert.equal(colorFor(null), '', 'a lane-less row gets no colour');
});

test('lanes color persists per machine and overrides the default', () => {
  setColor(2, '832561');
  assert.equal(readColors()[2], '832561');
  assert.equal(laneColorFor()(2), ansi('832561'));
  setColor(1, '#42b883');
  assert.equal(readColors()[1], '42b883', 'a leading # is accepted and stripped');
  assert.equal(readColors()[2], '832561', 'setting one lane does not drop the others');
});

test('lanes color rejects junk instead of writing it', () => {
  assert.throws(() => setColor(1, 'nope'));
  assert.throws(() => setColor(0, '42b883'));
  assert.equal(readColors()[1], '42b883', 'the previous value survives a rejected write');
});

// ── The CLI, through the sh wrapper and through a symlink ───────────
// This path is invisible to module-level tests: a rename once left the wrapper
// exec'ing a file that no longer existed, and every other test still passed.
test('the sh wrapper resolves and runs the CLI', () => {
  const help = execFileSync(join(ROOT, 'bin', 'lanes'), { encoding: 'utf8' });
  // Assert on subcommands, not the tagline: the banner wording is cosmetic and
  // a test that fails on a reworded headline is noise.
  for (const sub of ['lanes list', 'lanes dev', 'lanes doctor', 'lanes reviewed']) {
    assert.ok(help.includes(sub), `help is missing ${sub}`);
  }
});

// The installer no longer symlinks the CLI (D16), but people symlink CLIs anyway.
// This is the property D10 buys: both paths must behave identically.
test('the wrapper resolves correctly when invoked through a symlink', () => {
  const linked = join(TMP, 'lanes');
  execFileSync('ln', ['-s', join(ROOT, 'bin', 'lanes'), linked]);
  assert.ok(execFileSync(linked, { encoding: 'utf8' }).includes('lanes doctor'));
});

test('lanes doctor warns (not blocks) when worktreesDir is missing but its parent exists', () => {
  const missingButHealable = join(TMP, 'doctor-healable');
  mkdirSync(missingButHealable);
  git(missingButHealable, 'init', '-q');
  mkdirSync(join(missingButHealable, '.claude'));
  writeFileSync(
    join(missingButHealable, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'doctor-healable', worktreesDir: join(missingButHealable, 'not-yet') }),
  );
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['doctor'], { cwd: missingButHealable, encoding: 'utf8' });
  assert.match(output, /worktrees\s+.*not-yet.*does not exist yet.*will create it/);
  assert.doesNotMatch(output, /does not exist, and neither does its parent/);
});

test('lanes doctor blocks when worktreesDir is missing and so is its parent', () => {
  const orphanParent = join(TMP, 'doctor-orphan');
  mkdirSync(orphanParent);
  git(orphanParent, 'init', '-q');
  mkdirSync(join(orphanParent, '.claude'));
  writeFileSync(
    join(orphanParent, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'doctor-orphan', worktreesDir: join(TMP, 'no-such-parent-dir', 'wts') }),
  );
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['doctor'], { cwd: orphanParent, encoding: 'utf8' });
  assert.match(output, /worktrees\s+.*does not exist, and neither does its parent/);
  assert.doesNotMatch(output, /will create it/);
});

test('lanes adopt writes a config a fresh repo can be verified against', () => {
  const fresh = join(TMP, 'fresh');
  mkdirSync(fresh);
  git(fresh, 'init', '-q');
  writeFileSync(join(fresh, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', build: 'vite build' } }));
  writeFileSync(join(fresh, 'pnpm-lock.yaml'), '');
  execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: fresh, encoding: 'utf8' });
  const cfg = JSON.parse(readFileSync(join(fresh, '.claude', 'agent-system.json'), 'utf8'));
  assert.equal(cfg.commands.lint, 'pnpm lint', 'package manager comes from the lockfile');
  assert.equal(cfg.commands.build, 'pnpm build');
  assert.equal(cfg.commands.typecheck, null, 'a script that does not exist stays null');
  assert.equal(cfg.worktreesDir, undefined, 'a single-worktree repo gets no lanes');
  assert.deepEqual(cfg.review.domainAxes, [], 'the one field a human must fill in');
});

test('lanes adopt refuses to clobber an existing config without --force', () => {
  assert.throws(() => execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: lane2, stdio: 'pipe' }));
});

const readEvents = () =>
  readFileSync(join(LANES_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('lanes new emits lane_created, and lanes rm emits lane_removed', () => {
  const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  execFileSync(join(ROOT, 'bin', 'lanes'), ['new', 'demo-4', '--branch', 'feat/999-lane-events', '--from', base], {
    cwd: repo,
    encoding: 'utf8',
  });
  const created = readEvents().findLast((e) => e.ev === 'lane_created' && e.worktree === 'demo-4');
  assert.ok(created, 'lanes new must emit lane_created');
  assert.equal(created.project, 'demo');
  assert.equal(typeof created.lane, 'number');
  assert.equal(created.branch, 'feat/999-lane-events');
  assert.equal(created.path, join(wtDir, 'demo-4'), 'path is what liveness checks rely on');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', 'demo-4'], { cwd: repo, encoding: 'utf8' });
  const removed = readEvents().findLast((e) => e.ev === 'lane_removed' && e.worktree === 'demo-4');
  assert.ok(removed, 'lanes rm must emit lane_removed');
  assert.equal(removed.project, 'demo');
  assert.equal(typeof removed.lane, 'number');
});

test('lanes new without --branch does not invent a branch name from the worktree name', () => {
  // A commit SHA, not the branch name: checking out `main` in a second worktree
  // while `repo` already has it checked out is refused by git. A raw SHA always
  // lands detached, which is the whole point of this no-`--branch` case.
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  execFileSync(join(ROOT, 'bin', 'lanes'), ['new', 'demo-5', '--from', base], { cwd: repo, encoding: 'utf8' });
  const created = readEvents().findLast((e) => e.ev === 'lane_created' && e.worktree === 'demo-5');
  assert.ok(created, 'lanes new must emit lane_created');
  assert.equal(created.branch, null, 'no --branch means a detached HEAD, not a fabricated branch name');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', 'demo-5'], { cwd: repo, encoding: 'utf8' });
});

test('emitWithContext fills path from ctx.worktreeRoot too, not just the two direct emit() calls in lanes new/rm', () => {
  execFileSync(join(ROOT, 'bin', 'lanes'), ['stage', 'implement', 'path propagation check'], {
    cwd: lane2,
    encoding: 'utf8',
  });
  const staged = readEvents().findLast((e) => e.ev === 'stage' && e.worktree === 'demo-2' && e.stage === 'implement');
  assert.ok(staged, 'lanes stage must emit a stage event');
  assert.equal(staged.path, lane2, 'emitWithContext must carry the real worktree root, same as the direct emit() calls');
  assert.ok(existsSync(staged.path), 'the recorded path must be a real, currently-existing directory');
});

test('lanes adopt writes an auto-detected worktreesDir to the local override, never the committed config', () => {
  const parent = join(TMP, 'adopt-siblings');
  mkdirSync(parent);
  const src = join(parent, 'adopt-src');
  mkdirSync(src);
  git(src, 'init', '-q');
  git(src, 'config', 'user.email', 'test@test.test');
  git(src, 'config', 'user.name', 'test');
  writeFileSync(join(src, 'f.txt'), 'x');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  writeFileSync(join(src, '.gitignore'), 'node_modules/\n');
  git(src, 'worktree', 'add', '-q', join(parent, 'adopt-src-2'), '-b', 'adopt-sibling');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: src, encoding: 'utf8' });

  const cfg = JSON.parse(readFileSync(join(src, '.claude', 'agent-system.json'), 'utf8'));
  assert.equal(cfg.worktreesDir, undefined, 'never written into the committed config');
  assert.equal(cfg.basePort, undefined, 'basePort is per-machine too — same as worktreesDir (D22)');
  assert.deepEqual(
    readLocalOverride(src),
    { worktreesDir: parent, basePort: 300 },
    'both go to the local override instead',
  );

  const gitignore = readFileSync(join(src, '.gitignore'), 'utf8');
  assert.ok(gitignore.includes('.claude/agent-system.local.json'), 'adopt appends the ignore entry');
});

test('lanes adopt appends the .gitignore entry once, and does nothing when there is no .gitignore', () => {
  const noIgnore = join(TMP, 'adopt-no-gitignore');
  mkdirSync(noIgnore);
  git(noIgnore, 'init', '-q');
  execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: noIgnore, encoding: 'utf8' });
  assert.equal(existsSync(join(noIgnore, '.gitignore')), false, 'adopt never creates one from scratch');

  const withIgnore = join(TMP, 'adopt-dup-gitignore');
  mkdirSync(withIgnore);
  git(withIgnore, 'init', '-q');
  writeFileSync(join(withIgnore, '.gitignore'), '.claude/agent-system.local.json\n');
  execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: withIgnore, encoding: 'utf8' });
  const occurrences = readFileSync(join(withIgnore, '.gitignore'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() === '.claude/agent-system.local.json');
  assert.equal(occurrences.length, 1, 'does not duplicate an entry that is already there');
});

test('lanes adopt warns instead of falsely claiming "not committed" when there is no .gitignore to append to', () => {
  const parent = join(TMP, 'adopt-siblings-no-ignore');
  mkdirSync(parent);
  const src = join(parent, 'adopt-src');
  mkdirSync(src);
  git(src, 'init', '-q');
  git(src, 'config', 'user.email', 'test@test.test');
  git(src, 'config', 'user.name', 'test');
  writeFileSync(join(src, 'f.txt'), 'x');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  // Deliberately no .gitignore, unlike the sibling-detection test above.
  git(src, 'worktree', 'add', '-q', join(parent, 'adopt-src-2'), '-b', 'adopt-sibling-no-ignore');

  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: src, encoding: 'utf8' });
  assert.deepEqual(
    readLocalOverride(src),
    { worktreesDir: parent, basePort: 300 },
    'the override is written regardless',
  );
  assert.match(output, /not gitignored here/, 'warns rather than staying silent about the risk');
  assert.doesNotMatch(output, /not committed/, 'must not claim a guarantee it cannot back up');
});

test('lanes worktrees-dir sets a local override and reports its source, distinct from the committed default', () => {
  const main = join(TMP, 'wtd-main');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@test.test');
  git(main, 'config', 'user.name', 'test');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'wtd-main', worktreesDir: join(TMP, 'wtd-committed') }),
  );
  writeFileSync(join(main, 'f.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');

  const before = execFileSync(join(ROOT, 'bin', 'lanes'), ['worktrees-dir'], { cwd: main, encoding: 'utf8' });
  assert.ok(before.includes('wtd-committed') && before.includes('committed default'));

  const target = join(TMP, 'wtd-override');
  const setOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['worktrees-dir', target], { cwd: main, encoding: 'utf8' });
  assert.equal(existsSync(target), true, 'creates it, same parent-must-exist boundary as planCreate (D21)');
  assert.deepEqual(readLocalOverride(main), { worktreesDir: target });
  // No .gitignore in this fixture — the centralised guard (rc-1) must warn here
  // too, not just from `adopt`.
  assert.match(setOut, /not gitignored here/);

  const after = execFileSync(join(ROOT, 'bin', 'lanes'), ['worktrees-dir'], { cwd: main, encoding: 'utf8' });
  assert.ok(after.includes(target) && after.includes('local override'), 'now reports the override, not the committed value');

  const doctorOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['doctor'], { cwd: main, encoding: 'utf8' });
  assert.match(doctorOut, /worktrees\s+.*local override/);

  // Same D21 boundary planCreate enforces: refuse a mistyped path rather than
  // silently materializing an arbitrary directory tree.
  const orphan = join(TMP, 'no-such-parent-wtd', 'wts');
  assert.throws(() => execFileSync(join(ROOT, 'bin', 'lanes'), ['worktrees-dir', orphan], { cwd: main, stdio: 'pipe' }));
  assert.equal(existsSync(orphan), false);

  // The override is set from the MAIN worktree; resolving it from a subdirectory
  // of that same worktree must not climb outside the repo (the mainWorktreeRoot bug).
  mkdirSync(join(main, 'sub'));
  const fromSubdir = execFileSync(join(ROOT, 'bin', 'lanes'), ['worktrees-dir'], { cwd: join(main, 'sub'), encoding: 'utf8' });
  assert.ok(fromSubdir.includes(target) && fromSubdir.includes('local override'));
});

test('lanes worktrees-dir reports "not configured" when neither a committed default nor a local override exists', () => {
  const fresh = join(TMP, 'wtd-none');
  mkdirSync(fresh);
  git(fresh, 'init', '-q');
  execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: fresh, encoding: 'utf8' });
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['worktrees-dir'], { cwd: fresh, encoding: 'utf8' });
  assert.match(output, /not configured/, 'a repo with no worktrees convention at all gets its own message');
  assert.doesNotMatch(output, /committed default|local override/);
});

test('lanes base-port sets a local override and reports its source, distinct from the committed default', () => {
  const main = join(TMP, 'bp-main');
  mkdirSync(main);
  git(main, 'init', '-q');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'bp-main', basePort: 300 }),
  );

  const before = execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port'], { cwd: main, encoding: 'utf8' });
  assert.ok(before.includes('300') && before.includes('committed default'));

  execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port', '400'], { cwd: main, encoding: 'utf8' });
  assert.deepEqual(readLocalOverride(main), { basePort: 400 });

  const after = execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port'], { cwd: main, encoding: 'utf8' });
  assert.ok(after.includes('400') && after.includes('local override'), 'now reports the override, not the committed value');

  const doctorOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['doctor'], { cwd: main, encoding: 'utf8' });
  assert.match(doctorOut, /basePort\s+.*local override/);

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port', 'not-a-number'], { cwd: main, stdio: 'pipe' }),
    /prefix, not a port/,
  );
  // A port typed by mistake (e.g. 8080) would concatenate with the lane number
  // into something out of range — rejected before it ever reaches a service.
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port', '8080'], { cwd: main, stdio: 'pipe' }),
    /prefix, not a port/,
  );
  assert.equal(readLocalOverride(main).basePort, 400, 'the rejected value must not have overwritten the good one');
});

test('lanes base-port reports "not configured" when neither a committed default nor a local override exists', () => {
  const fresh = join(TMP, 'bp-none');
  mkdirSync(fresh);
  git(fresh, 'init', '-q');
  execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: fresh, encoding: 'utf8' });
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port'], { cwd: fresh, encoding: 'utf8' });
  assert.match(output, /not configured/);
  assert.doesNotMatch(output, /committed default|local override/);
});

test('findProject: a local servicePortBase override applies to the matching dev.services[] entry only', () => {
  const main = join(TMP, 'merge-serviceport');
  mkdirSync(main);
  git(main, 'init', '-q');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({
      project: 'merge-serviceport',
      dev: { services: [{ name: 'web', command: 'x', portBase: 300 }, { name: 'api', command: 'y', portBase: 400 }] },
    }),
  );
  writeLocalOverride(main, { servicePortBase: { api: 450 } });

  const services = findProject(main).config.dev.services;
  assert.equal(services.find((s) => s.name === 'web').portBase, 300, 'untouched — no override for this name');
  assert.equal(services.find((s) => s.name === 'api').portBase, 450, 'overridden by name');
});

test('lanes service-port lists declared services with their source, and sets a per-service override', () => {
  const main = join(TMP, 'sp-main');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@test.test');
  git(main, 'config', 'user.name', 'test');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({
      project: 'sp-main',
      dev: { services: [{ name: 'web', command: 'x', portBase: 300 }, { name: 'api', command: 'y', portBase: 400 }] },
    }),
  );
  writeFileSync(join(main, 'f.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');

  const before = execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port'], { cwd: main, encoding: 'utf8' });
  assert.match(before, /web\s+300\s+.*committed default/);
  assert.match(before, /api\s+400\s+.*committed default/);

  execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port', 'api', '450'], { cwd: main, encoding: 'utf8' });
  assert.deepEqual(readLocalOverride(main), { servicePortBase: { api: 450 } });

  const after = execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port'], { cwd: main, encoding: 'utf8' });
  assert.match(after, /web\s+300\s+.*committed default/, 'web is untouched');
  assert.match(after, /api\s+450\s+.*local override/, 'api now reports the override');

  const doctorOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['doctor'], { cwd: main, encoding: 'utf8' });
  assert.match(doctorOut, /service ports\s+2 declared, 1 local override/);

  // A typo'd service name still writes (it's just a JSON key, and the service
  // might be declared later) but warns instead of pretending it matched.
  const typo = execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port', 'wbe', '350'], { cwd: main, encoding: 'utf8' });
  assert.match(typo, /no dev\.services entry named "wbe"/);
  assert.equal(readLocalOverride(main).servicePortBase.wbe, 350);

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port', 'api', '8080'], { cwd: main, stdio: 'pipe' }),
    /prefix, not a port/,
  );
});

test('lanes service-port reports nothing declared when the project has no dev.services', () => {
  const fresh = join(TMP, 'sp-none');
  mkdirSync(fresh);
  git(fresh, 'init', '-q');
  execFileSync(join(ROOT, 'bin', 'lanes'), ['adopt'], { cwd: fresh, encoding: 'utf8' });
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port'], { cwd: fresh, encoding: 'utf8' });
  assert.match(output, /no dev\.services declared/);
});

test('lanes service-port dies with a usage message when a name is given but no port', () => {
  const main = join(TMP, 'sp-missing-n');
  mkdirSync(main);
  git(main, 'init', '-q');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({
      project: 'sp-missing-n',
      dev: { services: [{ name: 'web', command: 'x', portBase: 300 }] },
    }),
  );
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port', 'web'], { cwd: main, stdio: 'pipe' }),
    /Usage: lanes service-port <name> <n>/,
    'a bare name alone must not be read as "list", only no args at all does that',
  );
  assert.equal(readLocalOverride(main).servicePortBase, undefined, 'nothing written on the usage error');
});

// isGitignored/ensureIgnored were centralised into local-config.mjs so every
// writer (adopt, worktrees-dir, base-port, service-port) warns consistently —
// the tests above only ever exercise the "not protected, so warn" branch; this
// covers the exact-match rule itself, and the "already protected, stay silent"
// branch across all three per-machine `lanes` setters.
test('isGitignored matches the entry as a whole trimmed line, not a substring or a missing file', () => {
  const fresh = join(TMP, 'ig-unit');
  mkdirSync(fresh);
  git(fresh, 'init', '-q');
  assert.equal(isGitignored(fresh), false, 'no .gitignore at all');

  writeFileSync(join(fresh, '.gitignore'), 'node_modules/\n');
  assert.equal(isGitignored(fresh), false, '.gitignore exists but lacks the entry');

  writeFileSync(join(fresh, '.gitignore'), '#.claude/agent-system.local.json\n');
  assert.equal(isGitignored(fresh), false, 'commented out is not protection');

  writeFileSync(join(fresh, '.gitignore'), 'node_modules/\n  .claude/agent-system.local.json  \n');
  assert.equal(isGitignored(fresh), true, 'exact line present, surrounding whitespace trimmed');
});

test('warnIfNotIgnored stays silent once the entry is already protected — worktrees-dir, base-port and service-port alike', () => {
  const main = join(TMP, 'already-ignored');
  mkdirSync(main);
  git(main, 'init', '-q');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({ project: 'already-ignored', dev: { services: [{ name: 'web', command: 'x' }] } }),
  );
  // Pre-existing, correct .gitignore — not one `lanes` wrote itself, so this
  // proves the read side (isGitignored), not just ensureIgnored's own append.
  writeFileSync(join(main, '.gitignore'), '.claude/agent-system.local.json\n');

  const wtdOut = execFileSync(
    join(ROOT, 'bin', 'lanes'),
    ['worktrees-dir', join(TMP, 'already-ignored-wt')],
    { cwd: main, encoding: 'utf8' },
  );
  assert.doesNotMatch(wtdOut, /not gitignored here/);

  const bpOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port', '500'], { cwd: main, encoding: 'utf8' });
  assert.doesNotMatch(bpOut, /not gitignored here/);

  const spOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port', 'web', '550'], {
    cwd: main,
    encoding: 'utf8',
  });
  assert.doesNotMatch(spOut, /not gitignored here/);
});

test('base-port and service-port accept the cap itself (999) and reject one past it (1000)', () => {
  const main = join(TMP, 'bp-boundary');
  mkdirSync(main);
  git(main, 'init', '-q');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'agent-system.json'),
    JSON.stringify({
      project: 'bp-boundary',
      dev: { services: [{ name: 'web', command: 'x' }] },
    }),
  );

  execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port', '999'], { cwd: main, encoding: 'utf8' });
  assert.equal(readLocalOverride(main).basePort, 999, 'the cap itself is a valid prefix, not off-by-one excluded');

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['base-port', '1000'], { cwd: main, stdio: 'pipe' }),
    /prefix, not a port/,
  );
  assert.equal(readLocalOverride(main).basePort, 999, 'the rejected value must not overwrite the good one');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port', 'web', '999'], { cwd: main, encoding: 'utf8' });
  assert.equal(readLocalOverride(main).servicePortBase.web, 999);
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['service-port', 'web', '1000'], { cwd: main, stdio: 'pipe' }),
    /prefix, not a port/,
  );
});

test('the suite writes its events inside the sandbox, not the real home', () => {
  assert.ok(LANES_DIR.startsWith(TMP), `event log escaped the sandbox: ${LANES_DIR}`);
  // The guard tests above emit real events; prove they landed here.
  assert.match(readFileSync(join(LANES_DIR, 'events.jsonl'), 'utf8'), /"ev":"commit_blocked"/);
});

// ── Run ─────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`\x1b[32m ok \x1b[0m ${name}\n`);
  } catch (err) {
    failed += 1;
    // Print the whole message, indented. A truncated assertion message is a
    // test harness that makes you re-debug what it already knew.
    const detail = String(err.message).split('\n').map((l) => `      ${l}`).join('\n');
    process.stdout.write(`\x1b[31mFAIL\x1b[0m ${name}\n${detail}\n`);
  }
}

rmSync(TMP, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
