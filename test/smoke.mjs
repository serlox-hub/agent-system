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

const { resolveContext, issueFromBranch, resolveLane, findProject, LANES_DIR, emit } =
  await import(`${ROOT}/lib/context.mjs`);
const { mainWorktreeRoot, readLocalOverride, writeLocalOverride, isGitignored } = await import(
  `${ROOT}/lib/local-config.mjs`
);
const { diffFingerprint, changedLineCount, writeMark, readMark, REVIEW_MARK } = await import(`${ROOT}/lib/marks.mjs`);
const { createState, applyEvents, render, notifyTitle, fmtTokens } = await import(`${ROOT}/ui/dashboard.mjs`);
const { readContext } = await import(`${ROOT}/lib/transcript.mjs`);
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
  git(repo, 'worktree', 'add', '-q', join(wtDir, `lane${n}`), '-b', `feat/${400 + n}-thing`);
}
const lane2 = join(wtDir, 'lane2');

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

test('resolveLane parses the lane number straight out of the lane<N> directory name (D26)', () => {
  // No filesystem read and no worktreesDir dependency at all — the number is
  // baked into the name at creation time, so a nonexistent path still parses,
  // and a missing/empty config changes nothing.
  assert.equal(resolveLane(join(wtDir, 'lane1'), {}).lane, 1);
  assert.equal(resolveLane('/nowhere/lane13', {}).lane, 13, 'no lexicographic-vs-numeric confusion past lane9');
  assert.equal(resolveLane(join(wtDir, 'lane2'), { worktreesDir: wtDir }).lane, 2, 'config is accepted but unused');
  assert.equal(resolveLane(join(wtDir, 'not-a-lane'), {}).lane, null, 'a non-conforming directory name is not a lane');
  assert.equal(resolveLane('', {}).lane, null);
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
  assert.equal(ctx.worktree, 'lane2');
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

test('staging a reviewed change must not change its fingerprint — git add alone is not an edit', () => {
  // The regression this guards: the fingerprint used to be built from
  // `git diff --cached` + `git diff` concatenated in that order, so the same
  // edit's text moved from the second slot to the first the moment it was
  // staged — changing the fingerprint for a diff that had not actually
  // changed, and blocking a commit right after /gate had just reviewed it.
  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const g = 7;\n');
  writeFileSync(join(lane2, 'src', 'also-new.ts'), 'export const h = 8;\n');
  const unstaged = diffFingerprint(lane2);
  git(lane2, 'add', 'src/a.ts', 'src/also-new.ts');
  assert.equal(diffFingerprint(lane2), unstaged, 'git add must be a no-op for the fingerprint');
});

test('deleting a tracked file produces the same fingerprint staged or not', () => {
  git(lane2, 'add', 'src/a.ts', 'src/also-new.ts');
  git(lane2, 'commit', '-m', 'seed for delete test');
  rmSync(join(lane2, 'src', 'also-new.ts'));
  const unstaged = diffFingerprint(lane2);
  git(lane2, 'add', '-A');
  assert.equal(diffFingerprint(lane2), unstaged, 'a staged deletion must fingerprint the same as an unstaged one');
});

test('a staged delete-and-recreate-elsewhere (the shape git\'s default rename detection pairs up) must not hide the deletion, even when the new path was already reviewed as a plain addition', () => {
  writeFileSync(join(lane2, 'src', 'rename-src.ts'), 'export const same = 123;\n');
  git(lane2, 'add', 'src/rename-src.ts');
  git(lane2, 'commit', '-m', 'seed rename-src');

  // "Reviewed" state: rename-src.ts untouched, only an unrelated-looking
  // addition with the exact same content sitting at a new path.
  writeFileSync(join(lane2, 'src', 'rename-dst.ts'), 'export const same = 123;\n');
  const reviewedFp = diffFingerprint(lane2);
  writeMark(lane2, REVIEW_MARK, reviewedFp);

  // Now actually delete rename-src.ts too. Identical content reappearing at a
  // new path, with the old path gone, is exactly what `git diff --name-status`
  // collapses into a single `R100 old new` record by default — the collapse
  // `--no-renames` exists to prevent.
  rmSync(join(lane2, 'src', 'rename-src.ts'));
  const unstagedFp = diffFingerprint(lane2);
  assert.notEqual(unstagedFp, reviewedFp, 'the unreviewed deletion must invalidate the mark, unstaged');

  git(lane2, 'add', '-A');
  const stagedFp = diffFingerprint(lane2);
  assert.equal(stagedFp, unstagedFp, 'staging the rename-shaped pair must not itself change the fingerprint');
  assert.notEqual(
    stagedFp, reviewedFp,
    'and the deletion must still invalidate the mark once staged — not be hidden by rename pairing',
  );
});

test('a unicode filename\'s edits keep changing the fingerprint — core.quotePath must not freeze it as a constant "unreadable"', () => {
  // Untracked, exercised via `git ls-files -z --others`: without -z the quoted,
  // octal-escaped name that `core.quotePath` produces fails `git hash-object`
  // and used to fall back to the fixed string 'unreadable' for every edit.
  const p = join(lane2, 'src', 'café.ts');
  writeFileSync(p, 'export const a = 1;\n');
  const untrackedFirst = diffFingerprint(lane2);
  appendFileSync(p, 'export const b = 2;\n');
  const untrackedSecond = diffFingerprint(lane2);
  assert.notEqual(untrackedSecond, untrackedFirst, 'a second edit to an untracked unicode-named file must still change the fingerprint');

  // Tracked and modified, exercised via `git diff -z --name-status`: same
  // quoting problem, different git call.
  git(lane2, 'add', '-A');
  git(lane2, 'commit', '-m', 'seed unicode file');
  appendFileSync(p, 'export const c = 3;\n');
  const trackedFirst = diffFingerprint(lane2);
  appendFileSync(p, 'export const d = 4;\n');
  const trackedSecond = diffFingerprint(lane2);
  assert.notEqual(trackedSecond, trackedFirst, 'a second edit to a tracked unicode-named file must still change the fingerprint too');
});

test('an unborn-HEAD repo (no commits yet) fingerprints what is actually staged, not a constant', () => {
  const unborn = join(TMP, 'unborn');
  mkdirSync(unborn);
  git(unborn, 'init', '-q');
  const empty = diffFingerprint(unborn);

  writeFileSync(join(unborn, 'x.ts'), 'export const x = 1;\n');
  const withUntracked = diffFingerprint(unborn);
  assert.notEqual(withUntracked, empty, 'a brand-new untracked file must change the fingerprint before any commit exists');

  git(unborn, 'add', 'x.ts');
  const staged = diffFingerprint(unborn);
  assert.equal(staged, withUntracked, 'staging must be a no-op here too, same invariant as in a repo with commits');

  writeFileSync(join(unborn, 'y.ts'), 'export const y = 2;\n');
  const withSecondFile = diffFingerprint(unborn);
  assert.notEqual(
    withSecondFile, staged,
    'a second staged file must further change the fingerprint — not stuck at a constant just because HEAD is unborn',
  );
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

test('the guard blocks a commit under every way a shell can quote it, matching what actually runs', () => {
  assert.equal(guard(lane2, 'git "commit" -m wip'), 'deny', 'whole token wrapped');
  assert.equal(guard(lane2, "git 'commit' -m wip"), 'deny', 'whole token wrapped, single-quoted');
  assert.equal(guard(lane2, 'git com"mit" -m wip'), 'deny', 'quote mid-word');
  assert.equal(guard(lane2, 'git commit"" -m wip'), 'deny', 'empty quoted span appended');
  assert.equal(guard(lane2, 'git ""commit -m wip'), 'deny', 'empty quoted span prepended');
  assert.equal(guard(lane2, 'git -C "my dir" commit -m wip'), 'deny', 'quoted -C value with a space, no evasion intended');
});

test('the guard resolves nested and quoted-away edge cases the same way a real shell would', () => {
  assert.equal(
    guard(lane2, 'git -c "user.name=O\'Brien" commit -m wip'),
    'deny',
    'a single quote nested inside a double-quoted value is literal, not a token break, so -c still consumes exactly one value and commit lands where expected',
  );
  assert.equal(
    guard(lane2, "git -c 'msg=\"hi there\"' commit -m wip"),
    'deny',
    'a double quote nested inside a single-quoted value is literal too',
  );
  assert.equal(
    guard(lane2, 'git -C "" commit -m wip'),
    'deny',
    'an explicitly empty quoted value is still a real token, not a dropped one, so -C still consumes exactly one and commit is not miscounted past',
  );
  assert.equal(
    guard(lane2, 'git "-C" "my dir" commit -m wip'),
    'deny',
    'a quoted option name unquotes to the same bare -C a real shell would produce, so it is still recognised as value-taking',
  );
  assert.equal(
    guard(lane2, 'git commit -m "wip'),
    'deny',
    'an unterminated quote that only swallows the trailing argument must not hang or misfire',
  );
});

test('the guard does not fire on git commands that merely mention commit', () => {
  assert.equal(guard(lane2, 'git log --grep commit'), 'allow');
  assert.equal(guard(lane2, 'git commit-tree abc'), 'allow');
  assert.equal(guard(lane2, 'echo "commit later"'), 'allow');
  assert.equal(guard(lane2, 'echo "run git commit later"'), 'allow', 'a quoted phrase is one argument to echo, not four bare words');
  assert.equal(guard(lane2, 'echo "git commit"'), 'allow');
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
const ev = (ts, e, extra = {}) => ({ ts, ev: e, project: 'demo', lane: 1, worktree: 'lane1', ...extra });

test('applyEvents keeps only the latest state per lane', () => {
  const s = applyEvents(createState(), [ev(1, 'session_start'), ev(2, 'agent_start', { agent: 'code-reviewer' })]);
  assert.equal(s.lanes.size, 1);
  assert.equal(s.lanes.get('demo#lane1').ev, 'agent_start');
  assert.equal(s.lanes.get('demo#lane1').agent, 'code-reviewer');
});

test('agent_end clears the running agent; busy is kept out of history', () => {
  const s = applyEvents(createState(), [
    ev(1, 'agent_start', { agent: 'test-writer' }),
    ev(2, 'agent_end'),
    ev(3, 'busy'),
  ]);
  assert.equal(s.lanes.get('demo#lane1').agent, null);
  assert.equal(s.history.length, 2, 'busy is noise, it fires on every message');
});

test('lane_removed deletes the lane outright, so a same-named lane never inherits its state', () => {
  const s = applyEvents(createState(), [
    ev(1, 'session_start', { issue: '402' }),
    ev(2, 'stage', { stage: 'review' }),
    ev(3, 'lane_removed'),
  ]);
  assert.equal(s.lanes.has('demo#lane1'), false, 'the removed lane must leave no trace to inherit from');

  const recreated = applyEvents(s, [ev(4, 'lane_created', { branch: 'feat/999-other' })]);
  const row = recreated.lanes.get('demo#lane1');
  assert.equal(row.issue, undefined, 'a fresh lane must not inherit the old occupant\'s issue');
  assert.equal(row.stage, undefined, 'nor its stage');
  assert.equal(row.branch, 'feat/999-other');
});

test('lane_reset is treated like lane_created — the row starts fresh instead of keeping the finished task\'s state', () => {
  const s = applyEvents(createState(), [
    ev(1, 'session_start', { issue: '402' }),
    ev(2, 'stage', { stage: 'gate' }),
    ev(3, 'idle'),
  ]);
  const before = s.lanes.get('demo#lane1');
  assert.equal(before.stage, 'gate');
  assert.equal(before.ev, 'idle');

  const reset = applyEvents(s, [ev(4, 'lane_reset')]);
  const row = reset.lanes.get('demo#lane1');
  assert.equal(row.issue, undefined, 'a reset lane must not keep the finished task\'s issue');
  assert.equal(row.stage, undefined, 'nor its stage');
  assert.equal(row.ev, 'lane_reset', 'the row itself reflects the reset, not the last session event');
});

test('applyEvents is incremental — folding twice equals folding once', () => {
  const events = [ev(1, 'session_start'), ev(2, 'stage', { stage: 'review' })];
  const once = applyEvents(createState(), events);
  const twice = applyEvents(applyEvents(createState(), [events[0]]), [events[1]]);
  assert.deepEqual(twice.lanes.get('demo#lane1'), once.lanes.get('demo#lane1'));
});

test('a stage event is a milestone, not a liveness signal — it must not overwrite the lane state', () => {
  const onlyStage = applyEvents(createState(), [ev(1, 'stage', { stage: 'implement' })]);
  const row = onlyStage.lanes.get('demo#lane1');
  assert.equal(row.ev, null, 'no session/agent event was ever seen for this lane');
  assert.equal(row.stage, 'implement');

  const withSession = applyEvents(createState(), [ev(1, 'session_start'), ev(2, 'stage', { stage: 'review' })]);
  const row2 = withSession.lanes.get('demo#lane1');
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
  assert.ok(frame.includes('lane2'), 'declared lanes appear even with no events of their own');
});

test('render shows a declared lane with no events at all as offline', () => {
  const frame = render(resolveContext(lane2), createState());
  assert.ok(frame.includes('lane3'));
  assert.ok(frame.includes('offline'));
});

test('MARKS renders ? when the base ref cannot be resolved — never free, never a bare —', () => {
  // The fixture repo has no `origin` remote, so `enumerateLanes` can never
  // resolve `origin/main...HEAD` — every lane's baseKnown is false.
  const frame = render(resolveContext(lane2), createState());
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.includes('lane3'));
  assert.ok(row, 'lane3 must have a row');
  // Column order: # (3) WORKTREE (20) BRANCH (40) MARKS (12) ...
  const marks = row.slice(3 + 20 + 40, 3 + 20 + 40 + 12).trim();
  assert.equal(marks, '?', 'unknown divergence must render as ?, distinct from both free and —');
});

test('MARKS renders dirty, ahead and behind together through the laneInfo seam, without shifting ISSUE', () => {
  // Fabricated laneInfo, bypassing the real `enumerateLanes` git read — this
  // is the only way to exercise the coloured, non-"?" formatting path, since
  // the fixture repo (no `origin`) always makes the real read baseKnown: false.
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/9-x',
    isBase: false, dirty: true, dirtyCount: 3, ahead: 2, behind: 1, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.includes('lane1') && !l.includes('lane10'));
  assert.ok(row, 'lane1 must have a row');
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
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'main',
    isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.includes('lane1') && !l.includes('lane10'));
  const marks = row.slice(3 + 20 + 40, 3 + 20 + 40 + 12).trim();
  assert.equal(marks, 'free', 'clean and on base, with a resolvable base ref, must render free — never ?');
});

test('rowsFor clears a stale issue once the branch is read and encodes none, rather than keeping an event-log leftover', () => {
  const state = applyEvents(createState(), [ev(1, 'session_start', { issue: '402' })]);
  // The branch read succeeded and the lane is back on `main` — no issue
  // number in it, which must win over the stale '402' from the event log.
  const backOnBase = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'main',
    isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), state, Date.now(), backOnBase);
  const row = frame.split('\n').find((l) => l.includes('lane1') && !l.includes('lane10'));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(!row.includes('#402'), 'a resolved branch with no issue in it must clear the stale one, not keep displaying it');
});

test('rowsFor keeps the last known issue when the branch read itself fails', () => {
  const state = applyEvents(createState(), [ev(1, 'session_start', { issue: '402' })]);
  // `branch: null` is how a failed git read is represented — must not be
  // treated the same as a successful read that found no issue in the branch.
  const failedRead = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: null,
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: false,
  }];
  const frame = render(resolveContext(lane2), state, Date.now(), failedRead);
  const row = frame.split('\n').find((l) => l.includes('lane1') && !l.includes('lane10'));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('#402'), 'a failed branch read must not blank a previously known issue');
});

