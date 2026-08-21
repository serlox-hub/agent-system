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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs';
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
  assert.equal(s.lanes.get('demo#1').ev, 'agent_start');
  assert.equal(s.lanes.get('demo#1').agent, 'code-reviewer');
});

test('agent_end clears the running agent; busy is kept out of history', () => {
  const s = applyEvents(createState(), [
    ev(1, 'agent_start', { agent: 'test-writer' }),
    ev(2, 'agent_end'),
    ev(3, 'busy'),
  ]);
  assert.equal(s.lanes.get('demo#1').agent, null);
  assert.equal(s.history.length, 2, 'busy is noise, it fires on every message');
});

test('applyEvents is incremental — folding twice equals folding once', () => {
  const events = [ev(1, 'session_start'), ev(2, 'stage', { stage: 'review' })];
  const once = applyEvents(createState(), events);
  const twice = applyEvents(applyEvents(createState(), [events[0]]), [events[1]]);
  assert.deepEqual(twice.lanes.get('demo#1'), once.lanes.get('demo#1'));
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

test('notifyTitle falls back to worktree, never to an unidentified "lane ?"', () => {
  assert.equal(notifyTitle(ev(1, 'idle', { lane: null, issue: '12' })), 'demo · demo-1 · #12');
  assert.equal(notifyTitle(ev(1, 'idle')), 'demo · lane 1');
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
