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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ESC = String.fromCharCode(27);

// render() sizes and even drops columns (CTX below 85) based on
// process.stdout.columns — deterministic here regardless of the real
// terminal this suite happens to run in. Tests that specifically exercise a
// different width save and restore this around their own body.
process.stdout.columns = 100;

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
const { diffFingerprint, changedLineCount, writeMark, readMark, REVIEW_MARK, BYPASS_MARK } = await import(
  `${ROOT}/lib/marks.mjs`
);
const { createState, applyEvents, render, notifyTitle, fmtTokens, fmtElapsed, liveTransitionNotifications, pruneSessionHistory } = await import(
  `${ROOT}/ui/dashboard.mjs`
);
const { readContext } = await import(`${ROOT}/lib/transcript.mjs`);
const { readLiveStatuses, SESSIONS_DIR } = await import(`${ROOT}/lib/live-status.mjs`);
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
const guard = (cwd, command, opts = {}) => {
  const payload = JSON.stringify({
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    ...(opts.session_id ? { session_id: opts.session_id } : {}),
  });
  const out = execFileSync('node', [join(ROOT, 'hooks', 'commit-guard.mjs')], {
    input: payload,
    encoding: 'utf8',
    ...(opts.env ? { env: opts.env } : {}),
  });
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

test('a commit blocked by the guard writes commit_blocked tagged with the session id from the hook\'s own payload (#13)', () => {
  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const sessionTag1 = 1;\n');
  assert.equal(
    guard(lane2, 'git commit -m wip', { session_id: 'guard-session-blocked' }),
    'deny',
    'an unreviewed diff must still be denied, session tagging must not change that',
  );
  const blocked = readEvents().findLast((e) => e.session === 'guard-session-blocked');
  assert.ok(blocked, 'commit_blocked must carry the session id from the hook payload');
  assert.equal(blocked.ev, 'commit_blocked');
});

test('the guard writes session: null, not a fabricated id, when the hook payload carries no session_id (#13)', () => {
  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const sessionTag2 = 2;\n');
  const before = readEvents().length;
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  assert.equal(guard(lane2, 'git commit -m wip', { env }), 'deny');
  const events = readEvents();
  assert.ok(events.length > before, 'guard must still block and emit');
  assert.equal(events.at(-1).ev, 'commit_blocked');
  assert.equal(events.at(-1).session, null, 'no session_id in the hook payload, and the env was unset — must be null, never throw');
});

test('a commit allowed by a fresh review mark writes commit_reviewed tagged with the session id from the hook payload (#13)', () => {
  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const sessionTag3 = 3;\n');
  writeMark(lane2, REVIEW_MARK, diffFingerprint(lane2));
  assert.equal(guard(lane2, 'git commit -m wip', { session_id: 'guard-session-reviewed' }), 'allow');
  const reviewed = readEvents().findLast((e) => e.session === 'guard-session-reviewed');
  assert.ok(reviewed, 'commit_reviewed must carry the session id from the hook payload, same as commit_blocked does');
  assert.equal(reviewed.ev, 'commit_reviewed');
});

test('a commit allowed by a one-shot bypass mark writes commit_bypass tagged with the session id from the hook payload (#13)', () => {
  appendFileSync(join(lane2, 'src', 'a.ts'), 'export const sessionTag4 = 4;\n');
  writeMark(lane2, BYPASS_MARK, diffFingerprint(lane2));
  assert.equal(guard(lane2, 'git commit -m wip', { session_id: 'guard-session-bypass' }), 'allow');
  const bypassed = readEvents().findLast((e) => e.session === 'guard-session-bypass');
  assert.ok(bypassed, 'commit_bypass must carry the session id from the hook payload, same as commit_blocked does');
  assert.equal(bypassed.ev, 'commit_bypass');
});

// ── Session attribution (#13) ───────────────────────────────────────
test('emit() falls back to CLAUDE_CODE_SESSION_ID only when the event carries no session of its own', () => {
  const original = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session-xyz';
    emit({ ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', session: 'explicit-session', detail: 'explicit-wins' });
    const explicit = readEvents().findLast((e) => e.detail === 'explicit-wins');
    assert.equal(explicit.session, 'explicit-session', 'an event-provided session must win over the env fallback');

    emit({ ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', detail: 'no-explicit-session' });
    const fallback = readEvents().findLast((e) => e.detail === 'no-explicit-session');
    assert.equal(fallback.session, 'env-session-xyz', 'with no session on the event, CLAUDE_CODE_SESSION_ID fills it in');
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = original;
  }
});

test('emit() writes session: null, never throws, when neither the event nor the environment has one', () => {
  const original = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    assert.doesNotThrow(() => emit({ ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', detail: 'no-session-anywhere' }));
    const written = readEvents().findLast((e) => e.detail === 'no-session-anywhere');
    assert.equal(written.session, null);
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = original;
  }
});

test('emit() treats an event with an explicit session: undefined as owning the key, so it still does not fall back to the env', () => {
  // hasOwnProperty, not a truthy/nullish check, is what decides whose session
  // wins (see the comment above emit()) — a key that is *present* but holds
  // undefined must still count as the caller's own decision, exactly like a
  // present `null` does for a hook that read no session_id. No real call site
  // does this today (hooks always pass session or null; the CLI omits the key
  // entirely), but the mechanism is what makes that split correct.
  const original = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session-should-be-ignored';
    emit({ ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', session: undefined, detail: 'explicit-undefined-session' });
    const line = readFileSync(join(LANES_DIR, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .findLast((l) => l.includes('explicit-undefined-session'));
    assert.ok(line, 'the event must still be written');
    assert.ok(
      !line.includes('"session"'),
      'JSON.stringify drops a key whose value is undefined, so an explicit session: undefined never persists as null or as the env value, only as an absent key',
    );
    const parsed = JSON.parse(line);
    assert.equal(
      parsed.session, undefined,
      'own-property-but-undefined must not fall back to CLAUDE_CODE_SESSION_ID',
    );
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = original;
  }
});

// ── Dashboard state ─────────────────────────────────────────────────
const ev = (ts, e, extra = {}) => ({ ts, ev: e, project: 'demo', lane: 1, worktree: 'lane1', ...extra });

// WORKTREE is no longer its own column (the lane redesign dropped it), so a
// row can no longer be found by searching for e.g. 'lane1' as text — only the
// lane number is still rendered, left-padded to 3 columns. Matching the exact
// padded prefix (not a bare `startsWith(String(n))`) is what keeps lane 1 from
// matching lane 10's row too.
const rowPrefix = (n) => String(n).padEnd(3);

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

test('lane_created also sets the row\'s own ev to lane_created, the same way lane_reset does — not just branch/issue/stage', () => {
  // The only pre-existing assertion on lane_created (above, in "lane_removed
  // deletes the lane outright") checks issue/stage/branch but never row.ev
  // itself. LANE_LIFECYCLE (#14 Phase 4) must never touch this per-lane
  // fold — this guards the case where that exclusion is accidentally scoped
  // too broadly, since the sibling lane_reset assertion above only proves
  // that specific event, not lane_created.
  const s = applyEvents(createState(), [ev(1, 'lane_created', { branch: 'feat/999-other' })]);
  const row = s.lanes.get('demo#lane1');
  assert.equal(row.ev, 'lane_created', 'the per-lane fold must set ev on a lane_created event itself');
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

test('render has no STAGE column at all — a bare stage marker shows only as "no session seen"', () => {
  const frame = render(resolveContext(lane2), applyEvents(createState(), [ev(1, 'stage', { stage: 'implement' })]));
  const table = frame.slice(0, frame.indexOf('RECENT')); // RECENT is a log; "stage: X" is fine there, checked separately below
  assert.ok(!table.includes('implement'), 'STAGE has no column in the live table — the stage name must not appear there');
  assert.ok(table.includes('no session seen'), 'a bare stage marker is not a state, and must not be painted as one');

  const recent = frame.slice(frame.indexOf('RECENT'));
  assert.ok(recent.includes('stage: implement'), 'RECENT is unchanged — it still logs the raw stage event with its merged label');
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
  assert.ok(frame.includes('feat/402-thing'), 'declared lanes appear even with no events of their own');
});

test('render shows a declared lane with no events at all as offline', () => {
  const frame = render(resolveContext(lane2), createState());
  assert.ok(frame.includes('feat/403-thing'));
  assert.ok(frame.includes('offline'));
});

test('MARKS renders ? when the base ref cannot be resolved — never free, never a bare —', () => {
  // The fixture repo has no `origin` remote, so `enumerateLanes` can never
  // resolve `origin/main...HEAD` — every lane's baseKnown is false.
  const frame = render(resolveContext(lane2), createState());
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(3)));
  assert.ok(row, 'lane3 must have a row');
  assert.ok(row.includes('feat/403-thing (?)'), 'unknown divergence must render as (?), distinct from both (free) and no marks at all');
});

test('MARKS renders dirty, ahead and behind together through the laneInfo seam, right after the issue', () => {
  // Fabricated laneInfo, bypassing the real `enumerateLanes` git read — this
  // is the only way to exercise the coloured, non-"?" formatting path, since
  // the fixture repo (no `origin`) always makes the real read baseKnown: false.
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/9-x',
    isBase: false, dirty: true, dirtyCount: 3, ahead: 2, behind: 1, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  // The ANSI codes wrapped around the marks tokens must not shift what comes
  // before them — the regression the pad-then-colour ordering in branchCell
  // guards against — so issue, branch and marks must all read correctly, in
  // order, out of the same cell.
  assert.ok(row.includes('[#9] feat/9-x (~3 +2 -1)'), 'dirty, ahead and behind must all render together, right after the issue and branch');
});

test('MARKS renders free for a clean lane on base once the base ref actually resolves', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'main',
    isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row.includes('main (free)'), 'clean and on base, with a resolvable base ref, must render (free) — never (?)');
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
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
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
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
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
  const row = frame.split('\n').find((l) => l.includes('feat/401-thing'));
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

test('laneMarks: on-base! pre-empts free — a lane holding the base branch itself is flagged even though isFree would still call it free', () => {
  const marks = worktrees.laneMarks({ holdsBaseBranch: true, dirty: false, baseKnown: true, ahead: 0, behind: 0 });
  assert.deepEqual(marks, [{ text: 'on-base!', tone: 'danger' }]);
});

test('lanes status --once shows a dirty lane as ~N', () => {
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['status', '--once'], { cwd: repo, encoding: 'utf8' });
  const row = output.split('\n').find((l) => l.includes('feat/402-thing'));
  assert.ok(row, 'lane2 must have a row');
  assert.match(row, /~\d+/, 'lane2 has real uncommitted changes from earlier tests, so ~N must still show');
});

test('lanes status (no --once) falls back to a single printStatus frame when stdout is not a TTY', () => {
  // execFileSync captures stdout into a pipe, so process.stdout.isTTY is
  // false in the child — same as any non-interactive caller (a script, or an
  // agent's own Bash call). watchStatus must detect that and return a single
  // printStatus() frame instead of hiding the cursor and looping forever with
  // setInterval + `await new Promise(() => {})`, which would hang this test
  // until the timeout below kills it.
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['status'], { cwd: repo, encoding: 'utf8', timeout: 5000 });
  const row = output.split('\n').find((l) => l.includes('feat/402-thing'));
  assert.ok(row, 'lane2 must have a row, same shape as --once');
  assert.match(row, /~\d+/, 'same dirty-lane content as --once');
  assert.equal(
    output.split('agent-system').length - 1,
    1,
    'exactly one frame — a looping redraw would repeat the title on every tick',
  );
  assert.ok(!output.includes(`${ESC}[2J`), 'must not clear the screen — that is the interactive loop only');
  assert.ok(!output.includes(`${ESC}[?25l`), 'must not hide the cursor — that is the interactive loop only');
  assert.ok(!output.includes('ctrl-c to quit'), 'the interactive footer must not appear in the one-shot fallback');
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
  // Pins the isBase/holdsBaseBranch distinction on the exact lane a fresh
  // `lanes new`/`reset` leaves behind: merely detached at base's commit,
  // never the base branch itself, so on-base! must not fire for it.
  assert.equal(lane.holdsBaseBranch, false, 'detached at the same commit as base is not the same as holding the base branch itself');
  assert.deepEqual(worktrees.laneMarks(lane), [{ text: 'free', tone: 'free' }]);
});

test('enumerateLanes sets holdsBaseBranch (and MARKS on-base!) only when a lane literally has the base branch checked out, not merely detached at its commit', () => {
  const { main, wtd, cfg } = makeLanesFixture('holds-base', 1);
  const lanePath = join(wtd, 'lane1');
  // git refuses to check out a branch that is already checked out in another
  // worktree, so `main` must vacate the base branch first — the same reason
  // this state is only reachable in practice via `lanes switch <lane> <base>`
  // without --create.
  git(main, 'checkout', '-qb', 'parking-branch');
  git(lanePath, 'checkout', 'main');

  const lane = worktrees.enumerateLanes(cfg)[0];
  assert.equal(lane.holdsBaseBranch, true, 'the lane has the literal base branch checked out');
  assert.equal(lane.isBase, true);
  assert.deepEqual(
    worktrees.laneMarks(lane),
    [{ text: 'on-base!', tone: 'danger' }],
    'on-base! must appear, pre-empting free even though isFree(lane) is still true (clean, level with base)',
  );
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

// boundPort is a pure helper the dashboard's serviceCell (ui/dashboard.mjs)
// consumes, so its own branches — not running, running-and-matching,
// running-and-diverged, and a pidfile that never recorded a port — get direct
// coverage here rather than only indirectly through the renderer.
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

// ── Dashboard: conditional service line ──────────────────────────────
const stripAnsi = (s) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

/**
 * The service line directly under a lane's own row, or `null` when none was
 * rendered — the line is now conditional (present only when something is
 * actually running), not a fixed second line with a `—` placeholder, so
 * "no line at all" is itself a real, asserted outcome, not just an empty
 * string. A service line is the only thing that can start with a leading
 * space: every lane row starts with its (unpadded) number or `·`, and RECENT
 * rows start with a clock.
 */
function serviceLineFor(frame, matchesRow) {
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex(matchesRow);
  assert.ok(idx !== -1, 'the row must exist');
  const next = lines[idx + 1];
  return next && next.startsWith(' ') ? next.trim() : null;
}

test('dashboard: no dev.services declared shows no service line at all', () => {
  const lane = worktrees.enumerateLanes(wtCfg)[0];
  const ctx = { ...resolveContext(lane2), config: wtCfg };
  const frame = render(ctx, createState(), Date.now(), [lane]);
  assert.equal(serviceLineFor(frame, (l) => l.startsWith(rowPrefix(lane.lane))), null);
});

test('dashboard: services declared but none running shows no service line at all', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[0]; // lane1
  // Precondition, not an assumption: an earlier test (`start records pid and
  // port…`) starts and stops `web` on this exact lane, with no try/finally —
  // if its own assertions ever throw between start and stop, this test would
  // otherwise fail on a leftover running process and blame the wrong code.
  assert.equal(sv.status(sv.resolveServices(svcCfg, lane)[0]).running, false, 'precondition: no service left running on lane1 by an earlier test');
  const ctx = { ...resolveContext(lane2), config: svcCfg };
  const frame = render(ctx, createState(), Date.now(), [lane]);
  // Conditional on something actually running, not on the formatted text —
  // the old placeholder-with-count ('— (+1 more)') is gone entirely now, not
  // just its wording, since it would otherwise show a line for a lane where
  // nothing is up.
  assert.equal(serviceLineFor(frame, (l) => l.startsWith(rowPrefix(lane.lane))), null);
});

test('dashboard: first declared service running with a url template shows the resolved URL, plus a count of the rest', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[1]; // lane2, lane 2
  const [web] = sv.resolveServices(svcCfg, lane);
  const started = sv.start(web);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  try {
    const ctx = { ...resolveContext(lane2), config: svcCfg };
    const frame = render(ctx, createState(), Date.now(), [lane]);
    assert.equal(serviceLineFor(frame, (l) => l.startsWith(rowPrefix(lane.lane))), 'http://localhost:3002 (+1 more)');
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
    assert.equal(serviceLineFor(frame, (l) => l.startsWith(rowPrefix(lane.lane))), 'http://localhost:3501! (+1 more)');
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
    assert.equal(serviceLineFor(frame, (l) => l.startsWith(rowPrefix(lane.lane))), 'localhost:4003');

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
    assert.equal(serviceLineFor(frameMoved, (l) => l.startsWith(rowPrefix(lane.lane))), 'localhost:4003!');
  } finally {
    sv.stop(api);
  }
});

test('dashboard: the second declared service running (not the first) is still detected and shown, with the count of the rest', () => {
  // Regression: serviceLine now scans every declared service for one that is
  // running, rather than checking only svcs[0] — see the comment above it in
  // ui/dashboard.mjs. Before that fix, this exact scenario (web declared but
  // never started, api started) rendered no line at all.
  const lane = worktrees.enumerateLanes(svcCfg)[2]; // lane3, untouched by any earlier service test
  const [, api] = sv.resolveServices(svcCfg, lane);
  const started = sv.start(api);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  try {
    const ctx = { ...resolveContext(lane2), config: svcCfg };
    const frame = render(ctx, createState(), Date.now(), [lane]);
    assert.equal(
      serviceLineFor(frame, (l) => l.startsWith(rowPrefix(lane.lane))),
      'localhost:4003 (+1 more)',
      'the running second service must be found and shown, with the count of the other declared service',
    );
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
    serviceLineFor(frame, (l) => l.includes('demo-ghost-2')),
    null,
    'no .name must never reach resolveServices, regardless of what the project declares — no line renders at all',
  );
});

test('lanes status --once SERVICE cell: boundPort wiring shows the bound port and the ! marker on divergence', () => {
  // A dedicated fixture, not svcCfg/wtDir: this needs dev.services in the
  // *committed* config the real `lanes status` CLI reads from `cwd`, which the
  // shared repo/wtDir fixture deliberately does not declare.
  const main = join(TMP, 'status-services');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@test.test');
  git(main, 'config', 'user.name', 'test');
  mkdirSync(join(main, '.claude'));
  const svcWtDir = join(TMP, 'status-services-wts');
  const cfgPath = join(main, '.claude', 'agent-system.json');
  const cfg = {
    project: 'status-services',
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
    const before = execFileSync(join(ROOT, 'bin', 'lanes'), ['status', '--once'], { cwd: main, encoding: 'utf8' });
    assert.match(before, /localhost:3001(?!!)/, 'running, matching port: no ! marker');

    // Not a renumber — lane numbers no longer move at all (D26). Editing the
    // committed portBase is now the only way a bound port and a fresh
    // computation can disagree while the service stays up. Bookkeeping is
    // keyed by worktree name, so the same pid file — and its recorded port,
    // 3001 — still applies, but a fresh computation now disagrees (3501).
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, dev: { services: [{ ...cfg.dev.services[0], portBase: 350 }] } }));
    const after = execFileSync(join(ROOT, 'bin', 'lanes'), ['status', '--once'], { cwd: main, encoding: 'utf8' });
    assert.match(after, /localhost:3001!/, 'the bound port is shown, marked !, once portBase changes under it');
  } finally {
    sv.stop(web);
  }
});

test('lanes dev: no dev.services declared warns and points at a section that actually exists in docs/SETUP.md', () => {
  // `repo` (the shared fixture) declares no dev.services and has real lanes,
  // so `select()` resolves targets but resolveServices yields nothing for
  // any of them — the `if (!any)` warning branch this diff's message lives in.
  const output = execFileSync(join(ROOT, 'bin', 'lanes'), ['dev'], { cwd: repo, encoding: 'utf8' });
  assert.match(output, /no services declared/);
  assert.match(output, /see "5\. Managing lanes" in docs\/SETUP\.md\./);

  // Pins the exact class of bug this text fixed: the hint used to point at a
  // "Dev services" section of docs/SETUP.md that never existed. Asserting the
  // referenced heading is real guards against it going stale again silently.
  const setupDoc = readFileSync(join(ROOT, 'docs', 'SETUP.md'), 'utf8');
  assert.match(setupDoc, /^## 5\. Managing lanes$/m, 'the section named in the hint must exist');
});

// ── Dashboard: header, rule width and lane spacing ────────────────────
test('CTX is a real header column on the main row, not a separate line — SERVICE has no column at all, only a conditional line', () => {
  const ctxInfo = new Map([['/tmp/aligned.jsonl', { tokens: 2000, model: 'claude-sonnet-5' }]]);
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/tmp/aligned.jsonl' })]);
  const lane = worktrees.enumerateLanes(wtCfg)[0]; // lane1, no dev.services declared under wtCfg
  const ctx = { ...resolveContext(lane2), config: wtCfg };
  const frame = render(ctx, state, Date.now(), [lane], ctxInfo);
  const lines = stripAnsi(frame).split('\n');

  const headerLine = lines.find((l) => l.includes('BRANCH'));
  assert.ok(headerLine.includes('CTX'), 'CTX must be one of the header columns');
  assert.ok(!headerLine.includes('SERVICE'), 'SERVICE has no column — it is a conditional line, never a header');

  const row = lines.find((l) => l.startsWith(rowPrefix(lane.lane)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('2K·sonnet-5'), 'the ctx value sits on the lane\'s own row, not a line below it');
  assert.equal(
    serviceLineFor(frame, (l) => l.startsWith(rowPrefix(lane.lane))),
    null,
    'no dev.services declared means no service line at all',
  );
});

test('the rule under the header is never shorter than the header row, even on a terminal narrower than it', () => {
  const originalColumns = process.stdout.columns;
  try {
    process.stdout.columns = 60; // far narrower than the ~100-column capped header
    const frame = render(resolveContext(lane2), createState());
    const lines = stripAnsi(frame).split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('BRANCH'));
    const headerLine = lines[headerIdx];
    const sepLine = lines[headerIdx + 1]; // header, then the rule directly
    assert.ok(/^─+$/.test(sepLine) && sepLine.length > 0, 'the line right below the header must be the rule');
    assert.equal(
      sepLine.length,
      headerLine.length,
      'the rule must stretch to cover the header exactly, not stop short at the narrower terminal width',
    );
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('the title bar and the header rule share one capped width now that the header has no separate wider cap', () => {
  const originalColumns = process.stdout.columns;
  try {
    process.stdout.columns = 60;
    const frame = render(resolveContext(lane2), createState());
    const lines = stripAnsi(frame).split('\n');
    const titleLine = lines[0];
    const headerLine = lines.find((l) => l.includes('BRANCH'));
    assert.equal(titleLine.length, headerLine.length, 'both are capped at the same floored terminal width now that the header no longer has its own separate, wider cap');
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('the frame stays capped at 100 columns even on a much wider terminal — the deliberate one-way trade', () => {
  const originalColumns = process.stdout.columns;
  try {
    process.stdout.columns = 200;
    const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/tmp/wide.jsonl' })]);
    const frame = render(resolveContext(lane2), state);
    const table = frame.slice(0, frame.indexOf('RECENT'));
    const lines = stripAnsi(table).split('\n').filter((l) => l.trim());
    assert.ok(lines.length > 0, 'the table must have rendered something to check');
    for (const line of lines) {
      assert.ok(line.length <= 100, `line exceeds 100 columns at terminal width 200: "${line}"`);
    }
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('below 85 columns CTX drops out entirely, rather than starving BRANCH', () => {
  const originalColumns = process.stdout.columns;
  try {
    process.stdout.columns = 80;
    const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/tmp/narrow.jsonl' })]);
    const ctxInfo = new Map([['/tmp/narrow.jsonl', { tokens: 2000, model: 'claude-sonnet-5' }]]);
    const frame = render(resolveContext(lane2), state, Date.now(), undefined, ctxInfo);
    const lines = stripAnsi(frame).split('\n');
    const headerLine = lines.find((l) => l.includes('BRANCH'));
    assert.ok(!headerLine.includes('CTX'), 'CTX column must be gone below the 85-column threshold');
    const row = lines.find((l) => l.startsWith(rowPrefix(1)));
    assert.ok(row, 'lane1 must have a row');
    assert.ok(!row.includes('sonnet-5'), 'no ctx value should render anywhere on the row either');
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('CTX_MIN_TERM_WIDTH is an inclusive floor: exactly 85 columns keeps CTX, 84 drops it', () => {
  const originalColumns = process.stdout.columns;
  try {
    process.stdout.columns = 85;
    const atThreshold = stripAnsi(render(resolveContext(lane2), createState()));
    const headerAt = atThreshold.split('\n').find((l) => l.includes('BRANCH'));
    assert.ok(headerAt.includes('CTX'), 'CTX must still show at exactly the threshold width (>=, not >)');

    process.stdout.columns = 84;
    const belowThreshold = stripAnsi(render(resolveContext(lane2), createState()));
    const headerBelow = belowThreshold.split('\n').find((l) => l.includes('BRANCH'));
    assert.ok(!headerBelow.includes('CTX'), 'one column narrower must drop CTX');
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('when the row is tight, only the branch name shrinks — issue and marks always render in full', () => {
  const longBranch = 'feat/1234-a-genuinely-quite-long-branch-name-that-will-not-fit';
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: longBranch,
    isBase: false, dirty: true, dirtyCount: 7, ahead: 3, behind: 2, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('[#1234] '), 'the issue must render in full');
  assert.ok(row.includes('(~7 +3 -2)'), 'the marks must render in full, never sacrificed to make room for the branch');
  assert.ok(row.includes('…'), 'the branch name itself is what shrinks');
  assert.ok(!row.includes(longBranch), 'the full branch name must not have fit verbatim');
});

test('STATE never truncates any real STATES label, including the two shortened to fit', () => {
  const state = applyEvents(createState(), [ev(1, 'commit_blocked')]);
  const frame = render(resolveContext(lane2), state);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('■ blocked, needs review'), 'the longest STATE label must render in full, not ellipsised');
});

test('STATE also fits the longest real agent_start label this repo\'s own agents produce ("spec-challenger running")', () => {
  const state = applyEvents(createState(), [ev(1, 'agent_start', { agent: 'spec-challenger' })]);
  const frame = render(resolveContext(lane2), state);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('● spec-challenger running'), 'STATE_WIDTH was sized for this exact label — it must not truncate');
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
  assert.ok(lines[sepIdx + 1].startsWith(rowPrefix(1)), 'the only lane\'s row must start right after the rule, with no leading blank');
  // No service declared, so no conditional line follows the row — the blank
  // separator comes right after it, not one line further down.
  assert.equal(lines[sepIdx + 2], '', 'exactly one blank line must separate the only lane\'s block from RECENT');
  assert.ok(lines[sepIdx + 3].includes('RECENT'));
});

test('render inserts exactly one blank line between two lanes, and one more before RECENT after the last', () => {
  const two = [
    { lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'main', isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true },
    { lane: 2, name: 'lane2', path: join(wtDir, 'lane2'), branch: 'main', isBase: true, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true },
  ];
  const frame = render(resolveContext(lane2), createState(), Date.now(), two);
  const lines = stripAnsi(frame).split('\n');
  const sepIdx = lines.findIndex((l) => /^─+$/.test(l));
  assert.ok(lines[sepIdx + 1].startsWith(rowPrefix(1)), 'no leading blank before the first lane');
  assert.equal(lines[sepIdx + 2], '', 'exactly one blank line between the first lane\'s block and the second\'s');
  assert.ok(lines[sepIdx + 3].startsWith(rowPrefix(2)), 'the second lane follows right after that single blank');
  assert.equal(lines[sepIdx + 4], '', 'one blank line before RECENT after the last lane');
  assert.ok(lines[sepIdx + 5].includes('RECENT'));
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
  for (const sub of ['lanes status', 'lanes dev', 'lanes doctor', 'lanes reviewed']) {
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

// Every CLI-level lane test needs its own throwaway fixture, not the shared
// repo/wtDir: several of them (rm, clear, reset, doctor with a stray
// directory) actually remove or rewrite lane directories, and later tests in
// this file (the ctx/render suite) rely on the shared wtDir keeping its real
// lane1..lane3 on disk throughout the run. `extend` lets a caller write a
// modified config (e.g. adding dev.services) without duplicating the
// fixture/config-write dance just to change one field.
function makeCliLanesFixture(name, laneCount, extend) {
  const { main, wtd, cfg } = makeLanesFixture(name, laneCount);
  const written = extend ? extend(cfg) : cfg;
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'agent-system.json'), JSON.stringify(written));
  return { main, wtd, cfg: written };
}

test('lanes rm with no argument removes the top lane, not every lane', () => {
  const { main, wtd, cfg } = makeCliLanesFixture('cli-rm-top', 3);
  execFileSync(join(ROOT, 'bin', 'lanes'), ['rm'], { cwd: main, encoding: 'utf8' });
  const removed = readEvents().findLast((e) => e.project === cfg.project && e.ev === 'lane_removed');
  assert.equal(removed.lane, 3, 'bare rm pops the current top of the stack');
  assert.equal(worktrees.enumerateLanes(cfg).length, 2, 'only the top lane is gone');
  assert.equal(existsSync(join(wtd, 'lane2')), true, 'lower lanes are untouched');
});

test('lanes rm all is refused — removing every lane needs `lanes clear`', () => {
  const { main, cfg } = makeCliLanesFixture('cli-rm-all', 2);
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', 'all'], { cwd: main, stdio: 'pipe' }),
    /lanes clear/,
  );
  assert.equal(worktrees.enumerateLanes(cfg).length, 2, 'refused before touching anything');
});

test('lanes rm refuses a range — it removes exactly one lane, never several', () => {
  const { main, cfg } = makeCliLanesFixture('cli-rm-range', 2);
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', '1-2'], { cwd: main, stdio: 'pipe' }),
    /always removes the top of the stack/,
  );
  assert.equal(worktrees.enumerateLanes(cfg).length, 2, 'refused before touching anything');
});

test('lanes clear refuses while any lane is dirty, same blockers as rm, and --force removes every lane', () => {
  const { main, wtd, cfg } = makeCliLanesFixture('cli-clear', 3);
  writeFileSync(join(wtd, 'lane2', 'dirty.txt'), 'x');

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['clear'], { cwd: main, stdio: 'pipe' }),
    /lane 2/,
  );
  assert.equal(worktrees.enumerateLanes(cfg).length, 3, 'refused before touching anything');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['clear', '--force'], { cwd: main, encoding: 'utf8' });
  assert.equal(worktrees.enumerateLanes(cfg).length, 0);
});

test('lanes clear with a lane argument refuses instead of silently removing every lane', () => {
  const { main, cfg } = makeCliLanesFixture('cli-clear-arg', 3);
  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['clear', '2'], { cwd: main, stdio: 'pipe' }),
    /lanes clear takes no lane/,
  );
  assert.equal(
    worktrees.enumerateLanes(cfg).length,
    3,
    'refused before touching anything — not narrowed to lane 2, and not the whole stack either',
  );
});

test('lanes clear succeeds on a stack with a gap left by removing a lane directory by hand', () => {
  const { main, wtd, cfg } = makeCliLanesFixture('cli-clear-gap', 3);
  // Not `lanes rm` — a directory deleted outside the tool, the way `doctor`'s
  // "stray directory" tests simulate drift, leaves lane numbering [1, 3] with
  // no 2. The contiguous-run guard exists to stop a *partial* removal from
  // stranding a number like this; `clear` must still take the whole stack.
  rmSync(join(wtd, 'lane2'), { recursive: true, force: true });
  assert.deepEqual(worktrees.enumerateLanes(cfg).map((l) => l.lane), [1, 3], 'lane2 is gone from disk, leaving a gap');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['clear'], { cwd: main, encoding: 'utf8' });
  assert.equal(worktrees.enumerateLanes(cfg).length, 0, 'wholeStack skips the contiguous-run guard, so the gap does not block clear');
});

test('removeWorktree without wholeStack still refuses that same gapped stack, pinning the boundary', () => {
  const { wtd, cfg } = makeLanesFixture('rm-gap-boundary', 3);
  rmSync(join(wtd, 'lane2'), { recursive: true, force: true });
  const lanes = worktrees.enumerateLanes(cfg);
  assert.deepEqual(lanes.map((l) => l.lane), [1, 3], 'same gapped state as the clear test above');

  const res = worktrees.removeWorktree(cfg, lanes);
  assert.match(res.error, /top is lane 3/, 'the exact lanes clear would pass, minus wholeStack, is refused like any other non-contiguous selection');
  assert.equal(worktrees.enumerateLanes(cfg).length, 2, 'refused before touching anything');
});

test('lanes reset detaches a lane back to a clean base state through the real CLI', () => {
  const { main, wtd, cfg } = makeCliLanesFixture('cli-reset', 1);
  const lanePath = join(wtd, 'lane1');
  git(lanePath, 'checkout', '-b', 'feat/1-cli-reset');

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

// ── Session attribution (#13): CLI-driven events ─────────────────────
test('lanes reviewed/new/rm/reset each tag their emitted event with CLAUDE_CODE_SESSION_ID from the environment', () => {
  const { main, wtd, cfg } = makeCliLanesFixture('cli-session-set', 1);
  const withSession = { cwd: main, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'cli-session-abc' } };

  execFileSync(join(ROOT, 'bin', 'lanes'), ['reviewed'], withSession);
  const reviewed = readEvents().findLast((e) => e.ev === 'reviewed' && e.project === cfg.project);
  assert.equal(reviewed.session, 'cli-session-abc', 'lanes reviewed must tag its event with the session from the environment');

  const base = git(main, 'rev-parse', 'HEAD').trim();
  execFileSync(join(ROOT, 'bin', 'lanes'), ['new', '--from', base], withSession);
  const created = readEvents().findLast((e) => e.ev === 'lane_created' && e.project === cfg.project);
  assert.equal(created.session, 'cli-session-abc', 'lanes new must tag lane_created with the session');

  execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', String(created.lane)], withSession);
  const removed = readEvents().findLast((e) => e.ev === 'lane_removed' && e.project === cfg.project);
  assert.equal(removed.session, 'cli-session-abc', 'lanes rm must tag lane_removed with the session');

  git(join(wtd, 'lane1'), 'checkout', '-b', 'feat/13-session-reset');
  execFileSync(join(ROOT, 'bin', 'lanes'), ['reset', '1'], withSession);
  const reset = readEvents().findLast((e) => e.ev === 'lane_reset' && e.project === cfg.project);
  assert.equal(reset.session, 'cli-session-abc', 'lanes reset must tag lane_reset with the session');
});

test('the same four commands write session: null, and never throw, when CLAUDE_CODE_SESSION_ID is unset', () => {
  const { main, wtd, cfg } = makeCliLanesFixture('cli-session-unset', 1);
  const envWithoutSession = { ...process.env };
  delete envWithoutSession.CLAUDE_CODE_SESSION_ID;
  const noSession = { cwd: main, encoding: 'utf8', env: envWithoutSession };

  assert.doesNotThrow(() => execFileSync(join(ROOT, 'bin', 'lanes'), ['reviewed'], noSession));
  const reviewed = readEvents().findLast((e) => e.ev === 'reviewed' && e.project === cfg.project);
  assert.equal(reviewed.session, null);

  const base = git(main, 'rev-parse', 'HEAD').trim();
  assert.doesNotThrow(() => execFileSync(join(ROOT, 'bin', 'lanes'), ['new', '--from', base], noSession));
  const created = readEvents().findLast((e) => e.ev === 'lane_created' && e.project === cfg.project);
  assert.equal(created.session, null);

  assert.doesNotThrow(() => execFileSync(join(ROOT, 'bin', 'lanes'), ['rm', String(created.lane)], noSession));
  const removed = readEvents().findLast((e) => e.ev === 'lane_removed' && e.project === cfg.project);
  assert.equal(removed.session, null);

  git(join(wtd, 'lane1'), 'checkout', '-b', 'feat/13-session-reset-unset');
  assert.doesNotThrow(() => execFileSync(join(ROOT, 'bin', 'lanes'), ['reset', '1'], noSession));
  const reset = readEvents().findLast((e) => e.ev === 'lane_reset' && e.project === cfg.project);
  assert.equal(reset.session, null);
});

test('reset, switch and logs each refuse a multi-lane selector rather than silently acting on the first match', () => {
  const { main, wtd, cfg } = makeCliLanesFixture('cli-selectone', 3);
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
  const { main, wtd, cfg } = makeCliLanesFixture('cli-selectone-happy', 2, (c) => ({
    ...c,
    dev: { services: [{ name: 'web', command: 'true', portBase: 300 }] },
  }));

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

test('lanes switch warns when a plain switch lands on the base branch itself, but not when --create lands on a fresh feature branch', () => {
  const { main, cfg } = makeCliLanesFixture('cli-switch-warn', 2);
  // Vacate `main` from the main worktree first — git refuses to check out a
  // branch already checked out in another worktree, and this is the only
  // path (a plain switch, no --create) that can ever land on base at all.
  git(main, 'checkout', '-qb', 'parking-branch');

  const onBaseOut = execFileSync(join(ROOT, 'bin', 'lanes'), ['switch', '1', 'main'], { cwd: main, encoding: 'utf8' });
  assert.match(
    onBaseOut,
    /lane 1 now holds main itself — a commit here moves the shared branch, not just this lane's\./,
  );
  assert.equal(worktrees.enumerateLanes(cfg).find((l) => l.lane === 1).holdsBaseBranch, true);

  const createOut = execFileSync(
    join(ROOT, 'bin', 'lanes'),
    ['switch', '2', 'feat/switch-warn', '--create'],
    { cwd: main, encoding: 'utf8' },
  );
  assert.ok(!createOut.includes('now holds'), '--create always branches off base, never lands on base itself, so no WARN');
  assert.equal(worktrees.enumerateLanes(cfg).find((l) => l.lane === 2).holdsBaseBranch, false);
});

test('lanes switch dies with its own usage rather than misreading a lone positional as the branch', () => {
  const { main, cfg } = makeCliLanesFixture('cli-switch-usage', 1);

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
  const { main } = makeCliLanesFixture('cli-reset-usage', 1);

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['reset'], { cwd: main, stdio: 'pipe' }),
    /Usage: lanes reset <lane> \[--force\]/,
  );
});

test('lanes doctor warns about a directory under worktreesDir that does not match lane<N>', () => {
  const { main, wtd } = makeCliLanesFixture('doctor-stray', 1);
  mkdirSync(join(wtd, 'old-style-name'));

  const out = execFileSync(join(ROOT, 'bin', 'lanes'), ['doctor'], { cwd: main, encoding: 'utf8' });
  assert.match(out, /lane naming/);
  assert.match(out, /old-style-name/);
});

test('lanes free dies naming the stray directories when worktreesDir resolves but holds none matching lane<N>', () => {
  const { main, wtd } = makeCliLanesFixture('stray-only', 0); // no conforming lanes at all
  mkdirSync(join(wtd, 'wt1'));

  assert.throws(
    () => execFileSync(join(ROOT, 'bin', 'lanes'), ['free'], { cwd: main, stdio: 'pipe' }),
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
  // Pin the env fallback so the record's byte size is deterministic regardless
  // of whether the process this suite runs under happens to carry a real
  // CLAUDE_CODE_SESSION_ID (it does, e.g., inside a Claude Code session).
  const original = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const base = { ev: 'stage', project: 'demo', lane: 1, worktree: 'lane1', session: null };
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
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = original;
  }
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
 * CTX is the last cell on a lane's own row (not a separate line — that
 * changed when WORKTREE/STAGE were dropped to fit the row in 100 columns).
 * It is always preceded by the FOR cell's own reset, then a single join
 * space, so the second-to-last reset in the row marks where FOR ends and CTX
 * begins — the reliable place to split, since a fixed-width slice would break
 * the moment an earlier cell's width changes.
 */
function ctxPortion(row) {
  const lastReset = row.lastIndexOf(RESET);
  assert.ok(lastReset !== -1, 'the row must have at least one reset');
  const priorReset = row.lastIndexOf(RESET, lastReset - 1);
  assert.ok(priorReset !== -1, "the FOR cell's own reset must come before the ctx cell begins");
  return row.slice(priorReset + RESET.length, lastReset + RESET.length);
}

/** The real, colour-coded row for a given lane number — located via the ANSI-stripped copy, since the lane number itself sits behind an escape code. */
function rawRowFor(frame, laneNum) {
  const raw = frame.split('\n');
  const idx = stripAnsi(frame).split('\n').findIndex((l) => l.startsWith(rowPrefix(laneNum)));
  assert.ok(idx !== -1, `lane ${laneNum} must have a row`);
  return raw[idx];
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

test('fmtElapsed switches to d/h at the 24h boundary and stays within FOR_WIDTH', () => {
  assert.equal(fmtElapsed(23 * 3600e3 + 59 * 60e3), '23h59m', 'just under a day is still hours');
  assert.equal(fmtElapsed(24 * 3600e3), '1d00h', 'exactly a day rolls over to days');
  assert.equal(fmtElapsed(28 * 3600e3 + 15 * 60e3), '1d04h');

  const FOR_WIDTH = 7; // ui/dashboard.mjs sizes this column against the same constant
  for (const ms of [0, 999, 59 * 1000, 59 * 60e3 + 59 * 1000, 23 * 3600e3 + 59 * 60e3, 999 * 86400e3 + 23 * 3600e3]) {
    assert.ok(fmtElapsed(ms).length <= FOR_WIDTH, `fmtElapsed(${ms}) = "${fmtElapsed(ms)}" must fit FOR_WIDTH`);
  }
});

test('the FOR cell in a real row switches to d/h too — not just the unit function in isolation', () => {
  const state = createState();
  const since = Date.UTC(2020, 0, 1);
  const now = since + 30 * 3600e3 + 15 * 60e3; // 1d06h15m later
  state.lanes.set('demo#lane1', {
    project: 'demo', worktree: 'lane1', ev: 'idle', since,
    // A currently-declared lane bypasses the existsSync liveness check
    // entirely (see the test above), so no real path is needed here.
  });
  const frame = render(resolveContext(lane2), state, now);
  const row = stripAnsi(frame).split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('1d06h'), `render() must thread now - since through fmtElapsed into the FOR cell: "${row}"`);
  assert.ok(row.length <= 100, 'the row must still fit the 100-column cap once FOR widens from h/m to d/h');
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

test('applyEvents folds state.sessionHistory per session id, additively alongside state.lanes (#14 Phase 4)', () => {
  const s = applyEvents(createState(), [
    ev(1, 'session_start', { session: 'sess-a', transcript: '/tmp/a.jsonl' }),
    ev(2, 'idle', { session: 'sess-a' }),
  ]);
  assert.deepEqual(s.sessionHistory.get('sess-a'), { transcript: '/tmp/a.jsonl', ev: 'idle' });
  assert.ok(s.lanes.get('demo#lane1'), 'the existing per-lane fold must still happen, untouched');
});

test('applyEvents ignores an event with no session field for state.sessionHistory, but still folds it into state.lanes as before', () => {
  const s = applyEvents(createState(), [ev(1, 'idle')]);
  assert.equal(s.sessionHistory.size, 0, 'no session tag means nothing to key sessionHistory on');
  assert.ok(s.lanes.get('demo#lane1'), 'state.lanes folding is untouched by the absence of a session tag');
});

test('applyEvents: a stage event must not overwrite a session\'s folded ev, same rule as the per-lane fold', () => {
  const s = applyEvents(createState(), [
    ev(1, 'busy', { session: 'sess-a' }),
    ev(2, 'stage', { session: 'sess-a', stage: 'review' }),
  ]);
  assert.equal(s.sessionHistory.get('sess-a').ev, 'busy', 'a stage marker must not read as a liveness state for the session either');
});

test('applyEvents: session_start is authoritative for a session\'s own transcript, same rule as the per-lane fold', () => {
  const s = applyEvents(createState(), [
    ev(1, 'session_start', { session: 'sess-a', transcript: '/tmp/old.jsonl' }),
    ev(2, 'session_start', { session: 'sess-a', transcript: null }),
  ]);
  assert.equal(s.sessionHistory.get('sess-a').transcript, null, 'must not inherit the outgoing session\'s transcript via ??');
});

test('applyEvents: a lane_created/removed/reset event must not overwrite a session\'s own folded ev, unlike a regular event (#14 Phase 4 rc-1)', () => {
  // Session B (in lane1) runs `lanes new`, which names an unrelated lane5 —
  // the event is tagged with B's session id (per #13) purely because B is
  // the one who typed the command, not because it says anything about B's
  // own liveness. Without this guard, B's extra row in lane1 would vanish
  // the moment it ran any `lanes new`/`rm`/`reset` command anywhere.
  for (const laneEv of ['lane_created', 'lane_removed', 'lane_reset']) {
    const s = applyEvents(createState(), [
      ev(1, 'busy', { session: 'sess-b' }),
      { ts: 2, ev: laneEv, project: 'demo', lane: 5, worktree: 'lane5', session: 'sess-b' },
    ]);
    assert.equal(s.sessionHistory.get('sess-b').ev, 'busy', `${laneEv} must not read as sess-b's own liveness state`);
  }
});

test('pruneSessionHistory drops an entry not in the keep-set, and keeps one that is (#14 Phase 4 rc-6)', () => {
  const state = applyEvents(createState(), [
    ev(1, 'idle', { session: 'sess-live' }),
    ev(2, 'idle', { session: 'sess-dead' }),
  ]);
  assert.ok(state.sessionHistory.has('sess-live') && state.sessionHistory.has('sess-dead'), 'precondition: both entries exist before pruning');
  pruneSessionHistory(state, new Set(['sess-live']));
  assert.ok(state.sessionHistory.has('sess-live'), 'a session still in the keep-set must survive');
  assert.ok(!state.sessionHistory.has('sess-dead'), 'a session no longer in the keep-set must be dropped');
});

test('render puts ctx on the lane\'s own row, live-toned while the session is active', () => {
  const p = writeTranscript('live.jsonl', [
    assistantLine('claude-sonnet-5', { input_tokens: 43000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 0 }),
  ]);
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: p })]);
  const frame = render(resolveContext(lane2), state);
  const ctxCell = ctxPortion(rawRowFor(frame, 1));
  assert.ok(!ctxCell.includes(DIM), 'must not be dimmed while the session is live');
  assert.equal(ctxCell.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').trim(), '143K·sonnet-5');
});

test('render dims the ctx cell once the session has closed, but keeps showing the last known value', () => {
  const p = writeTranscript('closed.jsonl', [
    assistantLine('claude-opus-4-8', { input_tokens: 900000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 0 }),
  ]);
  const state = applyEvents(createState(), [ev(1, 'session_start', { transcript: p }), ev(2, 'session_end')]);
  const frame = render(resolveContext(lane2), state);
  const ctxCell = ctxPortion(rawRowFor(frame, 1));
  assert.ok(ctxCell.includes(DIM), 'must be dimmed once the session has closed');
  assert.equal(ctxCell.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').trim(), '1.0M·opus-4-8');
});

test('render shows — in the ctx cell when no transcript has ever been recorded for the lane', () => {
  const frame = render(resolveContext(lane2), createState());
  const ctxCell = ctxPortion(rawRowFor(frame, 3));
  assert.ok(ctxCell.includes(DIM), 'no live session either, so dimmed');
  assert.equal(ctxCell.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').trim(), '—');
});

test('render uses a supplied ctxInfo map instead of reading the transcript itself — the throttle watchStatus relies on', () => {
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/never/actually/read.jsonl' })]);
  const ctxInfo = new Map([['/never/actually/read.jsonl', { tokens: 2000, model: 'claude-sonnet-5' }]]);
  const frame = render(resolveContext(lane2), state, Date.now(), undefined, ctxInfo);
  const stripped = ctxPortion(rawRowFor(frame, 1)).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  assert.equal(stripped.trim(), '2K·sonnet-5', 'must read the supplied map, never touch the (nonexistent) file on disk');
});

test('render treats a transcript missing from ctxInfo as unknown, not as licence to read it directly', () => {
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/some/real/path.jsonl' })]);
  const frame = render(resolveContext(lane2), state, Date.now(), undefined, new Map());
  const stripped = ctxPortion(rawRowFor(frame, 1)).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  assert.equal(stripped.trim(), '—', 'a throttled cache miss shows — until the next refresh, not a fresh direct read');
});

test('the ctx cell dims for CLI-driven events too — reviewed is not a liveness signal, same reasoning as stage', () => {
  const state = applyEvents(createState(), [
    ev(1, 'session_start', { transcript: '/tmp/x.jsonl' }),
    ev(2, 'reviewed'), // /gate marked it clean — unrelated to whether a session is attached
  ]);
  const ctxInfo = new Map([['/tmp/x.jsonl', { tokens: 5000, model: 'claude-sonnet-5' }]]);
  const frame = render(resolveContext(lane2), state, Date.now(), undefined, ctxInfo);
  assert.ok(ctxPortion(rawRowFor(frame, 1)).includes(DIM), '"reviewed" must not read as a live session, even right after one closed');
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

// ── Live status override (#12) ───────────────────────────────────────
// `readLiveStatuses` reads ~/.claude/sessions/*.json — sandboxed under TMP
// by the same HOME override the rest of the suite relies on. Each test
// clears SESSIONS_DIR first so the fixtures here are independent of run
// order and never leak into the render()-level tests below, which always
// inject an explicit liveStatuses array instead of depending on this dir.
test('readLiveStatuses returns [] when ~/.claude/sessions does not exist, never throws', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  assert.deepEqual(readLiveStatuses(), []);
});

test('readLiveStatuses keeps a live pid, tolerates a malformed sibling file, normalizes a missing waitingFor/name/startedAt to null, and falls back to the pid for sessionId', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: '/some/lane/path', status: 'busy', statusUpdatedAt: 12345 }),
  );
  writeFileSync(join(SESSIONS_DIR, 'garbage.json'), '{ not json');
  writeFileSync(join(SESSIONS_DIR, 'not-a-session.key'), 'irrelevant, not even .json');
  assert.deepEqual(readLiveStatuses(), [
    {
      cwd: '/some/lane/path', status: 'busy', waitingFor: null, statusUpdatedAt: 12345,
      sessionId: String(process.pid), name: null, startedAt: null,
    },
  ]);
});

test('readLiveStatuses returns sessionId/name/startedAt correctly typed when present (#14)', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      cwd: '/some/lane/path',
      status: 'busy',
      statusUpdatedAt: 12345,
      sessionId: 'abc-123',
      name: 'lane1-1a',
      startedAt: 999,
      kind: 'interactive',
    }),
  );
  const [entry] = readLiveStatuses();
  assert.equal(entry.sessionId, 'abc-123');
  assert.equal(entry.name, 'lane1-1a');
  assert.equal(entry.startedAt, 999);
});

test('readLiveStatuses falls back to the pid when sessionId is wrong-typed, and normalizes wrong-typed name/startedAt to null, never throwing (#14)', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      cwd: '/some/lane/path',
      status: 'busy',
      sessionId: 42,
      name: ['not', 'a', 'string'],
      startedAt: 'not-a-number',
    }),
  );
  const [entry] = readLiveStatuses();
  assert.equal(entry.sessionId, String(process.pid), 'a wrong-typed sessionId falls back to the pid, never null — every returned entry has a real id to key on');
  assert.equal(entry.name, null);
  assert.equal(entry.startedAt, null);
});

test('readLiveStatuses falls back to the pid when sessionId is present but strips down to the empty string — not just when it is absent or wrong-typed (#14)', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    // Only control bytes, no printable characters at all — stripControlBytes
    // reduces this to '', which the pid fallback must treat the same as an
    // absent sessionId, not key rows on an empty string.
    JSON.stringify({ pid: process.pid, cwd: '/some/lane/path', status: 'busy', sessionId: `${ESC}\x07\x00` }),
  );
  const [entry] = readLiveStatuses();
  assert.equal(entry.sessionId, String(process.pid), 'a sessionId that strips to "" must fall back to the pid, same as an absent or wrong-typed one');
});