test('notifyTitle falls back to worktree, never to an unidentified "lane ?"', () => {
  assert.equal(notifyTitle(ev(1, 'idle', { lane: null, issue: '12' })), 'demo · lane1 · #12');
  assert.equal(notifyTitle(ev(1, 'idle')), 'demo · lane 1');
});

test('RECENT rows fall back to worktree too — a lane-less event must still say which one', () => {
  const frame = render(
    resolveContext(lane2),
    applyEvents(createState(), [ev(1, 'idle', { lane: null, worktree: 'lane7' })]),
  );
  assert.ok(frame.includes('lane7'), 'the worktree name must appear somewhere, not just a bare "·"');
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
  state.lanes.set('demo#lane1', {
    project: 'demo', worktree: 'lane1', ev: 'idle', since: 1,
    // A path left over from before a rename, say — must never be consulted:
    // declared lanes are matched by name against the live directory listing,
    // not verified against a path recorded in a past event.
    path: join(wtDir, 'lane1-stale-path-from-before-a-rename'),
  });
  const frame = render(resolveContext(lane2), state);
  const row = frame.split('\n').find((l) => l.includes('lane1') && !l.includes('lane10'));
  assert.ok(row, 'lane1 must still get a row');
  assert.ok(row.includes('waiting for you'), 'a declared lane must keep its real state regardless of a stale path');
  assert.ok(!row.includes('offline'), 'it must not fall back to the no-events default either');
});

// ── Lane lifecycle ──────────────────────────────────────────────────
const wtCfg = { project: 'demo', worktreesDir: wtDir, basePort: 300, branch: { base: 'main' } };

test('enumerateLanes reports branch, dirty state and position', () => {
  const all = worktrees.enumerateLanes(wtCfg);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((l) => l.name), ['lane1', 'lane2', 'lane3']);
  assert.equal(all[1].lane, 2);
  assert.equal(all[1].branch, 'feat/402-thing');
  assert.equal(all[1].dirty, true, 'earlier tests left changes in lane2');
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
  const row = output.split('\n').find((l) => l.includes('lane2'));
  assert.ok(row, 'lane2 must have a row');
  assert.match(row, /~\d+/, 'lane2 has real uncommitted changes from earlier tests, so ~N must still show in `lanes list`');
  assert.match(
    output,
    /\? = origin\/main could not be resolved/,
    'the legend must document the ? token, alongside the pre-existing ~n/+n/-n/svc! ones',
  );
});

test('planCreate picks max(existing lane numbers) + 1, never a plain count — a gap does not get backfilled', () => {
  const gappedDir = join(TMP, 'gapped-wts');
  mkdirSync(join(gappedDir, 'lane1'), { recursive: true });
  mkdirSync(join(gappedDir, 'lane3'), { recursive: true }); // lane2 missing — a partial hand-migration
  const plan = worktrees.planCreate({ worktreesDir: gappedDir });
  assert.equal(plan.lane, 4, 'max(1,3)+1 = 4, not count(2)+1 = 3');
  assert.equal(plan.path, join(gappedDir, 'lane4'));
});

test('planCreate starts at lane1 in an empty worktreesDir, and continues past real lanes otherwise', () => {
  const emptyDir = join(TMP, 'empty-wts');
  mkdirSync(emptyDir);
  assert.equal(worktrees.planCreate({ worktreesDir: emptyDir }).lane, 1);
  assert.equal(worktrees.planCreate(wtCfg).lane, 4, 'wtCfg already has lane1..lane3');
});