test('readLiveStatuses still normalizes statusUpdatedAt to null when missing or wrong-typed, now that sessionId/name/startedAt sit next to it in the object literal (#14 regression check)', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid, cwd: '/some/lane/path', status: 'busy',
      sessionId: 'abc-123', name: 'lane1', startedAt: 999,
    }),
  );
  assert.equal(
    readLiveStatuses()[0].statusUpdatedAt,
    null,
    'a missing statusUpdatedAt must still normalize to null even with sessionId/name/startedAt present alongside it',
  );

  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: '/some/lane/path', status: 'busy', statusUpdatedAt: 'not-a-number' }),
  );
  assert.equal(readLiveStatuses()[0].statusUpdatedAt, null, 'a wrong-typed statusUpdatedAt must still normalize to null, same as before #14');
});

test('readLiveStatuses normalizes a name that strips down to the empty string to null, not "" — one falsy case, not two', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    // Only control bytes, no printable characters at all — stripControlBytes
    // removes exactly \x00-\x1f and \x7f, so anything printable (including a
    // literal "[31m") would survive and this fixture would not prove the
    // empty-string case at all.
    JSON.stringify({ pid: process.pid, cwd: '/some/lane/path', status: 'busy', name: `${ESC}\x07\x00` }),
  );
  const [entry] = readLiveStatuses();
  assert.equal(entry.name, null, 'a name that is purely control bytes strips to "", which must normalize to null like an absent name');
});