test('planCreate refuses when the computed path already exists', () => {
  const clashDir = join(TMP, 'clash-wts');
  mkdirSync(join(clashDir, 'lane1'), { recursive: true });
  // Not a real lane directory — laneNames only counts directories matching
  // lane<N>, so this file is invisible to the max() scan yet still occupies
  // exactly the path max()+1 would compute.
  writeFileSync(join(clashDir, 'lane2'), 'not a worktree');
  assert.match(worktrees.planCreate({ worktreesDir: clashDir }).error, /already exists/);
});

test('planCreate creates worktreesDir itself when configured but missing', () => {
  const freshDir = join(TMP, 'fresh-wts');
  assert.equal(existsSync(freshDir), false, 'precondition: not created yet');
  const plan = worktrees.planCreate({ worktreesDir: freshDir });
  assert.equal(plan.error, undefined);
  assert.equal(existsSync(freshDir), true);
  assert.equal(plan.createdDir, freshDir);
  assert.equal(plan.lane, 1);
  assert.equal(plan.path, join(freshDir, 'lane1'));

  const again = worktrees.planCreate({ worktreesDir: freshDir });
  assert.equal(again.createdDir, null, 'does not report a re-creation once the dir exists');
  assert.equal(again.lane, 1, 'planCreate only proposes a path — it never creates the worktree itself, so nothing changed on disk');
});

test('planCreate refuses when worktreesDir was never configured', () => {
  assert.match(worktrees.planCreate({}).error, /not configured/);
});

test('planCreate refuses to create worktreesDir when its parent is also missing', () => {
  const orphan = join(TMP, 'no-such-parent', 'wts');
  const plan = worktrees.planCreate({ worktreesDir: orphan });
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
  assert.deepEqual(pick('lane3'), [3], 'by name');
  assert.deepEqual(pick(','), [], 'a selector of only separators matches nothing, but is not "unknown" — callers needing exactly one lane must check the count themselves');
  assert.deepEqual(pick('.', join(lane2, 'src')), [2], 'a subdirectory still resolves');
  assert.deepEqual(worktrees.parseSelector('9,nope', all).unknown, ['nope', '9']);
});

// ── Lane lifecycle (#5): removeWorktree's contiguous-suffix/running-service
// blockers and resetLane need real git (fetch, checkout --detach, branch -d)
// against a real remote, which the shared repo/wtDir fixture deliberately
// does not have (see the MARKS '?' test above). Each test below gets its own
// throwaway repo, bare origin and N lanes, each detached at origin/main —
// the exact state `lanes new` itself produces — so removals in one test can
// never leave stale state for another.
function makeLanesFixture(name, laneCount = 1) {
  const main = join(TMP, `lc-${name}`);
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'test@test.test');
  git(main, 'config', 'user.name', 'test');
  writeFileSync(join(main, 'f.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  const origin = join(TMP, `lc-${name}-origin.git`);
  git(TMP, 'init', '-q', '--bare', origin);
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', 'origin', 'main');
  const wtd = join(TMP, `lc-${name}-wts`);
  mkdirSync(wtd);
  const cfg = { project: `lc-${name}`, worktreesDir: wtd, basePort: 300, branch: { base: 'main' } };
  for (let n = 1; n <= laneCount; n += 1) {
    git(main, 'worktree', 'add', '-q', '--detach', join(wtd, `lane${n}`), 'origin/main');
  }
  return { main, wtd, cfg, origin };
}

test('enumerateLanes normalizes a detached-at-base lane: branch reads as the base name, isBase true, MARKS free', () => {
  const { cfg } = makeLanesFixture('detached-base', 1);
  const lane = worktrees.enumerateLanes(cfg)[0];
  assert.equal(lane.branch, 'main', 'not the literal "HEAD"');
  assert.equal(lane.isBase, true);
  assert.deepEqual(worktrees.laneMarks(lane), [{ text: 'free', tone: 'free' }]);
});

test('removeWorktree refuses a non-top selection, naming the real top', () => {
  const { cfg } = makeLanesFixture('rm-nontop', 3);
  const lanes = worktrees.enumerateLanes(cfg);
  const middle = lanes.find((l) => l.lane === 2);
  const res = worktrees.removeWorktree(cfg, [middle]);
  assert.match(res.error, /top is lane 3/);
  assert.match(res.error, /lanes rm 3/);
  assert.equal(existsSync(middle.path), true, 'refused — nothing removed');
});

test('removeWorktree refuses a lane with a running declared service, even at the contiguous top', () => {
  const { cfg } = makeLanesFixture('rm-service', 3);
  const svcCfgLc = { ...cfg, dev: { services: [{ name: 'web', command: 'echo web {port} && sleep 30', portBase: 300 }] } };
  const lanes = worktrees.enumerateLanes(svcCfgLc);
  const top = lanes[lanes.length - 1]; // lane3
  const [web] = sv.resolveServices(svcCfgLc, top);
  const started = sv.start(web);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  try {
    const res = worktrees.removeWorktree(svcCfgLc, [top]);
    assert.match(res.error, /lane 3 \(lane3\).*web.*still running.*lanes stop 3/s);
    assert.equal(existsSync(top.path), true, 'refused — nothing removed');
  } finally {
    sv.stop(web);
  }
});

test('removeWorktree removes a multi-lane top suffix in one call, descending, freeing the numbers for reuse', () => {
  const { cfg } = makeLanesFixture('rm-multi', 3);
  const [, two, three] = worktrees.enumerateLanes(cfg);
  const res = worktrees.removeWorktree(cfg, [two, three]);
  assert.equal(res.error, undefined, res.error);
  assert.deepEqual(res.removed.map((r) => r.lane), [3, 2], 'removed in descending order');
  assert.equal(existsSync(two.path), false);
  assert.equal(existsSync(three.path), false);
  assert.equal(worktrees.enumerateLanes(cfg).length, 1);

  // max(existing) is now 1, so the next lane reuses 2 rather than jumping to 4.
  assert.equal(worktrees.planCreate(cfg).lane, 2);
});

test('resetLane refuses a non-free lane unless --force', () => {
  const { wtd, cfg } = makeLanesFixture('reset-dirty', 1);
  writeFileSync(join(wtd, 'lane1', 'dirty.txt'), 'x');
  const lane = worktrees.enumerateLanes(cfg)[0];
  assert.equal(worktrees.isFree(lane), false);

  const refused = worktrees.resetLane(cfg, lane);
  assert.match(refused.error, /not free/);

  const forced = worktrees.resetLane(cfg, lane, { force: true });
  assert.equal(forced.error, undefined, forced.error);
  assert.equal(forced.branch, 'main');
});

test('resetLane detaches a lane back to origin/<base>, deleting a fully-merged outgoing branch', () => {
  const { wtd, cfg } = makeLanesFixture('reset-merged', 1);
  const lanePath = join(wtd, 'lane1');
  // A plain checkout -b with no new commits is trivially fully merged already.
  git(lanePath, 'checkout', '-b', 'feat/1-x');
  let lane = worktrees.enumerateLanes(cfg)[0];
  assert.equal(lane.branch, 'feat/1-x');
  assert.equal(lane.isBase, false);

  const res = worktrees.resetLane(cfg, lane);
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.branch, 'main');
  assert.equal(res.branchDeleted, 'feat/1-x', 'fully merged into origin/main, so `branch -d` succeeds');

  lane = worktrees.enumerateLanes(cfg)[0];
  assert.equal(lane.branch, 'main', 'reports the base name, not the literal HEAD, once detached at its commit');
  assert.equal(lane.isBase, true);
  assert.equal(worktrees.isFree(lane), true);
});

test('resetLane keeps an outgoing branch that is not fully merged into base', () => {
  const { wtd, cfg } = makeLanesFixture('reset-unmerged', 1);
  const lanePath = join(wtd, 'lane1');
  git(lanePath, 'checkout', '-b', 'feat/2-y');
  writeFileSync(join(lanePath, 'new.txt'), 'x');
  git(lanePath, 'add', '-A');
  git(lanePath, 'commit', '-qm', 'unmerged work');
  const lane = worktrees.enumerateLanes(cfg)[0];

  const res = worktrees.resetLane(cfg, lane, { force: true }); // ahead of base, needs force
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.branchDeleted, null, '`branch -d` refuses an unmerged branch, so it is kept');
  assert.match(git(lanePath, 'branch', '--list', 'feat/2-y'), /feat\/2-y/, 'the branch itself must still exist');
});

test('resetLane surfaces a failed fetch as an error, never a silent stale reset', () => {
  const { main, wtd, cfg } = makeLanesFixture('reset-fetch-fail', 1);
  const lanePath = join(wtd, 'lane1');
  git(main, 'remote', 'set-url', 'origin', join(TMP, 'nonexistent-origin.git'));
  const lane = worktrees.enumerateLanes(cfg)[0];
  const before = git(lanePath, 'rev-parse', 'HEAD').trim();

  const res = worktrees.resetLane(cfg, lane);
  assert.ok(res.error, 'a failed fetch must be reported, not swallowed');
  assert.equal(git(lanePath, 'rev-parse', 'HEAD').trim(), before, 'HEAD must not move on a failed fetch');
});

test('enumerateLanes lists lane directories in numeric order, not lexicographic — lane10 must not sort before lane2', () => {
  // No real git repos needed: laneNames()'s sort only reads directory names,
  // and enumerateLanes' per-lane git calls fail harmlessly on a non-repo path
  // (lib/git.mjs never throws), same tolerance the D26 rewrite relies on for
  // any stray directory. Isolates the `laneNumber(a) - laneNumber(b)` sort
  // this diff replaced a plain alphabetical `.sort()` with — lexicographic
  // order would put lane10 and lane9 ahead of lane2.
  const dir = join(TMP, 'numeric-sort-wts');
  mkdirSync(dir);
  for (const n of [10, 2, 9]) mkdirSync(join(dir, `lane${n}`));
  const names = worktrees.enumerateLanes({ worktreesDir: dir }).map((l) => l.name);
  assert.deepEqual(names, ['lane2', 'lane9', 'lane10']);
});

test('createWorktree passes --detach explicitly, so an unqualified --from matching exactly one remote branch does not trigger git\'s own DWIM checkout', () => {
  // The exact regression the explicit --detach flag (added in this diff) guards
  // against: `git worktree add <path> <name>` with no --detach, where <name>
  // matches exactly one remote-tracking branch, makes git create AND check out
  // a same-named local branch instead of landing detached — verified directly
  // against the installed git in the setup above this test file's own fixture.
  const { main, wtd, cfg } = makeLanesFixture('dwim-detach', 1);
  git(main, 'checkout', '-qb', 'other-branch');
  writeFileSync(join(main, 'extra.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'other work');
  git(main, 'push', '-q', 'origin', 'other-branch');
  git(main, 'checkout', '-q', 'main');

  const res = worktrees.createWorktree(cfg, 'other-branch');
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.path, join(wtd, 'lane2'));
  assert.equal(
    git(res.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    'HEAD',
    'must land detached, not on a local "other-branch" git DWIM\'d into existence',
  );
});

test('createWorktree keeps createdDir in its error result — a failed git worktree add must not hide that worktreesDir was just materialized', () => {
  const parent = join(TMP, 'cw-createddir-parent');
  mkdirSync(parent);
  const main = join(parent, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'test@test.test');
  git(main, 'config', 'user.name', 'test');
  writeFileSync(join(main, 'f.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  const origin = join(parent, 'origin.git');
  git(TMP, 'init', '-q', '--bare', origin);
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', 'origin', 'main');

  // No lane exists yet, so createWorktree falls back to running git from
  // process.cwd() (its own comment: "an existing worktree so it knows which
  // repo we mean") — the real shape of the very first `lanes new` in a
  // project, invoked from the repo root. chdir replicates that faithfully.
  const freshDir = join(parent, 'wts');
  const cfg = { worktreesDir: freshDir, branch: { base: 'main' } };
  const originalCwd = process.cwd();
  process.chdir(main);
  try {
    const res = worktrees.createWorktree(cfg, 'no-such-ref-at-all');
    assert.ok(res.error, 'the bad ref must surface as an error');
    assert.equal(existsSync(freshDir), true, 'worktreesDir was created before the failing git call');
    assert.equal(res.createdDir, freshDir, 'the error result must not hide that a directory was materialized');
    assert.equal(existsSync(res.path), false, 'the worktree itself must not exist after a failed add');
  } finally {
    process.chdir(originalCwd);
  }
});

test('removeWorktree never reports the literal "HEAD" as a kept branch for a lane detached at a non-base ref (possible via `new --from <ref>`)', () => {
  const { main, wtd, cfg } = makeLanesFixture('rm-detached-nonbase', 1);
  git(main, 'checkout', '-qb', 'feat/9-x');
  writeFileSync(join(main, 'extra.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'extra work');
  git(main, 'push', '-q', 'origin', 'feat/9-x');
  git(main, 'checkout', '-q', 'main');
  // Detached straight at a non-base ref — not the "checked out exactly at
  // origin/<base>" case enumerateLanes normalizes to the base name, so branch
  // must stay the literal 'HEAD' and isBase must stay false.
  git(main, 'worktree', 'add', '-q', '--detach', join(wtd, 'lane2'), 'origin/feat/9-x');

  const lane = worktrees.enumerateLanes(cfg).find((l) => l.lane === 2);
  assert.equal(lane.branch, 'HEAD', 'precondition: genuinely detached at a non-base ref, not normalized to it');
  assert.equal(lane.isBase, false);

  const res = worktrees.removeWorktree(cfg, [lane], { force: true }); // ahead of base, needs force
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.removed[0].branchKept, null, 'a detached HEAD carries no branch to leave — must not be misreported as "HEAD" itself');
});

test('resetLane computes no outgoing branch to delete for a lane detached at a non-base ref', () => {
  const { main, wtd, cfg } = makeLanesFixture('reset-detached-nonbase', 1);
  git(main, 'checkout', '-qb', 'feat/8-y');
  writeFileSync(join(main, 'extra.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'extra work');
  git(main, 'push', '-q', 'origin', 'feat/8-y');
  git(main, 'checkout', '-q', 'main');
  git(main, 'worktree', 'add', '-q', '--detach', join(wtd, 'lane2'), 'origin/feat/8-y');

  const lane = worktrees.enumerateLanes(cfg).find((l) => l.lane === 2);
  assert.equal(lane.branch, 'HEAD', 'precondition: genuinely detached at a non-base ref');

  const res = worktrees.resetLane(cfg, lane, { force: true }); // ahead of base, needs force
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.branchDeleted, null, 'nothing to delete — a literal HEAD is not a real branch name');
  assert.equal(res.branch, 'main');

  const after = worktrees.enumerateLanes(cfg).find((l) => l.lane === 2);
  assert.equal(after.isBase, true);
});

test('removeWorktree checks every selected lane before removing any — a dirty lane blocks the whole contiguous batch, not just itself', () => {
  const { wtd, cfg } = makeLanesFixture('rm-multi-dirty', 3);
  writeFileSync(join(wtd, 'lane2', 'dirty.txt'), 'x'); // lane2 only, not lane3
  const [, two, three] = worktrees.enumerateLanes(cfg);
  assert.equal(two.dirty, true);
  assert.equal(three.dirty, false);

  const res = worktrees.removeWorktree(cfg, [two, three]);
  assert.match(res.error, /lane 2 \(lane2\)/, 'must name the actual blocked lane');
  assert.match(res.error, /uncommitted/);
  assert.equal(existsSync(two.path), true, 'nothing removed — everything is checked before anything is touched');
  assert.equal(existsSync(three.path), true, 'lane3 was itself clean, but must not be removed ahead of the blocked lane2');
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

// A single declared service with no `url` template — isolates the dashboard's
// "no url" rendering branch, which svcCfg's own first service (`web`) never
// exercises since it always has one.
const svcCfgNoUrl = {
  ...wtCfg,
  dev: { services: [{ name: 'api', cwd: 'src', command: 'echo api {port} && sleep 30', portBase: 400 }] },
};

test('ports concatenate base and lane, so services with close bases cannot collide', () => {
  // Surprising on purpose, and pinned here: base 300 lane 2 is 3002, not 302.
  assert.equal(sv.portFor(300, 2), '3002');
  assert.equal(sv.portFor(400, 2), '4002');
  assert.equal(sv.portFor(300, 10), '30010');
});

test('services resolve placeholders, cwd and their own port series', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[1]; // lane 2, lane2
  const svcs = sv.resolveServices(svcCfg, lane);
  assert.deepEqual(svcs.map((s) => s.name), ['web', 'api'], 'a service with no command is skipped');
  assert.equal(svcs[0].port, '3002');
  assert.equal(svcs[1].port, '4002', 'each service has its own base');
  assert.match(svcs[0].command, /echo web 3002 in lane2/);
  assert.equal(svcs[0].cwd, lane.path);
  assert.equal(svcs[1].cwd, join(lane.path, 'src'), 'cwd is relative to the worktree');
  assert.equal(svcs[0].url, 'http://localhost:3002');
});

test('service bookkeeping is keyed by worktree name, not lane number', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[2]; // lane 3, lane3
  const [web] = sv.resolveServices(svcCfg, lane);
  assert.match(web.pidFile, /demo-lane3-web\.pid$/, 'lane 3 does not appear in the key');
  assert.match(web.logFile, /demo-lane3-web\.log$/);
});

test('a project with no dev.services declared resolves to none', () => {
  assert.deepEqual(sv.resolveServices(wtCfg, worktrees.enumerateLanes(wtCfg)[0]), []);
});

// boundPort is the shared helper `lanes list` (bin/lanes.mjs) and the
// dashboard's serviceCell (ui/dashboard.mjs) both now consume, so its own
// branches — not running, running-and-matching, running-and-diverged, and a
// pidfile that never recorded a port — get direct coverage here rather than
// only indirectly through the two callers.
test('boundPort: stopped or running-with-a-matching-port returns the fresh port with no ! marker', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[1]; // lane 2, lane2 — web.port is '3002'
  const [web] = sv.resolveServices(svcCfg, lane);
  assert.deepEqual(sv.boundPort(web, { running: false, pid: null, port: null }), { port: '3002', moved: '' });
  assert.deepEqual(
    sv.boundPort(web, { running: true, pid: 123, port: '3002' }),
    { port: '3002', moved: '' },
    'bound port agrees with the fresh computation — nothing to flag',
  );
});

test('boundPort: a diverged bound port wins and is marked !; a pidfile with no recorded port falls back to the fresh one, unmarked', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[1]; // lane 2, lane2 — web.port is '3002'
  const [web] = sv.resolveServices(svcCfg, lane);
  assert.deepEqual(
    sv.boundPort(web, { running: true, pid: 123, port: '3009' }),
    { port: '3009', moved: '!' },
    'the actually-bound port is shown, not the freshly computed one, and flagged as moved',
  );
  assert.deepEqual(
    sv.boundPort(web, { running: true, pid: 123, port: null }),
    { port: '3002', moved: '' },
    'a pre-existing pidfile that never recorded a port falls back to the fresh computation, not treated as moved',
  );
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

// ── Dashboard: service cell (second line) ────────────────────────────
const stripAnsi = (s) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

// Column order on the second line since #4: 3-space prefix, then the service
// cell at a fixed width (WORKTREE+BRANCH+MARKS+ISSUE, matching the main row's
// own column widths), then the ctx cell immediately after with no gap of its
// own (see SERVICE_CELL_WIDTH in ui/dashboard.mjs).
const SERVICE_CELL_WIDTH = 20 + 40 + 12 + 8;

/** The service line directly under a lane's own row, with the stable 3-space prefix stripped. */
function serviceLineFor(frame, laneName) {
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.includes(laneName));
  assert.ok(idx !== -1, `${laneName} must have a row`);
  return lines[idx + 1].slice(3, 3 + SERVICE_CELL_WIDTH).trimEnd();
}

test('dashboard: no dev.services declared shows — on the second line', () => {
  const lane = worktrees.enumerateLanes(wtCfg)[0];
  const ctx = { ...resolveContext(lane2), config: wtCfg };
  const frame = render(ctx, createState(), Date.now(), [lane]);
  assert.equal(serviceLineFor(frame, lane.name), '—');
});

test('dashboard: services declared but none running shows —, still with the count of the rest', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[0]; // lane1
  // Precondition, not an assumption: an earlier test (`start records pid and
  // port…`) starts and stops `web` on this exact lane, with no try/finally —
  // if its own assertions ever throw between start and stop, this test would
  // otherwise fail on a leftover running process and blame the wrong code.
  assert.equal(sv.status(sv.resolveServices(svcCfg, lane)[0]).running, false, 'precondition: no service left running on lane1 by an earlier test');
  const ctx = { ...resolveContext(lane2), config: svcCfg };
  const frame = render(ctx, createState(), Date.now(), [lane]);
  // The count suffix applies to "whichever of the above is shown" — including
  // the placeholder, per the spec's rendering table — not only a live value.
  assert.equal(serviceLineFor(frame, lane.name), '— (+1 more)');
});

test('dashboard: first declared service running with a url template shows the resolved URL, plus a count of the rest', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[1]; // lane2, lane 2
  const [web] = sv.resolveServices(svcCfg, lane);
  const started = sv.start(web);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  try {
    const ctx = { ...resolveContext(lane2), config: svcCfg };
    const frame = render(ctx, createState(), Date.now(), [lane]);
    assert.equal(serviceLineFor(frame, lane.name), 'http://localhost:3002 (+1 more)');
  } finally {
    sv.stop(web);
  }
});

test('dashboard: a url-template service also gets marked ! once its portBase is edited while running', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[0]; // lane1
  const [web] = sv.resolveServices(svcCfg, lane); // bound at http://localhost:3001
  const started = sv.start(web);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  try {
    // Lane numbers no longer move at all (D26) — the only way a bound port and
    // a fresh computation can still disagree while a service stays up is a
    // portBase edit (e.g. `lanes service-port web 350`). Bookkeeping is keyed
    // by worktree name, so the pid file (and the real bound port, 3001)
    // survives the edit untouched, but the freshly computed port — and
    // therefore the filled url template — moves. Before the boundPort
    // extraction this branch never appended '!', so a URL nobody was
    // listening on rendered with zero indication it was stale.
    const edited = {
      ...svcCfg,
      dev: { services: svcCfg.dev.services.map((s) => (s.name === 'web' ? { ...s, portBase: 350 } : s)) },
    };
    const ctx = { ...resolveContext(lane2), config: edited };
    const frame = render(ctx, createState(), Date.now(), [lane]);
    assert.equal(serviceLineFor(frame, lane.name), 'http://localhost:3501! (+1 more)');
  } finally {
    sv.stop(web);
  }
});

test('dashboard: first declared service running with no url template shows localhost:<bound-port>, with ! once its portBase is edited while running', () => {
  const lane = worktrees.enumerateLanes(svcCfgNoUrl)[2]; // lane3
  const [api] = sv.resolveServices(svcCfgNoUrl, lane);
  const started = sv.start(api);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  try {
    const ctx = { ...resolveContext(lane2), config: svcCfgNoUrl };
    const frame = render(ctx, createState(), Date.now(), [lane]);
    assert.equal(serviceLineFor(frame, lane.name), 'localhost:4003');

    // Same lane, same worktree — only the service's own portBase changes.
    // The pid file survives (keyed by worktree name, D18-style), but a fresh
    // computation now disagrees — the cell must show the port the process
    // actually bound to, marked with !.
    const edited = {
      ...svcCfgNoUrl,
      dev: { services: svcCfgNoUrl.dev.services.map((s) => (s.name === 'api' ? { ...s, portBase: 450 } : s)) },
    };
    const ctxEdited = { ...resolveContext(lane2), config: edited };
    const frameMoved = render(ctxEdited, createState(), Date.now(), [lane]);
    assert.equal(serviceLineFor(frameMoved, lane.name), 'localhost:4003!');
  } finally {
    sv.stop(api);
  }
});

test('dashboard: a row with no .name (foreign project or vanished lane) is never passed into resolveServices', () => {
  const state = createState();
  state.lanes.set('demo#demo-ghost-2', { project: 'demo', worktree: 'demo-ghost-2', ev: 'idle', since: 1 });
  const ctx = { ...resolveContext(lane2), config: svcCfg };
  const frame = render(ctx, state, Date.now(), []);
  assert.equal(
    serviceLineFor(frame, 'demo-ghost-2'),
    '—',
    'no .name must never reach resolveServices, regardless of what the project declares',
  );
});

test('lanes list SERVICES column: boundPort wiring is unchanged after the extraction — same port, same ! marker, same colours', () => {
  // A dedicated fixture, not svcCfg/wtDir: this needs dev.services in the
  // *committed* config the real `lanes list` CLI reads from `cwd`, which the
  // shared repo/wtDir fixture deliberately does not declare.
  const main = join(TMP, 'list-services');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@test.test');
  git(main, 'config', 'user.name', 'test');
  mkdirSync(join(main, '.claude'));
  const svcWtDir = join(TMP, 'list-services-wts');
  const cfgPath = join(main, '.claude', 'agent-system.json');
  const cfg = {
    project: 'list-services',
    worktreesDir: svcWtDir,
    basePort: 300,
    dev: { services: [{ name: 'web', command: 'echo web {port} && sleep 30', portBase: 300 }] },
  };
  writeFileSync(cfgPath, JSON.stringify(cfg));
  writeFileSync(join(main, 'f.txt'), 'x');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  git(main, 'worktree', 'add', '-q', join(svcWtDir, 'lane1'), '-b', 'feat/1-one');

  const lane = worktrees.enumerateLanes(cfg)[0]; // lane1
  const [web] = sv.resolveServices(cfg, lane);
  const started = sv.start(web);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  try {
    const before = execFileSync(join(ROOT, 'bin', 'lanes'), ['list'], { cwd: main, encoding: 'utf8' });
    assert.match(before, /\x1b\[32mweb:3001\x1b\[0m/, 'running, matching port: green, no ! marker');

    // Not a renumber — lane numbers no longer move at all (D26). Editing the
    // committed portBase is now the only way a bound port and a fresh
    // computation can disagree while the service stays up. Bookkeeping is
    // keyed by worktree name, so the same pid file — and its recorded port,
    // 3001 — still applies, but a fresh computation now disagrees (3501).
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, dev: { services: [{ ...cfg.dev.services[0], portBase: 350 }] } }));
    const after = execFileSync(join(ROOT, 'bin', 'lanes'), ['list'], { cwd: main, encoding: 'utf8' });
    assert.match(after, /\x1b\[32mweb:3001!\x1b\[0m/, 'the bound port is shown, marked !, once portBase changes under it');
  } finally {
    sv.stop(web);
  }
});

// ── Dashboard: sub-header, rule width and lane spacing (#4) ──────────
test('the SERVICE/CTX sub-header lines up with the real service/ctx columns on the row below', () => {
  const ctxInfo = new Map([['/tmp/aligned.jsonl', { tokens: 2000, model: 'claude-sonnet-5' }]]);
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/tmp/aligned.jsonl' })]);
  const lane = worktrees.enumerateLanes(wtCfg)[0]; // lane1, no dev.services declared under wtCfg
  const ctx = { ...resolveContext(lane2), config: wtCfg };
  const frame = render(ctx, state, Date.now(), [lane], ctxInfo);
  const lines = stripAnsi(frame).split('\n');

  const headerIdx = lines.findIndex((l) => l.includes('WORKTREE'));
  const subHeader = lines[headerIdx + 1];
  assert.equal(subHeader.slice(3, 3 + SERVICE_CELL_WIDTH).trim(), 'SERVICE');
  assert.equal(subHeader.slice(3 + SERVICE_CELL_WIDTH).trim(), 'CTX');

  // Same fixed offset applied to the real second line below it — if the two
  // ever used a different width, the labels would sit over the wrong cells.
  const dataIdx = lines.findIndex((l) => l.includes('lane1') && !l.includes('lane10'));
  const secondLineText = lines[dataIdx + 1];
  assert.equal(secondLineText.slice(3, 3 + SERVICE_CELL_WIDTH).trim(), '—', 'SERVICE lines up over the service cell');
  assert.equal(
    secondLineText.slice(3 + SERVICE_CELL_WIDTH).trim(),
    '2K ctx · sonnet-5',
    'CTX lines up exactly where the ctx cell starts, with no gap or overlap',
  );
});

test('the rule under the header is never shorter than the header row, even on a terminal narrower than it', () => {
  const originalColumns = process.stdout.columns;
  try {
    process.stdout.columns = 60; // far narrower than the ~136-char fixed header
    const frame = render(resolveContext(lane2), createState());
    const lines = stripAnsi(frame).split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('WORKTREE'));
    const headerLine = lines[headerIdx];
    const sepLine = lines[headerIdx + 2]; // header, sub-header, then the rule
    assert.ok(/^─+$/.test(sepLine) && sepLine.length > 0, 'the line two below the header must be the rule');
    assert.equal(
      sepLine.length,
      headerLine.length,
      'the rule must stretch to cover the header exactly, not stop short at the narrower terminal width',
    );
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('the title bar keeps its own narrower width instead of being pulled out to match the wider header rule', () => {
  const originalColumns = process.stdout.columns;
  try {
    process.stdout.columns = 60;
    const frame = render(resolveContext(lane2), createState());
    const lines = stripAnsi(frame).split('\n');
    const titleLine = lines[0];
    const headerLine = lines.find((l) => l.includes('WORKTREE'));
    assert.ok(titleLine.length < headerLine.length, 'the title/clock line must not be padded out to the header/rule width');
    assert.equal(titleLine.length, 60, 'the title bar follows the floored terminal width, not the wider header');
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('render omits the leading blank before the first lane, but still leaves one before RECENT with zero lanes', () => {
  const frame = render(resolveContext(lane2), createState(), Date.now(), []);
  const lines = frame.split('\n');
  const placeholderIdx = lines.findIndex((l) => l.includes('No lanes yet'));
  assert.ok(placeholderIdx !== -1, 'the empty-lanes placeholder must still show');
  assert.equal(lines[placeholderIdx + 1], '', 'a blank line must separate the placeholder from RECENT even with zero lanes');
  assert.ok(lines[placeholderIdx + 2].includes('RECENT'), 'RECENT must follow directly after that one blank line');
});

test('render puts no blank line before a single lane\'s block, and exactly one blank before RECENT after it', () => {
  const single = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'main',
    isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), single);
  const lines = stripAnsi(frame).split('\n');
  const sepIdx = lines.findIndex((l) => /^─+$/.test(l));
  assert.ok(lines[sepIdx + 1].includes('lane1'), 'the only lane\'s row must start right after the rule, with no leading blank');
  assert.equal(lines[sepIdx + 3], '', 'exactly one blank line must separate the only lane\'s block from RECENT');
  assert.ok(lines[sepIdx + 4].includes('RECENT'));
});

test('render inserts exactly one blank line between two lanes, and one more before RECENT after the last', () => {
  const two = [
    { lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'main', isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true },
    { lane: 2, name: 'lane2', path: join(wtDir, 'lane2'), branch: 'main', isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true },
  ];
  const frame = render(resolveContext(lane2), createState(), Date.now(), two);
  const lines = stripAnsi(frame).split('\n');
  const sepIdx = lines.findIndex((l) => /^─+$/.test(l));
  assert.ok(lines[sepIdx + 1].includes('lane1'), 'no leading blank before the first lane');
  assert.equal(lines[sepIdx + 3], '', 'exactly one blank line between the first lane\'s block and the second\'s');
  assert.ok(lines[sepIdx + 4].includes('lane2'), 'the second lane follows right after that single blank');
  assert.equal(lines[sepIdx + 6], '', 'one blank line before RECENT after the last lane');
  assert.ok(lines[sepIdx + 7].includes('RECENT'));
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

test('lanes new emits lane_created for the next lane, always detached, and lanes rm emits lane_removed', () => {
  // A commit SHA, not a branch name: checking out `main` in a second worktree
  // while `repo` already has it checked out is refused by git. A raw SHA always
  // lands detached, which is the whole point — there is no `--branch` flag
  // anymore to invent a branch name from.
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  execFileSync(join(ROOT, 'bin', 'lanes'), ['new', '--from', base], { cwd: repo, encoding: 'utf8' });
  const created = readEvents().findLast((e) => e.ev === 'lane_created' && e.worktree === 'lane4');
  assert.ok(created, 'wtDir already has lane1..lane3, so the next lane must be lane4');
  assert.equal(created.project, 'demo');
  assert.equal(created.lane, 4);
  assert.equal(created.branch, null, 'always a detached HEAD');
  assert.equal(created.path, join(wtDir, 'lane4'), 'path is what liveness checks rely on');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', 'lane4'], { cwd: repo, encoding: 'utf8' });
  const removed = readEvents().findLast((e) => e.ev === 'lane_removed' && e.worktree === 'lane4');
  assert.ok(removed, 'lanes rm must emit lane_removed');
  assert.equal(removed.project, 'demo');
  assert.equal(removed.lane, 4);
});

test('lanes new reuses the lane number lanes rm just freed, rather than skipping past it', () => {
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  execFileSync(join(ROOT, 'bin', 'lanes'), ['new', '--from', base], { cwd: repo, encoding: 'utf8' });
  const created = readEvents().findLast((e) => e.ev === 'lane_created' && e.worktree === 'lane4');
  assert.ok(created, 'the previous test removed lane4, so this lanes new must reuse it, not jump to lane5');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', 'lane4'], { cwd: repo, encoding: 'utf8' });
});

test('lanes rm refuses a non-top lane through the real CLI, naming the actual top', () => {
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', '1'], { cwd: repo, stdio: 'pipe' }),
    /top is lane 3/,
  );
  assert.equal(existsSync(join(wtDir, 'lane1')), true, 'refused — lane1 must still be there');
});

test('lanes rm with no selector at all refuses, rather than defaulting to removing every lane', () => {
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['rm'], { cwd: repo, stdio: 'pipe' }),
    /Usage: lanes rm/,
  );
  assert.equal(worktrees.enumerateLanes(wtCfg).length, 3, 'refused before touching anything — lane1..lane3 all still there');
});

test('lanes reset detaches a lane back to a clean base state through the real CLI', () => {
  const { main, wtd, cfg } = makeLanesFixture('cli-reset', 1);
  const lanePath = join(wtd, 'lane1');
  git(lanePath, 'checkout', '-b', 'feat/1-cli-reset');
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'agent-system.json'), JSON.stringify(cfg));

  const out = execFileSync(join(ROOT, 'bin', 'lanes'), ['reset', '1'], { cwd: main, encoding: 'utf8' });
  assert.match(out, /lane 1 \(lane1\)/);
  assert.match(out, /origin\/main/);

  const lane = worktrees.enumerateLanes(cfg)[0];
  assert.equal(lane.branch, 'main');
  assert.equal(lane.isBase, true);

  const emitted = readEvents().findLast((e) => e.ev === 'lane_reset' && e.project === cfg.project);
  assert.ok(emitted, 'lanes reset must emit lane_reset, so the dashboard row does not keep showing the finished task');
  assert.equal(emitted.lane, 1);
  assert.equal(emitted.worktree, 'lane1');
});

test('reset, switch and logs each refuse a multi-lane selector rather than silently acting on the first match', () => {
  const { main, wtd, cfg } = makeLanesFixture('cli-selectone', 3);
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'agent-system.json'), JSON.stringify(cfg));
  for (const n of [1, 2, 3]) git(join(wtd, `lane${n}`), 'checkout', '-b', `feat/${n}-selectone`);

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['reset', 'all', '--force'], { cwd: main, stdio: 'pipe' }),
    /lanes reset takes exactly one lane, got 3 \(1, 2, 3\)/,
  );
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['switch', '1,2', 'main'], { cwd: main, stdio: 'pipe' }),
    /lanes switch takes exactly one lane, got 2 \(1, 2\)/,
  );
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['logs'], { cwd: main, stdio: 'pipe' }),
    /Usage: lanes logs <lane>/,
    'no lane argument at all, with 3 lanes declared, must ask for one rather than naming all 3 as if the caller had typed "all"',
  );
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['logs', ','], { cwd: main, stdio: 'pipe' }),
    /lanes logs takes exactly one lane, got 0 — no lane matched that selector\./,
    'a non-empty selector that matches zero lanes must fail cleanly here, not crash downstream on an undefined lane',
  );

  const branches = worktrees.enumerateLanes(cfg).map((l) => l.branch).sort();
  assert.deepEqual(
    branches,
    ['feat/1-selectone', 'feat/2-selectone', 'feat/3-selectone'],
    'every refusal must happen before touching any lane — lane1 in particular, the one a bare `[target] = select(...)` would have silently picked',
  );
});