test('readLiveStatuses normalizes an empty-after-stripping name to null without disturbing a simultaneously present, valid waitingFor (#14 — the two normalizations must not interfere)', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid, cwd: '/some/lane/path', status: 'waiting',
      waitingFor: 'input needed', name: `${ESC}\x07\x00`,
    }),
  );
  const [entry] = readLiveStatuses();
  assert.equal(entry.name, null, 'name that strips to "" still normalizes to null even with a valid waitingFor set alongside it');
  assert.equal(entry.waitingFor, 'input needed', 'a valid waitingFor must survive untouched by the sibling name normalization');
});

test('readLiveStatuses never drops two live sessions sharing the same cwd — multiple sessions per lane is #14\'s whole premise, not a duplicate to collapse', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  // Both files claim the real, currently-running test process as their pid —
  // isLivePid only checks liveness, not uniqueness, so this is enough to
  // fabricate two simultaneously-live entries without spawning a real second
  // process. Distinct filenames since the dir is keyed by filename, not pid.
  writeFileSync(
    join(SESSIONS_DIR, 'session-a.json'),
    JSON.stringify({ pid: process.pid, cwd: '/shared/lane', status: 'busy', sessionId: 'session-a' }),
  );
  writeFileSync(
    join(SESSIONS_DIR, 'session-b.json'),
    JSON.stringify({ pid: process.pid, cwd: '/shared/lane', status: 'idle', sessionId: 'session-b' }),
  );
  const entries = readLiveStatuses();
  assert.equal(entries.length, 2, 'both sessions rooted at the same cwd must survive — findLiveStatuses (Phase 2) is where selection happens, not here');
  assert.deepEqual(entries.map((e) => e.sessionId).sort(), ['session-a', 'session-b']);
});