test('reset, switch and logs still resolve a genuine single-lane selector correctly through selectOne', () => {
  const { main, wtd, cfg } = makeLanesFixture('cli-selectone-happy', 2);
  const svcCfg = { ...cfg, dev: { services: [{ name: 'web', command: 'true', portBase: 300 }] } };
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'agent-system.json'), JSON.stringify(svcCfg));

  // switch: exactly-one-match happy path (numeric lane, plain branch name).
  const switchOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['switch', '1', 'selectone/happy', '--create'], {
    cwd: main,
    encoding: 'utf8',
  });
  assert.match(switchOut, /lane 1 \(lane1\) → selectone\/happy/);
  assert.equal(worktrees.enumerateLanes(cfg).find((l) => l.lane === 1).branch, 'selectone/happy');

  // logs: exactly-one-match happy path.
  const logsOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['logs', '2'], { cwd: main, encoding: 'utf8' });
  assert.match(logsOut, /lane 2 · web/);
  assert.match(logsOut, /no log yet/);
});

test('lanes switch dies with its own usage rather than misreading a lone positional as the branch', () => {
  const { main, cfg } = makeLanesFixture('cli-switch-usage', 1);
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'agent-system.json'), JSON.stringify(cfg));

  // `lanes switch main` has one positional arg, which is consumed as <lane>
  // (not <branch>) by `[sel, branch] = rest.filter(...)`. The `if (!branch)`
  // guard must catch this and print usage — not hand "main" to selectOne and
  // report it as an unmatched lane selector.
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['switch', 'main'], { cwd: main, stdio: 'pipe' }),
    /Usage: lanes switch <lane> <branch> \[--create\]/,
  );
  assert.equal(worktrees.enumerateLanes(cfg)[0].branch, 'main', 'refused before touching the lane');
});

test('lanes reset with no lane argument still dies with its own usage now that the standalone !sel precheck was folded into selectOne', () => {
  const { main, cfg } = makeLanesFixture('cli-reset-usage', 1);
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'agent-system.json'), JSON.stringify(cfg));

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['reset'], { cwd: main, stdio: 'pipe' }),
    /Usage: lanes reset <lane> \[--force\]/,
  );
});

test('lanes doctor warns about a directory under worktreesDir that does not match lane<N>', () => {
  const { main, wtd, cfg } = makeLanesFixture('doctor-stray', 1);
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'agent-system.json'), JSON.stringify(cfg));
  mkdirSync(join(wtd, 'old-style-name'));

  const out = execFileSync(join(ROOT, 'bin', 'lanes'), ['doctor'], { cwd: main, encoding: 'utf8' });
  assert.match(out, /lane naming/);
  assert.match(out, /old-style-name/);
});

test('lanes list dies naming the stray directories when worktreesDir resolves but holds none matching lane<N>', () => {
  const { main, wtd, cfg } = makeLanesFixture('stray-only', 0); // no conforming lanes at all
  mkdirSync(join(wtd, 'wt1'));
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'agent-system.json'), JSON.stringify(cfg));

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['list'], { cwd: main, stdio: 'pipe' }),
    /wt1/,
    'must name the actual stray directory, not just say "set worktreesDir" when it is already set correctly',
  );
});