test('readLiveStatuses keeps an entry whose kind is present but not a string (e.g. null) — fails open, same posture as every other field here', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: '/odd-kind/lane', status: 'busy', kind: null }),
  );
  assert.equal(readLiveStatuses().length, 1, 'a wrong-typed kind must not hide a live session, same as a missing kind');
});

test('readLiveStatuses drops an entry whose kind is present and not "interactive", but keeps one with no kind field at all (#14)', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: '/headless/lane', status: 'busy', kind: 'headless' }),
  );
  assert.deepEqual(readLiveStatuses(), [], 'a non-interactive kind must be dropped');

  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: '/no-kind/lane', status: 'busy' }),
  );
  assert.equal(readLiveStatuses().length, 1, 'a missing kind must fail open, not be treated as non-interactive');
});

test('readLiveStatuses drops an entry whose pid is no longer alive', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  writeFileSync(
    join(SESSIONS_DIR, `${dead.pid}.json`),
    JSON.stringify({ pid: dead.pid, cwd: '/dead/lane', status: 'busy', statusUpdatedAt: 1 }),
  );
  assert.deepEqual(readLiveStatuses(), [], 'a dead pid must not appear, even though the file itself parses fine');
  rmSync(SESSIONS_DIR, { recursive: true, force: true }); // leave nothing for the render()-level tests below to trip over
});