test('emitWithContext fills path from ctx.worktreeRoot too, not just the two direct emit() calls in lanes new/rm', () => {
  execFileSync(join(ROOT, 'bin', 'lanes'), ['stage', 'implement', 'path propagation check'], {
    cwd: lane2,
    encoding: 'utf8',
  });
  const staged = readEvents().findLast((e) => e.ev === 'stage' && e.worktree === 'lane2' && e.stage === 'implement');
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

test('emit refuses a line whose real UTF-8 byte size crosses the PIPE_BUF safety margin, even when its UTF-16 .length would pass', () => {
  const eventsPath = join(LANES_DIR, 'events.jsonl');
  const readRaw = () => (existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '');
  const before = readRaw();
  // Each '文' is one UTF-16 code unit but three UTF-8 bytes: 1400 of them keep
  // the JSON line's .length under 4000 while its byte size clears 4000.
  const wide = '文'.repeat(1400);
  const line = `${JSON.stringify({ ts: Date.now(), ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', note: wide })}\n`;
  assert.ok(line.length < 4000, 'fixture must stay under the old, wrong .length check to prove the byte check is what fires');
  assert.ok(Buffer.byteLength(line, 'utf8') > 4000, 'fixture must exceed 4000 real bytes for this test to mean anything');

  const ok = emit({ ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', note: wide });
  assert.equal(ok, false, 'a line whose real byte size exceeds the margin must be refused, not silently written oversized');
  assert.equal(readRaw(), before, 'a refused line must not be appended at all');
});

test('emit still writes ordinary multi-byte content that stays under both the character and byte thresholds', () => {
  const eventsPath = join(LANES_DIR, 'events.jsonl');
  const readRaw = () => (existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '');
  const before = readRaw();
  const note = '文'.repeat(50); // 150 bytes — nowhere near either threshold
  const ok = emit({ ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', note });
  assert.equal(ok, true, 'the byte check must not reject normal multi-byte content, only oversized lines');
  const appended = readRaw().slice(before.length);
  assert.equal(JSON.parse(appended.trim()).note, note, 'the content round-trips untouched, not mangled by the guard');
});

test('emit draws the line exactly where the > 4000 byte check says: 4000 bytes in, 4001 bytes out', () => {
  const eventsPath = join(LANES_DIR, 'events.jsonl');
  const readRaw = () => (existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '');
  const base = { ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1' };
  // ASCII padding is one byte per character, so the note length maps 1:1 onto
  // the line's total byte size — that gives an exact target, unlike the
  // multi-byte fixture above which only proves "well over", not the boundary.
  const sizeWithNote = (note) => Buffer.byteLength(`${JSON.stringify({ ts: Date.now(), ...base, note })}\n`, 'utf8');
  const baseSize = sizeWithNote('');
  const note4000 = 'x'.repeat(4000 - baseSize);
  const note4001 = 'x'.repeat(4000 - baseSize + 1);
  assert.equal(sizeWithNote(note4000), 4000, 'fixture must land exactly on the boundary');
  assert.equal(sizeWithNote(note4001), 4001, 'fixture must land exactly one byte past the boundary');

  const beforeAt = readRaw();
  assert.equal(emit({ ...base, note: note4000 }), true, 'exactly 4000 bytes must be accepted — the check is `> 4000`, not `>=`');
  assert.notEqual(readRaw(), beforeAt, 'the accepted boundary line must be appended');

  const beforeOver = readRaw();
  assert.equal(emit({ ...base, note: note4001 }), false, 'one byte past the boundary must be refused');
  assert.equal(readRaw(), beforeOver, 'the refused line must not be appended');
});

test('emit truncates an oversized multi-byte detail before the byte check, so it is not refused for a length only the raw string had', () => {
  const eventsPath = join(LANES_DIR, 'events.jsonl');
  const readRaw = () => (existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '');
  const before = readRaw();
  // Untruncated this is 2000 * 3 = 6000 bytes on its own — comfortably past the
  // 4000-byte margin. The 300-character cap must fire first so the byte check
  // never sees the raw size.
  const detail = '文'.repeat(2000);
  const ok = emit({ ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', detail });
  assert.equal(ok, true, 'truncation must bring a hugely oversized multi-byte detail under the byte guard');
  const appended = readRaw().slice(before.length);
  const parsed = JSON.parse(appended.trim());
  assert.equal(parsed.detail, `${'文'.repeat(297)}...`, 'truncated to 297 characters + ellipsis, same as ASCII detail');
  assert.ok(Buffer.byteLength(appended, 'utf8') < 4000, 'the written line is nowhere near the margin once truncated');
});

// ── Context tokens (#4) ─────────────────────────────────────────────
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const transcriptDir = join(TMP, 'transcripts');
mkdirSync(transcriptDir);

const assistantLine = (model, usage) => `${JSON.stringify({ type: 'assistant', message: { model, usage } })}\n`;
const writeTranscript = (name, lines) => {
  const p = join(transcriptDir, name);
  writeFileSync(p, lines.join(''));
  return p;
};

/**
 * Since #3 shipped, a lane's second line carries the service cell (always
 * dimmed) followed immediately by the ctx cell (its own independent tone) —
 * see `secondLine` in ui/dashboard.mjs. The service cell always ends with a
 * reset before the ctx cell begins, so that reset is the reliable place to
 * split the raw line — a fixed-width slice would break the moment either
 * cell's width changes.
 */
function ctxPortion(rawLine) {
  const cut = rawLine.indexOf(RESET, 3);
  assert.ok(cut !== -1, 'the service cell must end with a reset before the ctx cell begins');
  return rawLine.slice(cut + RESET.length);
}

test('fmtTokens formats exactly at the K/M boundaries', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1000), '1K');
  assert.equal(fmtTokens(1500), '2K', 'Math.round(1.5) rounds up');
  assert.equal(fmtTokens(999999), '1000K', 'still below the M threshold, since that check is on the raw count');
  assert.equal(fmtTokens(1_000_000), '1.0M');
  assert.equal(fmtTokens(1_500_000), '1.5M');
});

test('readContext returns null for a missing file, a non-string path, or an empty file', () => {
  assert.equal(readContext(join(transcriptDir, 'nope.jsonl')), null);
  assert.equal(readContext(null), null);
  assert.equal(readContext(undefined), null);
  assert.equal(readContext(42), null);
  const empty = writeTranscript('empty.jsonl', []);
  assert.equal(readContext(empty), null);
});

test('readContext never throws on corrupt or binary content', () => {
  const p = join(transcriptDir, 'binary.bin');
  writeFileSync(p, Buffer.from([0, 1, 2, 255, 254, 253, 0x7b, 0x22, 0xff, 0x00]));
  assert.doesNotThrow(() => readContext(p));
  assert.equal(readContext(p), null);

  const garbage = writeTranscript('garbage.jsonl', ['not json\n', '{ "type": "assistant"\n', '{}\n']);
  assert.doesNotThrow(() => readContext(garbage));
  assert.equal(readContext(garbage), null);
});

test('readContext scans backward and skips <synthetic> and all-zero-usage entries', () => {
  const p = writeTranscript('scan.jsonl', [
    assistantLine('claude-opus-4-8', { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`,
    assistantLine('claude-sonnet-5', { input_tokens: 43000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 0 }),
    assistantLine('claude-sonnet-5', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    assistantLine('<synthetic>', { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
  ]);
  assert.deepEqual(readContext(p), { tokens: 143000, model: 'claude-sonnet-5' });
});

test('readContext falls back to the full file when the last line alone exceeds the 256KB tail window', () => {
  const bigLine = `${JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      usage: { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    _pad: 'x'.repeat(300 * 1024), // pushes this single line past the 256KB tail
  })}\n`;
  const p = writeTranscript('oversized-line.jsonl', [bigLine]);
  assert.deepEqual(readContext(p), { tokens: 5000, model: 'claude-sonnet-5' });
});

test('applyEvents folds transcript like branch — carried forward, never cleared by an unrelated event', () => {
  const s = applyEvents(createState(), [
    ev(1, 'session_start', { transcript: '/tmp/a.jsonl' }),
    ev(2, 'idle', { transcript: '/tmp/b.jsonl' }),
    ev(3, 'busy'), // no transcript field on this event; must not clear the last known one
    // The real hook always writes the key — `input?.transcript_path || null`
    // — so `idle` with an explicit `null` (not merely absent) is the wire
    // shape to test, not a hypothetical: `null ?? prev.transcript` must still
    // carry the last known value forward for a non-`session_start` event.
    ev(4, 'idle', { transcript: null }),
  ]);
  assert.equal(s.lanes.get('demo#lane1').transcript, '/tmp/b.jsonl');
});

test('applyEvents resets transcript on session_start, so a new session never inherits the outgoing one\'s value', () => {
  const s = applyEvents(createState(), [
    ev(1, 'session_start', { transcript: '/tmp/old-session.jsonl' }),
    ev(2, 'idle'),
    // A fresh session in the same lane, with no transcript_path of its own —
    // this must NOT fall back to the previous session's path via `??`.
    ev(3, 'session_start', { transcript: null }),
  ]);
  assert.equal(s.lanes.get('demo#lane1').transcript, null, 'must not inherit the outgoing session\'s transcript');

  const withPath = applyEvents(createState(), [
    ev(1, 'session_start', { transcript: '/tmp/old-session.jsonl' }),
    ev(2, 'session_start', { transcript: '/tmp/new-session.jsonl' }),
  ]);
  assert.equal(withPath.lanes.get('demo#lane1').transcript, '/tmp/new-session.jsonl');
});

test('render adds a ctx line under each lane row, live-toned while the session is active', () => {
  const p = writeTranscript('live.jsonl', [
    assistantLine('claude-sonnet-5', { input_tokens: 43000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 0 }),
  ]);
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: p })]);
  const lines = render(resolveContext(lane2), state).split('\n');
  const idx = lines.findIndex((l) => l.includes('lane1') && !l.includes('lane10'));
  assert.ok(idx !== -1, 'lane1 must have a row');
  const ctxLine = ctxPortion(lines[idx + 1]);
  assert.ok(!ctxLine.includes(DIM), 'must not be dimmed while the session is live');
  assert.equal(ctxLine.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').trim(), '143K ctx · sonnet-5');
});

test('render dims the ctx line once the session has closed, but keeps showing the last known value', () => {
  const p = writeTranscript('closed.jsonl', [
    assistantLine('claude-opus-4-8', { input_tokens: 900000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 0 }),
  ]);
  const state = applyEvents(createState(), [ev(1, 'session_start', { transcript: p }), ev(2, 'session_end')]);
  const lines = render(resolveContext(lane2), state).split('\n');
  const idx = lines.findIndex((l) => l.includes('lane1') && !l.includes('lane10'));
  const ctxLine = ctxPortion(lines[idx + 1]);
  assert.ok(ctxLine.includes(DIM), 'must be dimmed once the session has closed');
  assert.equal(ctxLine.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').trim(), '1.0M ctx · opus-4-8');
});

test('render shows — in the ctx line when no transcript has ever been recorded for the lane', () => {
  const lines = render(resolveContext(lane2), createState()).split('\n');
  const idx = lines.findIndex((l) => l.includes('lane3'));
  assert.ok(idx !== -1, 'lane3 must have a row');
  const ctxLine = ctxPortion(lines[idx + 1]);
  assert.ok(ctxLine.includes(DIM), 'no live session either, so dimmed');
  assert.equal(ctxLine.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').trim(), '—');
});

test('render uses a supplied ctxInfo map instead of reading the transcript itself — the throttle runUi relies on', () => {
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/never/actually/read.jsonl' })]);
  const ctxInfo = new Map([['/never/actually/read.jsonl', { tokens: 2000, model: 'claude-sonnet-5' }]]);
  const lines = render(resolveContext(lane2), state, Date.now(), undefined, ctxInfo).split('\n');
  const idx = lines.findIndex((l) => l.includes('lane1') && !l.includes('lane10'));
  assert.ok(idx !== -1, 'lane1 must have a row');
  const stripped = ctxPortion(lines[idx + 1]).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  assert.equal(stripped.trim(), '2K ctx · sonnet-5', 'must read the supplied map, never touch the (nonexistent) file on disk');
});

test('render treats a transcript missing from ctxInfo as unknown, not as licence to read it directly', () => {
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/some/real/path.jsonl' })]);
  const lines = render(resolveContext(lane2), state, Date.now(), undefined, new Map()).split('\n');
  const idx = lines.findIndex((l) => l.includes('lane1') && !l.includes('lane10'));
  const stripped = ctxPortion(lines[idx + 1]).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  assert.equal(stripped.trim(), '—', 'a throttled cache miss shows — until the next refresh, not a fresh direct read');
});

test('the ctx line dims for CLI-driven events too — reviewed is not a liveness signal, same reasoning as stage', () => {
  const state = applyEvents(createState(), [
    ev(1, 'session_start', { transcript: '/tmp/x.jsonl' }),
    ev(2, 'reviewed'), // /gate marked it clean — unrelated to whether a session is attached
  ]);
  const ctxInfo = new Map([['/tmp/x.jsonl', { tokens: 5000, model: 'claude-sonnet-5' }]]);
  const lines = render(resolveContext(lane2), state, Date.now(), undefined, ctxInfo).split('\n');
  const idx = lines.findIndex((l) => l.includes('lane1') && !l.includes('lane10'));
  assert.ok(ctxPortion(lines[idx + 1]).includes(DIM), '"reviewed" must not read as a live session, even right after one closed');
});

test('render never throws when a lane carries a transcript path that no longer resolves to anything readable', () => {
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/nowhere/gone.jsonl' })]);
  assert.doesNotThrow(() => render(resolveContext(lane2), state));
});

// ── hooks/emit.mjs: which hooks carry `transcript`, and which never do ──
const runEmitHook = (payload) =>
  execFileSync('node', [join(ROOT, 'hooks', 'emit.mjs')], { input: JSON.stringify(payload), encoding: 'utf8' });

test('emit.mjs: SessionStart and Stop forward transcript_path onto the emitted event', () => {
  runEmitHook({
    hook_event_name: 'SessionStart',
    cwd: lane2,
    session_id: 'emit-session-start-with-path',
    source: 'startup',
    transcript_path: '/tmp/emit-a.jsonl',
  });
  const started = readEvents().findLast((e) => e.session === 'emit-session-start-with-path');
  assert.ok(started, 'SessionStart must emit session_start');
  assert.equal(started.ev, 'session_start');
  assert.equal(started.detail, 'startup');
  assert.equal(started.transcript, '/tmp/emit-a.jsonl');

  runEmitHook({
    hook_event_name: 'Stop',
    cwd: lane2,
    session_id: 'emit-stop-with-path',
    transcript_path: '/tmp/emit-b.jsonl',
  });
  const stopped = readEvents().findLast((e) => e.session === 'emit-stop-with-path');
  assert.ok(stopped, 'Stop must emit idle');
  assert.equal(stopped.ev, 'idle');
  assert.equal(stopped.transcript, '/tmp/emit-b.jsonl');
});

test('emit.mjs: Stop with no transcript_path in the payload still writes an explicit null, not a missing key', () => {
  runEmitHook({ hook_event_name: 'Stop', cwd: lane2, session_id: 'emit-stop-no-path' });
  const stopped = readEvents().findLast((e) => e.session === 'emit-stop-no-path');
  assert.ok(stopped, 'Stop must still emit idle with no transcript_path in the payload');
  assert.equal(
    Object.prototype.hasOwnProperty.call(stopped, 'transcript'),
    true,
    'Stop always contributes a transcript key, even when the value is null',
  );
  assert.equal(stopped.transcript, null);
});

test('emit.mjs: UserPromptSubmit and SessionEnd never carry a transcript key, unlike Stop/SessionStart', () => {
  runEmitHook({
    hook_event_name: 'UserPromptSubmit',
    cwd: lane2,
    session_id: 'emit-user-prompt',
    transcript_path: '/tmp/should-not-appear.jsonl',
  });
  const prompted = readEvents().findLast((e) => e.session === 'emit-user-prompt');
  assert.ok(prompted, 'UserPromptSubmit must still emit busy');
  assert.equal(prompted.ev, 'busy');
  assert.equal(
    Object.prototype.hasOwnProperty.call(prompted, 'transcript'),
    false,
    'transcript_path must not leak onto every hook — only Stop/SessionStart carry it, to avoid growing the log on the highest-frequency hook',
  );

  runEmitHook({
    hook_event_name: 'SessionEnd',
    cwd: lane2,
    session_id: 'emit-session-end',
    reason: 'clear',
    transcript_path: '/tmp/should-not-appear-either.jsonl',
  });
  const ended = readEvents().findLast((e) => e.session === 'emit-session-end');
  assert.ok(ended, 'SessionEnd must still emit session_end');
  assert.equal(ended.ev, 'session_end');
  assert.equal(ended.detail, 'clear');
  assert.equal(Object.prototype.hasOwnProperty.call(ended, 'transcript'), false);
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