test('readLiveStatuses strips control/ANSI bytes from status too, not just waitingFor', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: '/some/lane/path', status: `idle${ESC}[31m\x07`, statusUpdatedAt: 1 }),
  );
  const [entry] = readLiveStatuses();
  assert.equal(
    entry.status,
    'idle[31m',
    'ESC (0x1b) and BEL (0x07) must be stripped from status at the source, same as waitingFor already was',
  );
  rmSync(SESSIONS_DIR, { recursive: true, force: true }); // leave nothing for the render()-level tests below to trip over
});

test('readLiveStatuses strips control/ANSI bytes from name too (#14)', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: '/some/lane/path', status: 'idle', name: `lane1${ESC}[31m\x07` }),
  );
  const [entry] = readLiveStatuses();
  assert.equal(entry.name, 'lane1[31m', 'name gets the same stripControlBytes treatment as status/waitingFor');
  rmSync(SESSIONS_DIR, { recursive: true, force: true }); // leave nothing for the render()-level tests below to trip over
});

test('a live status overrides the folded ev/since/waitingFor, and FOR measures from the live statusUpdatedAt', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const liveStatuses = [{ cwd: join(wtDir, 'lane1'), status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: 1000 }];
  const frame = render(resolveContext(lane2), applyEvents(createState(), [ev(1, 'busy')]), 6000, fabricated, null, liveStatuses);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('waiting: input needed'), 'the live waitingFor must override the folded busy state');
  assert.match(row, /\b5s\b/, 'FOR must measure from the live statusUpdatedAt (1000), not the folded busy since (1) — now (6000) - 1000 = 5s');
});

test('findLiveStatuses selection is deterministic regardless of array order — the same lane picks the same live status either way (#14)', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  // Neither cwd is an exact match, so the ascending-startedAt rule has to
  // decide — and its winner ('earlier') deliberately has the
  // lexically-LOSING sessionId ('sess-z' > 'sess-a'), so this only passes if
  // the startedAt comparison actually runs before the sessionId tiebreak.
  const earlier = { cwd: join(wtDir, 'lane1', 'sub-a'), status: 'idle', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-z', startedAt: 100 };
  const later = { cwd: join(wtDir, 'lane1', 'sub-b'), status: 'busy', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-a', startedAt: 500 };
  const rowFrom = (liveStatuses) => {
    const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, liveStatuses);
    return frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').split('\n').find((l) => l.startsWith(rowPrefix(1)));
  };
  assert.ok(rowFrom([earlier, later]).includes('waiting for you'), 'the earlier-started session must win, array order [earlier, later]');
  assert.ok(rowFrom([later, earlier]).includes('waiting for you'), 'and the same session must win with the array reversed — [later, earlier]');
});

test('findLiveStatuses: an exact cwd match always wins over a merely-prefix one, regardless of startedAt or sessionId (#14)', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  // exactButLate loses on both startedAt (much later) and sessionId
  // ('sess-z' > 'sess-a') — only the exact-cwd rule can make it win.
  const exactButLate = { cwd: join(wtDir, 'lane1'), status: 'idle', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-z', startedAt: 9999 };
  const prefixButEarly = { cwd: join(wtDir, 'lane1', 'sub'), status: 'busy', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-a', startedAt: 1 };
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, [prefixButEarly, exactButLate]);
  const row = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row.includes('waiting for you'), 'the exact-cwd session must win even though the prefix-matched one started much earlier and has a lexically-earlier sessionId');
});

test('findLiveStatuses: sessionId is the final tiebreak when cwd and startedAt are both tied (#14)', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const a = { cwd: join(wtDir, 'lane1'), status: 'idle', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 100 };
  const b = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-b', startedAt: 100 };
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, [b, a]);
  const row = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row.includes('waiting for you'), 'with cwd and startedAt tied, the lexically-smaller sessionId ("sess-a") must win, giving a total order rather than a coin flip');
});

test('findLiveStatuses never matches a row with no recorded path — an undefined lanePath must not coerce into a stray "undefined/" prefix match (#14)', () => {
  // Mirrors the pre-existing "ghost row with no recorded path fails open"
  // case (events written before the `path` field existed): the row must
  // still render, but a live status must never leak onto it, since a bare
  // `startsWith(`${lanePath}/`)` with no `!lanePath` guard would happily
  // coerce `undefined` to the string "undefined" and could match a stray cwd.
  const state = createState();
  state.lanes.set('demo#some-worktree', { project: 'demo', worktree: 'some-worktree', ev: 'busy', since: 1 });
  const liveStatuses = [{ cwd: 'undefined/sub', status: 'waiting', waitingFor: 'should never surface', statusUpdatedAt: 1 }];
  const frame = render(resolveContext(lane2), state, Date.now(), [], null, liveStatuses);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.includes('some-worktree'));
  assert.ok(row, 'the pathless row must still render (fails open, per the existsSync liveness check)');
  assert.ok(row.includes('working'), 'the folded busy state must stand — findLiveStatuses([...], undefined) must return [] via its early `!lanePath` guard');
  assert.ok(!row.includes('should never surface'), 'a live status must never override a row that has no path to match against');
});

// ── Extra rows for additional live sessions (#14 Phase 3) ────────────
test('two live sessions in one lane render as two adjacent rows, no blank line between them', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  assert.ok(idx !== -1, 'the primary row must exist');
  assert.ok(lines[idx].includes('working'), 'the exact-cwd session (root, no subdirectory) is primary, per findLiveStatuses ordering');
  const extraRow = lines[idx + 1];
  assert.ok(extraRow !== '', 'no blank line between the primary row and the extra session row');
  assert.ok(extraRow.startsWith('·'), 'the extra row\'s LANE cell is a bare "·", the same convention a lane-less ghost row already uses');
  assert.ok(!extraRow.startsWith(' '), 'must not read as a service line, which is the only line allowed to start with a space');
  assert.ok(extraRow.includes('lane1-1b'), 'the extra row\'s BRANCH cell shows the secondary session\'s own name');
  assert.ok(extraRow.includes('waiting for you'), 'the extra row\'s STATE reflects that session\'s own live status (idle), independent of the primary row');
});

test('an extra row falls back to the session id when the session has no name of its own', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  // No `name` at all — the shape readLiveStatuses() actually returns for a
  // session Claude Code has not named yet, not a fabricated edge case.
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: null };
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  const extraRow = lines[idx + 1];
  assert.ok(extraRow.includes('sess-b'), 'with no name, the extra row must fall back to the session id rather than render a blank BRANCH cell');
});

test('extra session rows land directly beneath the lane\'s own row, with the service line pushed after them as the block\'s footer', () => {
  const lane = worktrees.enumerateLanes(svcCfg)[1]; // lane2, lane 2 — declares a running 'web' service with a url template
  const [web] = sv.resolveServices(svcCfg, lane);
  const started = sv.start(web);
  assert.ok(started.pid, `start failed: ${started.error ?? ''}`);
  try {
    const ctx = { ...resolveContext(lane2), config: svcCfg };
    const primary = { cwd: lane.path, status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane2-1a' };
    const secondary = { cwd: join(lane.path, 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane2-1b' };
    const frame = render(ctx, createState(), Date.now(), [lane], null, [primary, secondary]);
    const lines = stripAnsi(frame).split('\n');
    const idx = lines.findIndex((l) => l.startsWith(rowPrefix(lane.lane)));
    assert.ok(idx !== -1, 'the lane row must exist');
    assert.ok(
      lines[idx + 1].startsWith('·') && lines[idx + 1].includes('lane2-1b'),
      'the extra session row must be directly beneath the lane\'s own row, not separated from it by the service line',
    );
    assert.ok(
      lines[idx + 2].trim().startsWith('http://localhost'),
      'the service line must come after the session row(s), as the block\'s footer',
    );
  } finally {
    sv.stop(web);
  }
});

test('a session\'s own commit_blocked hides only its own extra row — Phase 4\'s per-session gating replaces Phase 3\'s primary-row gating', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  // sess-b's OWN commit_blocked — tagged with its own session id, exactly
  // how #13 tags every emitted event. The commit guard operates on the
  // shared worktree, so the event still updates the primary row's own
  // ev (from state.lanes, keyed by project+worktree, not by session) —
  // that half is unchanged from before #14. What #14 Phase 4 changes is
  // whether the SECOND session's own row is also hidden by it.
  const state = applyEvents(createState(), [ev(1, 'commit_blocked', { session: 'sess-b' })]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  assert.ok(lines[idx].includes('blocked, needs review'), 'the primary row reflects the shared worktree\'s commit_blocked state, regardless of which session triggered it');
  assert.notEqual(lines[idx + 1], undefined, 'a next line must still exist (RECENT or the next lane), even though it is not the extra session row');
  assert.ok(!lines[idx + 1].includes('lane1-1b'), 'sess-b\'s own commit_blocked (from its own session history) must hide sess-b\'s own row');
});

test('a session\'s own reviewed state also hides its extra row — LANE_WIDE_PROTECTED gates by the whole set, not just commit_blocked', () => {
  // commit_blocked is the only LANE_WIDE_PROTECTED member exercised above;
  // this proves render() checks membership in the set (LANE_WIDE_PROTECTED.has(...))
  // rather than something narrowed to that one value.
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  const state = applyEvents(createState(), [ev(1, 'reviewed', { session: 'sess-b' })]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  assert.notEqual(lines[idx + 1], undefined, 'a next line must still exist, even though it is not the extra session row');
  assert.ok(!lines[idx + 1].includes('lane1-1b'), 'sess-b\'s own reviewed state must hide its own extra row, same as commit_blocked does');
});

test('a commit_blocked tagged with a DIFFERENT session\'s id does not hide this session\'s extra row', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  // sess-a's own commit_blocked, not sess-b's.
  const state = applyEvents(createState(), [ev(1, 'commit_blocked', { session: 'sess-a' })]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  assert.ok(lines[idx].includes('blocked, needs review'), 'the primary row (sess-a) shows commit_blocked, from state.lanes, unchanged from before #14');
  const extraRow = lines[idx + 1];
  assert.ok(
    extraRow.startsWith('·') && extraRow.includes('lane1-1b'),
    'sess-b is genuinely unaffected by sess-a\'s commit_blocked and must keep its own row — the exact case that made Phase 3\'s primary-row gating too coarse',
  );
});

test('an extra row with no session history at all still renders, falling open rather than assuming a lane-wide state', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  // agent_start with no `session` tag at all — state.sessionHistory ends up
  // empty; absence of evidence is not evidence of a lane-wide state.
  const state = applyEvents(createState(), [ev(1, 'agent_start', { agent: 'test-writer' })]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  assert.ok(lines[idx].includes('test-writer running'), 'agent_start must still stay authoritative on the primary row itself');
  const extraRow = lines[idx + 1];
  assert.ok(extraRow.startsWith('·') && extraRow.includes('lane1-1b'), 'with no history for sess-b at all, its row must still render');
});

test('sess-b\'s extra row survives running a lane-lifecycle command for an unrelated lane (#14 Phase 4 rc-1)', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  // sess-b runs `lanes new`, which names lane5 — nothing to do with lane1.
  const state = applyEvents(createState(), [
    { ts: 1, ev: 'lane_created', project: 'demo', lane: 5, worktree: 'lane5', session: 'sess-b' },
  ]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  const extraRow = lines[idx + 1];
  assert.ok(
    extraRow.startsWith('·') && extraRow.includes('lane1-1b'),
    'lane_created for a different lane must not read as sess-b\'s own liveness state and hide its row in lane1',
  );
});

test('an extra row\'s CTX reflects that session\'s own transcript via state.sessionHistory, not a hardcoded placeholder', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  const state = applyEvents(createState(), [ev(1, 'idle', { session: 'sess-b', transcript: '/sess-b/transcript.jsonl' })]);
  const ctxInfo = new Map([['/sess-b/transcript.jsonl', { tokens: 5000, model: 'claude-sonnet-5' }]]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, ctxInfo, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  const extraRow = lines[idx + 1];
  assert.ok(extraRow.includes('lane1-1b'));
  assert.ok(
    extraRow.includes('5K·sonnet-5'),
    'the extra row\'s CTX must come from sess-b\'s own recorded transcript via the supplied ctxInfo map, not the Phase 3 "—" placeholder',
  );
});

test('an extra row shows — in CTX when its session has no recorded transcript, same fallback the primary row already uses', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, new Map(), [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  const extraRow = lines[idx + 1];
  assert.ok(extraRow.trim().endsWith('—'), 'no session history at all for sess-b means no transcript to show, not a crash');
});

test('the primary row\'s CTX resolves through its own session when two sessions share a lane, not the lane-level transcript last-write-wins across both (#14 Phase 4 rc-2)', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primaryLive = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondaryLive = { cwd: join(wtDir, 'lane1', 'sub'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  // sess-b's idle (fired second) overwrites state.lanes' own transcript
  // field via the pre-existing, session-unaware per-lane fold — exactly the
  // scenario that made this wrong number invisible before #14 gave sess-b
  // its own row to compare against.
  const state = applyEvents(createState(), [
    ev(1, 'session_start', { session: 'sess-a', transcript: '/sess-a/t.jsonl' }),
    ev(2, 'idle', { session: 'sess-b', transcript: '/sess-b/t.jsonl' }),
  ]);
  assert.equal(
    state.lanes.get('demo#lane1').transcript, '/sess-b/t.jsonl',
    'precondition: the lane-level fold really does hold the wrong session\'s transcript here',
  );
  const ctxInfo = new Map([
    ['/sess-a/t.jsonl', { tokens: 40000, model: 'claude-sonnet-5' }],
    ['/sess-b/t.jsonl', { tokens: 310000, model: 'claude-sonnet-5' }],
  ]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, ctxInfo, [primaryLive, secondaryLive]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  assert.ok(lines[idx].includes('40K'), 'the primary row (sess-a, the exact-cwd session) must show its OWN token count, not sess-b\'s');
  assert.ok(!lines[idx].includes('310K'), 'must not show sess-b\'s count mislabeled as sess-a\'s');
  const extraRow = lines[idx + 1];
  assert.ok(extraRow.includes('310K'), 'sess-b\'s own extra row still correctly shows its own count');
});

test('a single-session lane\'s CTX still renders from r.transcript unchanged, when there is no live session to resolve through', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const state = applyEvents(createState(), [ev(1, 'idle', { transcript: '/tmp/only-session.jsonl' })]); // no `session` tag at all
  const ctxInfo = new Map([['/tmp/only-session.jsonl', { tokens: 12000, model: 'claude-sonnet-5' }]]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, ctxInfo, []);
  const row = stripAnsi(frame).split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row.includes('12K'), 'with no live session at all, CTX must fall back to r.transcript exactly as before #14');
});

test('the primary row\'s CTX falls back to r.transcript when a live session\'s own history exists but has no transcript of its own yet', () => {
  // Distinct from the "no live session at all" fallback above: here
  // `primaryHist` (state.sessionHistory.get(sess-a)) IS a real object, it
  // just has a falsy transcript — the one branch of render()'s
  // `primaryHist?.transcript ? primaryHist : r` ternary that a regression
  // narrowing the check to bare `primaryHist ? ... : r` truthiness would
  // silently break (rendering '—' instead of falling through to r).
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primaryLive = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const state = applyEvents(createState(), [
    ev(1, 'busy', { session: 'sess-a' }), // tags sess-a's own history, but with no transcript field
    ev(2, 'idle', { transcript: '/tmp/lane-level.jsonl' }), // no `session` tag — only state.lanes sees this
  ]);
  assert.equal(state.sessionHistory.get('sess-a').transcript, null, 'precondition: sess-a has a history entry, but no transcript of its own');
  const ctxInfo = new Map([['/tmp/lane-level.jsonl', { tokens: 12000, model: 'claude-sonnet-5' }]]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, ctxInfo, [primaryLive]);
  const row = stripAnsi(frame).split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row.includes('12K'), 'must fall back to r.transcript\'s real value, not blank, when the live session\'s own history has no transcript');
});

test('three live sessions in one lane render two extra rows, not just one — the extra-row loop is not hardcoded to a single iteration', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const second = { cwd: join(wtDir, 'lane1', 'sub-b'), status: 'idle', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  const third = { cwd: join(wtDir, 'lane1', 'sub-c'), status: 'idle', waitingFor: null, statusUpdatedAt: 3, sessionId: 'sess-c', startedAt: 3, name: 'lane1-1c' };
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, [primary, second, third]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  assert.ok(idx !== -1, 'the primary row must exist');
  assert.ok(lines[idx + 1].startsWith('·') && lines[idx + 1].includes('lane1-1b'), 'the first extra row must be the second-started session, directly beneath the primary row');
  assert.ok(lines[idx + 2].startsWith('·') && lines[idx + 2].includes('lane1-1c'), 'a second extra row must also render, for the third session — findLiveStatuses(...).slice(1) is fully iterated, not just read at index 1');
});

test('an extra row\'s STATE cell reflects that session\'s own "waiting" status and waitingFor text, independent of the primary row and of busy/idle', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'waiting', waitingFor: 'needs input', statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, [primary, secondary]);
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  const extraRow = lines[idx + 1];
  assert.ok(lines[idx].includes('working'), 'the primary row must stay on its own busy status');
  assert.ok(extraRow.includes('waiting: needs input'), 'the extra row must show that session\'s own waitingFor text, not fall back to "waiting for you" or leak the primary row\'s busy state');
});

test('render never crashes on an extra row\'s live status colliding with Object.prototype (e.g. "constructor"), and falls back the same way the primary row does', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const primary = { cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-a', startedAt: 1, name: 'lane1-1a' };
  const secondary = { cwd: join(wtDir, 'lane1', 'sub'), status: 'constructor', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-b', startedAt: 2, name: 'lane1-1b' };
  let frame;
  assert.doesNotThrow(() => { frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, [primary, secondary]); });
  const lines = stripAnsi(frame).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix(1)));
  const extraRow = lines[idx + 1];
  assert.ok(extraRow.includes('· constructor'), 'stateAndForCells must resolve the extra row\'s status the same safe way as the primary row\'s — the unknown-event fallback, not the inherited Object constructor');
});

test('the live override never touches a protected lanes-specific state like commit_blocked', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const liveStatuses = [{ cwd: join(wtDir, 'lane1'), status: 'busy', waitingFor: null, statusUpdatedAt: 999 }];
  const state = applyEvents(createState(), [ev(1, 'commit_blocked')]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, liveStatuses);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('blocked, needs review'), 'commit_blocked must stay authoritative over a live busy status');
  assert.ok(!row.includes('working'), 'the live status must not leak through onto a protected row');
});

test('the live override applies to agent_end (its render is byte-identical to busy, so a subagent interrupted mid-turn is no longer stuck showing "working")', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const liveStatuses = [{ cwd: join(wtDir, 'lane1'), status: 'idle', waitingFor: null, statusUpdatedAt: 1 }];
  const state = applyEvents(createState(), [ev(1, 'agent_start', { agent: 'test-writer' }), ev(2, 'agent_end')]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, liveStatuses);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('waiting for you'), 'a live idle status must override agent_end\'s own "working" label');
  assert.ok(!row.includes('working'), 'agent_end must not stay stuck on "working" once the live session actually went idle');
});

test('agent_start, unlike agent_end, stays protected against a live override', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const liveStatuses = [{ cwd: join(wtDir, 'lane1'), status: 'idle', waitingFor: null, statusUpdatedAt: 1 }];
  const state = applyEvents(createState(), [ev(1, 'agent_start', { agent: 'test-writer' })]);
  const frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, liveStatuses);
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('test-writer running'), 'agent_start must stay authoritative over a live idle status');
  assert.ok(!row.includes('waiting for you'), 'the live status must not leak through onto agent_start');
});

test('render never crashes on a live status colliding with Object.prototype (e.g. "constructor"), and falls back to the unknown-event label instead of resolving Object off the prototype chain', () => {
  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const liveStatuses = [{ cwd: join(wtDir, 'lane1'), status: 'constructor', waitingFor: null, statusUpdatedAt: 1 }];
  const state = applyEvents(createState(), [ev(1, 'busy')]);
  let frame;
  assert.doesNotThrow(() => { frame = render(resolveContext(lane2), state, Date.now(), fabricated, null, liveStatuses); });
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must have a row');
  assert.ok(row.includes('· constructor'), 'a status that only resolves via Object.prototype must fall back to the unknown-event icon/label, not the inherited Object constructor');
});

test('render falls back to the folded state exactly when liveStatuses has no matching cwd (fallback path)', () => {
  const state = applyEvents(createState(), [ev(1, 'idle')]);
  const frame = render(resolveContext(lane2), state, Date.now(), undefined, null, []);
  assert.ok(frame.includes('waiting for you'), 'idle must render normally with an empty liveStatuses array — no crash, no change');
});

// `sanitize()` in ui/dashboard.mjs only bounds length now — stripping
// control/ANSI bytes moved to readLiveStatuses() itself (see the
// readLiveStatuses tests above), so the only realistic way a hostile
// waitingFor reaches render() is through that same boundary. Fabricating an
// unsanitized liveStatuses entry straight into render(), bypassing
// readLiveStatuses entirely, is not a path production code ever takes
// (render()'s own default parameter *is* readLiveStatuses()) — so this goes
// through the real file + real reader, like the other sanitization tests.
test('a malicious waitingFor (control chars, an embedded ANSI escape, excessive length), sanitized end-to-end through readLiveStatuses, never breaks row layout', () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const evil = `hijacked${ESC}[31m${'x'.repeat(1000)}\x07\x00`;
  writeFileSync(
    join(SESSIONS_DIR, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: join(wtDir, 'lane1'), status: 'waiting', waitingFor: evil, statusUpdatedAt: 1 }),
  );
  const liveStatuses = readLiveStatuses();
  assert.ok(!liveStatuses[0].waitingFor.includes(ESC), 'readLiveStatuses must strip the ESC byte at the trust boundary, before render() ever sees it');

  const fabricated = [{
    lane: 1, name: 'lane1', path: join(wtDir, 'lane1'), branch: 'feat/1-x',
    isBase: false, dirty: false, dirtyCount: 0, ahead: 0, behind: 0, baseKnown: true,
  }];
  const frame = render(resolveContext(lane2), createState(), Date.now(), fabricated, null, liveStatuses);
  assert.ok(!frame.includes('\x07'), 'the bell character must be stripped before render');
  assert.ok(!frame.includes('\x00'), 'a null byte must be stripped before render');
  assert.ok(!frame.includes(`hijacked${ESC}[31m`), 'an embedded ESC byte from waitingFor must not reach the terminal literally');
  const stripped = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  const row = stripped.split('\n').find((l) => l.startsWith(rowPrefix(1)));
  assert.ok(row, 'lane1 must still have a row');
  assert.ok(row.includes('waiting:'), 'the waiting state must still render despite the hostile payload');
  assert.ok(row.length < 200, `the row must stay within the table's column budget, not balloon with the 1000-char payload (was ${row.length})`);
  rmSync(SESSIONS_DIR, { recursive: true, force: true }); // leave nothing for tests below to trip over
});

test('liveTransitionNotifications stays silent on first observation, but still records the baseline', () => {
  const rows = [{ project: 'demo', worktree: 'lane1', path: '/p/lane1', ev: 'busy' }];
  const liveStatuses = [{ cwd: '/p/lane1', status: 'idle', waitingFor: null, statusUpdatedAt: 1 }];
  const prev = new Map();
  const out = liveTransitionNotifications(rows, liveStatuses, prev, new Set());
  assert.deepEqual(out, [], 'no prior baseline means nothing has "transitioned" yet');
  assert.equal(prev.get('demo#lane1'), 'idle', 'the baseline itself must still be recorded for next tick');
});

test('liveTransitionNotifications fires once the live status actually changes from the tracked baseline', () => {
  const rows = [{ project: 'demo', worktree: 'lane1', path: '/p/lane1', ev: 'busy' }];
  const prev = new Map([['demo#lane1', 'busy']]);
  const liveStatuses = [{ cwd: '/p/lane1', status: 'idle', waitingFor: null, statusUpdatedAt: 1 }];
  const out = liveTransitionNotifications(rows, liveStatuses, prev, new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].body, 'Waiting for you');
  assert.equal(prev.get('demo#lane1'), 'idle');
});

test('liveTransitionNotifications reports the waitingFor detail for a transition into waiting', () => {
  const rows = [{ project: 'demo', worktree: 'lane1', path: '/p/lane1', ev: 'busy' }];
  const prev = new Map([['demo#lane1', 'busy']]);
  const liveStatuses = [{ cwd: '/p/lane1', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: 1 }];
  const out = liveTransitionNotifications(rows, liveStatuses, prev, new Set());
  assert.equal(out[0].body, 'Needs your input: input needed');
});

test('liveTransitionNotifications is deduped against a lane already notified this tick via a raw event', () => {
  const rows = [{ project: 'demo', worktree: 'lane1', path: '/p/lane1', ev: 'busy' }];
  const prev = new Map([['demo#lane1', 'busy']]);
  const liveStatuses = [{ cwd: '/p/lane1', status: 'idle', waitingFor: null, statusUpdatedAt: 1 }];
  const out = liveTransitionNotifications(rows, liveStatuses, prev, new Set(['demo#lane1']));
  assert.deepEqual(out, [], 'a Stop event already notified this lane this tick, so the live transition must not double-fire');
  assert.equal(prev.get('demo#lane1'), 'idle', 'the baseline must still update even though the notification itself was suppressed');
});

test('liveTransitionNotifications drops its tracked baseline once the row becomes protected, or its live match disappears', () => {
  const prev = new Map([['demo#lane1', 'busy']]);
  const protectedRows = [{ project: 'demo', worktree: 'lane1', path: '/p/lane1', ev: 'commit_blocked' }];
  liveTransitionNotifications(protectedRows, [{ cwd: '/p/lane1', status: 'idle', waitingFor: null, statusUpdatedAt: 1 }], prev, new Set());
  assert.equal(prev.has('demo#lane1'), false, 'a protected state must drop the baseline rather than compare against it');

  prev.set('demo#lane1', 'busy');
  const noMatchRows = [{ project: 'demo', worktree: 'lane1', path: '/p/lane1', ev: 'busy' }];
  liveTransitionNotifications(noMatchRows, [], prev, new Set());
  assert.equal(prev.has('demo#lane1'), false, 'no live match this tick must drop the baseline too, so a later reattachment starts clean');
});

test('liveTransitionNotifications picks the same deterministic match as render — this is a separate call site, not exercised by the render-path ordering tests above (#14)', () => {
  // Neither cwd is exact, so ascending-startedAt has to decide, same shape as
  // the render-path "array order independence" test — but going through
  // liveTransitionNotifications' own call to findLiveStatuses, which could
  // silently diverge (e.g. a stale copy-paste of the old singular
  // findLiveStatus) without this catching it.
  const rows = [{ project: 'demo', worktree: 'lane1', path: '/p/lane1', ev: 'busy' }];
  const earlier = { cwd: '/p/lane1/sub-a', status: 'idle', waitingFor: null, statusUpdatedAt: 1, sessionId: 'sess-z', startedAt: 100 };
  const later = { cwd: '/p/lane1/sub-b', status: 'busy', waitingFor: null, statusUpdatedAt: 2, sessionId: 'sess-a', startedAt: 500 };
  const baselineAfter = (liveStatuses) => {
    const prev = new Map([['demo#lane1', 'busy']]);
    liveTransitionNotifications(rows, liveStatuses, prev, new Set());
    return prev.get('demo#lane1');
  };
  assert.equal(baselineAfter([earlier, later]), 'idle', 'the earlier-started session must win, array order [earlier, later]');
  assert.equal(baselineAfter([later, earlier]), 'idle', 'and the same session must win with the array reversed — [later, earlier]');
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
