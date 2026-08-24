#!/usr/bin/env node
/**
 * lanes — worktree lanes for Claude Code.
 *
 * Run `lanes` with no arguments for the command list; that output is the single
 * source of truth, so this header does not duplicate it.
 *
 * Everything touching child processes (`dev`, `stop`, `logs`) imports its module
 * lazily, so a failure in the service supervisor can never take down the review
 * gate or the commit guard.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const { resolveContext, emitWithContext, emit, expandHome, EVENTS_FILE, EVENTS_PREV, LANES_DIR, CONFIG_REL, LANE_NAME_RE } =
  await import(join(ROOT, 'lib', 'context.mjs'));
const { diffFingerprint, writeMark, REVIEW_MARK, BYPASS_MARK } = await import(
  join(ROOT, 'lib', 'marks.mjs')
);
const { git, gitLine } = await import(join(ROOT, 'lib', 'git.mjs'));
const { readColors, setColor, ansi, DEFAULT_PALETTE, COLORS_FILE } = await import(
  join(ROOT, 'lib', 'colors.mjs')
);
const { mainWorktreeRoot, localConfigPath, readLocalOverride, writeLocalOverride, isGitignored, LOCAL_CONFIG_REL } =
  await import(join(ROOT, 'lib', 'local-config.mjs'));

const [, , cmd, ...rest] = process.argv;

const OK = '\x1b[32m✓\x1b[0m';
const BAD = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const out = (s = '') => process.stdout.write(`${s}\n`);

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function requireProject(ctx) {
  if (!ctx.optedIn) {
    die(
      `This directory is not part of an agent-system project.\n` +
        `Run \`lanes adopt\` here to scaffold ${CONFIG_REL}, then \`lanes doctor\`.`,
    );
  }
}

/** After writing a local override: warn if it is not actually gitignored here. */
function warnIfNotIgnored() {
  if (!isGitignored(process.cwd())) {
    out(`${WARN} ${LOCAL_CONFIG_REL} is not gitignored here — add it, or it will be committed with this machine's values.`);
  }
}

// A port PREFIX, concatenated with the lane number (portFor in lib/services.mjs)
// — every example in this repo is 1-3 digits (300, 400). Capping here teaches
// that semantics at the point of entry, rather than letting e.g. 8080 through
// to become an out-of-range port (80802) that fails silently in a detached
// process's log file.
const MAX_PORT_BASE = 999;
function parsePortBase(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PORT_BASE) {
    die(
      `basePort is a prefix, not a port — lane N is served on the prefix and N ` +
        `concatenated (300 → lane 2 is 3002). Use ${MAX_PORT_BASE} or below, got: ${raw}`,
    );
  }
  return n;
}

/**
 * Detect the directory that holds this repo's sibling worktrees.
 * Only reports one when the current worktree actually has siblings there —
 * a single-worktree repo has no lanes, and guessing one would be wrong.
 */
function detectWorktreesDir(cwd) {
  const paths = git(cwd, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean);
  if (paths.length < 2) return null;
  const root = gitLine(cwd, ['rev-parse', '--show-toplevel']);
  const parent = dirname(root);
  const siblings = paths.filter((p) => dirname(p) === parent);
  return siblings.length >= 2 ? parent : null;
}

/**
 * The project name must identify the REPO, not the worktree. Using the worktree
 * basename would give four sibling worktrees four different project names, and
 * the dashboard would show four projects instead of four lanes of one.
 */
function detectProjectName(cwd) {
  const url = gitLine(cwd, ['config', '--get', 'remote.origin.url']);
  const fromUrl = /([^/:]+?)(?:\.git)?$/.exec(url);
  if (fromUrl) return fromUrl[1];

  // The MAIN worktree's directory name, even from a linked worktree.
  const root = mainWorktreeRoot(cwd);
  if (root) return basename(root);
  return basename(gitLine(cwd, ['rev-parse', '--show-toplevel']));
}

function detectCommands(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return { pm: null, commands: {} };
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
  } catch { /* unreadable package.json — fall through with no detection */ }

  const pm =
    (existsSync(join(root, 'pnpm-lock.yaml')) && 'pnpm') ||
    (existsSync(join(root, 'bun.lockb')) && 'bun') ||
    (existsSync(join(root, 'yarn.lock')) && 'yarn') ||
    (existsSync(join(root, 'package-lock.json')) && 'npm') ||
    'npm';

  // Map our canonical names onto whatever this repo actually calls them.
  const pick = (...names) => names.find((n) => scripts[n]);
  const run = (name) => (name ? `${pm} ${name}` : null);
  return {
    pm,
    hasDev: Boolean(scripts.dev),
    commands: {
      install: `${pm} install`,
      lint: run(pick('lint')),
      lintFix: pick('lint:fix') ? run('lint:fix') : pick('lint') ? `${pm} lint --fix` : null,
      typecheck: run(pick('type-check', 'typecheck', 'tsc')),
      test: run(pick('test:run', 'test:unit', 'test')),
      testTargeted: pm === 'npm' ? 'npx vitest run' : `${pm} vitest run`,
      build: run(pick('build')),
    },
  };
}

switch (cmd) {
  case 'status': {
    const { printStatus, watchStatus } = await import(join(ROOT, 'ui', 'dashboard.mjs'));
    if (rest.includes('--once')) printStatus();
    else await watchStatus();
    break;
  }

  case 'stage': {
    const ctx = resolveContext(process.cwd());
    requireProject(ctx);
    const name = rest[0];
    if (!name) die('Usage: lanes stage <name> [detail]');
    emitWithContext('stage', process.cwd(), {
      stage: name,
      detail: rest.slice(1).join(' ') || null,
    });
    break;
  }

  case 'reviewed': {
    const ctx = resolveContext(process.cwd());
    requireProject(ctx);
    const fp = diffFingerprint(ctx.worktreeRoot);
    if (!writeMark(ctx.worktreeRoot, REVIEW_MARK, fp)) die('Could not write the review marker.');
    emitWithContext('reviewed', process.cwd(), { detail: fp.slice(0, 12) });
    out(`Diff ${fp.slice(0, 12)} marked as reviewed. Commit is unblocked until the tree changes.`);
    break;
  }

  case 'allow-commit': {
    const ctx = resolveContext(process.cwd());
    requireProject(ctx);
    const fp = diffFingerprint(ctx.worktreeRoot);
    if (!writeMark(ctx.worktreeRoot, BYPASS_MARK, fp)) die('Could not write the bypass marker.');
    out('One-shot commit bypass armed. The next commit of this exact diff will pass.');
    break;
  }

  case 'color': {
    const [laneArg, hex] = rest;
    if (laneArg === undefined) {
      const colors = readColors();
      out(`Lane colours — ${COLORS_FILE}`);
      out(`${DIM}per-machine, not committed: lane numbers depend on your own worktree names${RESET}`);
      out();
      const lanes = new Set([...Object.keys(colors).map(Number), 1, 2, 3, 4]);
      for (const n of [...lanes].sort((a, b) => a - b)) {
        const set = colors[n];
        const shown = set || DEFAULT_PALETTE[(n - 1) % DEFAULT_PALETTE.length].slice(1);
        out(`  ${n}  ${ansi(shown)}████${RESET}  #${shown}${set ? '' : `  ${DIM}(default)${RESET}`}`);
      }
      out();
      out(`  lanes color <n> <hex>     e.g. lanes color 2 832561`);
      break;
    }
    const lane = Number(laneArg);
    try {
      setColor(lane, hex ?? '');
    } catch (err) {
      die(`${err.message}\nUsage: lanes color <lane> <hex>   e.g. lanes color 2 832561`);
    }
    out(`${OK} lane ${lane} → ${ansi(hex)}████${RESET} #${String(hex).replace('#', '')}`);
    break;
  }

  case 'worktrees-dir': {
    const ctx = resolveContext(process.cwd());
    requireProject(ctx);
    const raw = rest.find((a) => !a.startsWith('-'));

    if (!raw) {
      const local = readLocalOverride(process.cwd()).worktreesDir;
      let committed = null;
      try {
        committed = JSON.parse(readFileSync(ctx.configPath, 'utf8')).worktreesDir || null;
      } catch { /* config parse errors are reported by `lanes doctor`, not here */ }
      if (local) out(`${expandHome(local)}  ${DIM}(local override — ${localConfigPath(process.cwd())})${RESET}`);
      else if (committed) out(`${expandHome(committed)}  ${DIM}(committed default — ${CONFIG_REL})${RESET}`);
      else out(`${DIM}not configured — lanes disabled${RESET}`);
      out();
      out(`  lanes worktrees-dir <path>   set this machine's override, e.g. lanes worktrees-dir ~/proj-lanes`);
      break;
    }

    const target = resolvePath(process.cwd(), expandHome(raw));
    // Same boundary as planCreate (D21): refusing a stale or mistyped path
    // instead of silently materializing it wherever it happens to point.
    if (!existsSync(target)) {
      if (!existsSync(dirname(target))) {
        die(`${dirname(target)} does not exist — check the path`);
      }
      try {
        mkdirSync(target);
      } catch (err) {
        die(`could not create ${target}: ${err.message}`);
      }
    }
    const written = writeLocalOverride(process.cwd(), { worktreesDir: target });
    if (!written) die('Could not resolve this repo — worktreesDir override not written.');
    out(`${OK} worktreesDir → ${target}`);
    out(`${DIM}written to ${localConfigPath(process.cwd())}${RESET}`);
    warnIfNotIgnored();
    break;
  }

  case 'base-port': {
    const ctx = resolveContext(process.cwd());
    requireProject(ctx);
    const raw = rest.find((a) => !a.startsWith('-'));

    if (!raw) {
      const local = readLocalOverride(process.cwd()).basePort;
      let committed = null;
      try {
        committed = JSON.parse(readFileSync(ctx.configPath, 'utf8')).basePort ?? null;
      } catch { /* config parse errors are reported by `lanes doctor`, not here */ }
      if (local != null) out(`${local}  ${DIM}(local override — ${localConfigPath(process.cwd())})${RESET}`);
      else if (committed != null) out(`${committed}  ${DIM}(committed default — ${CONFIG_REL})${RESET}`);
      else out(`${DIM}not configured${RESET}`);
      out();
      out(`  lanes base-port <n>   set this machine's override, e.g. lanes base-port 400`);
      break;
    }

    const n = parsePortBase(raw);
    const written = writeLocalOverride(process.cwd(), { basePort: n });
    if (!written) die('Could not resolve this repo — basePort override not written.');
    out(`${OK} basePort → ${n}`);
    out(`${DIM}written to ${localConfigPath(process.cwd())}${RESET}`);
    warnIfNotIgnored();
    break;
  }

  case 'service-port': {
    const ctx = resolveContext(process.cwd());
    requireProject(ctx);
    const [name, raw] = rest.filter((a) => !a.startsWith('-'));
    const services = ctx.config?.dev?.services || [];

    if (!name) {
      if (!services.length) {
        out(`${DIM}no dev.services declared${RESET}`);
        break;
      }
      const local = readLocalOverride(process.cwd()).servicePortBase || {};
      for (const svc of services) {
        const overridden = local[svc.name] != null;
        out(`  ${svc.name.padEnd(12)} ${svc.portBase ?? `${DIM}(none)${RESET}`}  ${DIM}(${overridden ? 'local override' : 'committed default'})${RESET}`);
      }
      out();
      out(`  lanes service-port <name> <n>   set this machine's override for one service`);
      break;
    }

    if (raw === undefined) die('Usage: lanes service-port <name> <n>');
    if (services.length && !services.some((s) => s.name === name)) {
      out(`${WARN} no dev.services entry named "${name}" — the override is written anyway, in case it's added later.`);
    }
    const n = parsePortBase(raw);
    const current = readLocalOverride(process.cwd()).servicePortBase || {};
    const written = writeLocalOverride(process.cwd(), { servicePortBase: { ...current, [name]: n } });
    if (!written) die('Could not resolve this repo — service-port override not written.');
    out(`${OK} ${name}.portBase → ${n}`);
    out(`${DIM}written to ${localConfigPath(process.cwd())}${RESET}`);
    warnIfNotIgnored();
    break;
  }

  case 'adopt': {
    const root = gitLine(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (!root) die('Not inside a git repository.');
    const dest = join(root, CONFIG_REL);
    if (existsSync(dest) && !rest.includes('--force')) {
      die(`${dest} already exists. Re-run with --force to overwrite, or edit it directly.`);
    }

    const { pm, commands, hasDev } = detectCommands(root);
    const projectName = detectProjectName(process.cwd());
    let worktreesDir = detectWorktreesDir(process.cwd());
    let createdWorktreesDir = null;
    // Only when nothing was auto-detected and there is a real terminal to ask on
    // — a non-interactive run (tests, CI) must fall through to today's behaviour
    // unchanged rather than hang waiting on stdin.
    if (!worktreesDir && process.stdin.isTTY) {
      const proposed = join(dirname(root), `${projectName}-lanes`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // Ctrl+D (no answer typed) rejects the promise with AbortError rather than
      // resolving empty — treat that the same as a plain "no" instead of crashing.
      const answer = await rl
        .question(`No lanes directory found. Create ${proposed} for this project's lanes? [Y/n] `)
        .catch(() => 'n');
      rl.close();
      if (!/^n/i.test(answer.trim())) {
        try {
          mkdirSync(proposed, { recursive: true });
          worktreesDir = proposed;
          createdWorktreesDir = proposed;
        } catch (err) {
          out(`${WARN} could not create ${proposed}: ${err.message} — leaving worktreesDir unset`);
        }
      }
    }
    const config = {
      // Points editors (VSCode etc.) at this install's schema for hover docs and
      // autocomplete on every field — the config documents itself, no separate
      // doc page to keep in sync. Absolute, since it must resolve from any repo.
      $schema: join(ROOT, 'config', 'agent-system.schema.json'),
      project: projectName,
      commands,
      // A guess, and flagged as one below: `--port` is right for Vite and Next
      // but wrong for plenty of runners, and a monorepo usually has more than
      // one service. Better a concrete line to edit than an empty section.
      ...(hasDev
        ? { dev: { services: [{ name: 'web', command: `${pm} dev --port {port}`, portBase: 300, url: 'http://localhost:{port}' }] } }
        : { dev: { services: [] } }),
      branch: {
        pattern: '^(?:feat|fix|refactor|chore|docs)/(\\d+)-',
        prefixes: { feat: 'enhancement', fix: 'bug', refactor: 'refactor', docs: 'documentation', chore: null },
      },
      review: {
        commitGuard: true,
        largeDiffThreshold: 400,
        excludePattern: '^CHANGELOG\\.md$|^(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|bun\\.lockb)$',
        domainAxes: [],
      },
      tests: { framework: null, expertiseDoc: null, locationRule: 'Match the placement of existing neighbouring tests.' },
      architect: {
        issueProvider: 'github',
        specSections: ['Problem', 'Constraints', 'Approach', 'Contract', 'Out of scope', 'Acceptance'],
        challengeSpec: true,
      },
    };

    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, `${JSON.stringify(config, null, 2)}\n`);
    out(`${OK} wrote ${dest}`);

    // worktreesDir and basePort are both per-machine (D22): never into the
    // committed config, always the gitignored local override — every lane of
    // this repo picks them up. Both are conditioned on worktreesDir: no lanes
    // means basePort has nothing to prefix (lib/context.mjs's ctx.port needs
    // both a lane and a basePort), so seeding one without the other is noise.
    if (worktreesDir) writeLocalOverride(process.cwd(), { worktreesDir, basePort: 300 });

    // A repo without a .gitignore, or one this can't write to, just keeps
    // working — but then the override file is NOT guaranteed to stay untracked,
    // so the summary below must not claim otherwise. writeLocalOverride already
    // attempted to add the entry; this only reports whether that held.
    const gitignored = worktreesDir ? isGitignored(process.cwd()) : false;

    out();
    out(`  project        ${config.project}`);
    out(`  package mgr    ${pm || 'not detected'}`);
    out(
      `  worktrees      ${
        createdWorktreesDir
          ? `${worktreesDir} ${DIM}(created; local override${gitignored ? ', not committed' : ''})${RESET}`
          : worktreesDir
          ? `${worktreesDir} ${DIM}(local override${gitignored ? ', not committed' : ''})${RESET}`
          : `${DIM}none detected — lanes disabled, everything else works${RESET}`
      }`,
    );
    out(
      `  basePort       ${
        worktreesDir
          ? `300 ${DIM}(local override${gitignored ? ', not committed' : ''})${RESET}`
          : `${DIM}not configured — no lanes, no port hint${RESET}`
      }`,
    );
    if (worktreesDir && !gitignored) {
      out(`${WARN} ${LOCAL_CONFIG_REL} is not gitignored here — add it, or it will be committed with this machine's values.`);
    }
    for (const [k, v] of Object.entries(commands)) {
      out(`  ${k.padEnd(14)} ${v || `${DIM}not detected${RESET}`}`);
    }
    out();
    if (config.dev.services.length) {
      out(`${WARN} dev.services is a guess: \`${config.dev.services[0].command}\`.`);
      out('  Check the port flag your runner actually takes, and add an entry per');
      out('  service if this repo has more than one (client, api, worker...).');
      out();
    }
    out(`${WARN} review.domainAxes is empty, and it is the field that decides whether`);
    out('  the reviewer is worth running. Without it you get a generic reviewer that');
    out('  finds only what your linter already found. Fill it in before relying on');
    out('  /gate — hover the field in your editor (this file ships with $schema),');
    out('  or read config/agent-system.schema.json, for how to write them.');
    out();
    out('Then: lanes doctor');
    break;
  }

  // ── Worktree lifecycle and dev services ───────────────────────────
  // These import lazily on purpose: the service supervisor is the only part of
  // the system that owns child processes and mutable pid state, and a failure in
  // it must never be able to take down `lanes reviewed` or the commit guard.
  case 'new':
  case 'rm':
  case 'reset':
  case 'switch':
  case 'dev':
  case 'stop':
  case 'logs':
  case 'each':
  case 'free': {
    const ctx = resolveContext(process.cwd());
    requireProject(ctx);
    const worktrees = await import(join(ROOT, 'lib', 'worktrees.mjs'));
    const lanes = worktrees.enumerateLanes(ctx.config);
    if (!lanes.length && cmd !== 'new') {
      // worktreesDir can resolve correctly and still enumerate to zero lanes
      // if every subdirectory predates D26 (this repo's own wt1/wt2, e.g.) —
      // the generic "set worktreesDir" message is actively misleading there,
      // since worktreesDir is not the thing that's wrong.
      const wtDir = worktrees.worktreesDir(ctx.config);
      let stray = [];
      if (wtDir) {
        try {
          stray = readdirSync(wtDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !LANE_NAME_RE.test(d.name))
            .map((d) => d.name);
        } catch { /* unreadable — fall through to the generic message below */ }
      }
      if (stray.length) {
        die(
          `No lanes found under ${wtDir}, but it holds ${stray.join(', ')} — lanes are only ` +
            `directories named lane<N> (D26, no auto-migration). Rename by hand, e.g.:\n` +
            `  git worktree move ${join(wtDir, stray[0])} ${join(wtDir, 'lane1')}\n` +
            'or see `lanes doctor` for the full list.',
        );
      }
      die(
        'No lanes found. Set worktreesDir with `lanes worktrees-dir <path>`, or create one:\n' +
          '  lanes new',
      );
    }

    const select = (arg) => {
      const { lanes: picked, unknown } = worktrees.parseSelector(arg, lanes);
      if (unknown.length) die(`no such lane: ${unknown.join(', ')}`);
      return picked;
    };

    if (cmd === 'free') {
      const free = lanes.filter(worktrees.isFree);
      if (!free.length) {
        out('none');
        out(`${DIM}Every lane has uncommitted changes or unpushed commits.${RESET}`);
        process.exit(1);
      }
      for (const l of free) out(`${l.lane}\t${l.name}\t${l.path}\t${l.branch}`);
      break;
    }

    if (cmd === 'new') {
      const from = rest.includes('--from') ? rest[rest.indexOf('--from') + 1] : undefined;
      const res = worktrees.createWorktree(ctx.config, from);
      // Before the error check: createWorktree spreads `plan` (including a
      // just-created worktreesDir) into its error return too, so a failed
      // `git worktree add` must not hide that a directory was materialized.
      if (res.createdDir) out(`${OK} created worktrees directory ${res.createdDir}`);
      if (res.error) die(res.error);
      const worktree = basename(res.path);
      emit({
        ev: 'lane_created',
        project: ctx.project,
        lane: res.lane,
        worktree,
        // Always a detached checkout — there is no real branch name yet.
        branch: null,
        path: res.path,
      });
      out(`${OK} lane ${res.lane} — ${worktree}, detached at ${from || `origin/${worktrees.baseBranch(ctx.config)}`}`);
      out(`  ${res.path}`);
      break;
    }

    if (cmd === 'rm') {
      const force = rest.includes('--force');
      // A bare `lanes rm` must not default to "all": every lane detached at
      // base (D26's resting state) is free, so an omitted selector could
      // silently remove the whole stack. `all` is still available, explicitly.
      const sel = rest.find((a) => !a.startsWith('-'));
      if (!sel) die('Usage: lanes rm <lane|name|all> [--force]');
      const targets = select(sel);
      if (!targets.length) die('Usage: lanes rm <lane|name|all> [--force]');
      const res = worktrees.removeWorktree(ctx.config, targets, { force });
      for (const r of res.removed || []) {
        emit({
          ev: 'lane_removed',
          project: ctx.project,
          lane: r.lane,
          worktree: r.name,
          branch: r.branch,
          path: r.path,
          detail: r.wasForced ? 'forced' : null,
        });
        out(`${OK} removed lane ${r.lane} — ${r.name}${r.wasForced ? ' (forced)' : ''}`);
        if (r.branchKept) {
          out(`${DIM}  branch ${r.branchKept} still exists — reusing this number needs`);
          out(`  \`git branch -d ${r.branchKept}\` first${RESET}`);
        }
      }
      if (res.error) die(res.error);
      break;
    }

    if (cmd === 'reset') {
      const force = rest.includes('--force');
      const sel = rest.find((a) => !a.startsWith('-'));
      if (!sel) die('Usage: lanes reset <lane> [--force]');
      const [target] = select(sel);
      const res = worktrees.resetLane(ctx.config, target, { force });
      if (res.error) die(res.error);
      // A lane going idle-branch-free is as much a fresh start as `lanes new`
      // — the dashboard row must not keep showing the just-finished task's
      // stage/state/timer/context indefinitely (applyEvents treats lane_reset
      // like lane_created).
      emit({
        ev: 'lane_reset',
        project: ctx.project,
        lane: res.lane,
        worktree: res.name,
        branch: null,
        path: target.path,
      });
      out(`${OK} lane ${res.lane} (${res.name}) → detached at origin/${res.branch}`);
      if (res.branchDeleted) out(`${DIM}  deleted merged branch ${res.branchDeleted}${RESET}`);
      break;
    }

    if (cmd === 'switch') {
      const [sel, branch] = rest.filter((a) => !a.startsWith('-'));
      if (!sel || !branch) die('Usage: lanes switch <lane> <branch> [--create]');
      const [target] = select(sel);
      const res = worktrees.switchBranch(ctx.config, target, branch, { create: rest.includes('--create') });
      if (res.error) die(res.error);
      out(`${OK} lane ${res.lane} (${res.name}) → ${res.branch}`);
      break;
    }

    if (cmd === 'each') {
      const sepIdx = rest.indexOf('--lanes');
      const sel = sepIdx === -1 ? '' : rest[sepIdx + 1];
      const command = (sepIdx === -1 ? rest : rest.slice(0, sepIdx)).join(' ');
      if (!command) die('Usage: lanes each <command> [--lanes 1,3]');
      const { execSync } = await import('node:child_process');
      let failures = 0;
      for (const l of select(sel)) {
        out(`${DIM}── lane ${l.lane} · ${l.name} · ${l.branch}${RESET}`);
        try {
          const stdout = execSync(command, { cwd: l.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          if (stdout.trim()) out(stdout.trimEnd());
        } catch (err) {
          failures += 1;
          out(`${BAD} exit ${err.status ?? '?'}`);
          const text = `${err.stdout || ''}${err.stderr || ''}`.trimEnd();
          if (text) out(text);
        }
      }
      if (failures) process.exit(1);
      break;
    }

    // Everything below needs the service supervisor.
    const sv = await import(join(ROOT, 'lib', 'services.mjs'));

    if (cmd === 'dev' || cmd === 'stop') {
      const targets = select(rest.find((a) => !a.startsWith('-')));
      let any = false;
      for (const l of targets) {
        for (const s of sv.resolveServices(ctx.config, l)) {
          any = true;
          if (cmd === 'dev') {
            const r = sv.start(s);
            if (r.error) out(`${BAD} lane ${l.lane} ${s.name}: ${r.error}`);
            else if (r.already) out(`${DIM}·${RESET} lane ${l.lane} ${s.name} already running (pid ${r.pid})`);
            else out(`${OK} lane ${l.lane} ${s.name} → ${s.url || `port ${s.port}`} (pid ${r.pid})`);
          } else {
            const r = sv.stop(s);
            if (r.notRunning) out(`${DIM}·${RESET} lane ${l.lane} ${s.name} not running`);
            else out(`${OK} lane ${l.lane} ${s.name} stopped (pid ${r.pid}, ${r.signal})`);
          }
        }
      }
      if (!any) {
        out(`${WARN} no services declared. Add dev.services to .claude/agent-system.json —`);
        out('  see "5. Managing lanes" in docs/SETUP.md.');
      }
      break;
    }

    if (cmd === 'logs') {
      const args = rest.filter((a) => !a.startsWith('-'));
      const [target] = select(args[0]);
      if (!target) die('Usage: lanes logs <lane> [service] [--follow]');
      const svcs = sv.resolveServices(ctx.config, target);
      const picked = args[1] ? svcs.filter((s) => s.name === args[1]) : svcs;
      if (!picked.length) die(`no such service in lane ${target.lane}: ${args[1] ?? '(none declared)'}`);
      if (rest.includes('--follow') || rest.includes('-f')) {
        if (picked.length > 1) die(`--follow needs one service: ${svcs.map((s) => s.name).join(', ')}`);
        const { spawn: sp } = await import('node:child_process');
        sp('tail', ['-f', picked[0].logFile], { stdio: 'inherit' });
        break;
      }
      for (const s of picked) {
        out(`${DIM}── lane ${target.lane} · ${s.name} · ${s.logFile}${RESET}`);
        out(sv.tailLog(s, 50) ?? `${DIM}(no log yet)${RESET}`);
      }
      break;
    }
    break;
  }

  case 'doctor': {
    const ctx = resolveContext(process.cwd());
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const row = (state, label, value) => out(`${state} ${label.padEnd(26)} ${value}`);
    let problems = 0;
    let warnings = 0;
    const bad = (label, value) => { problems += 1; row(BAD, label, value); };
    const warn = (label, value) => { warnings += 1; row(WARN, label, value); };

    out();
    out('Install');
    // Match on the repo's real path, not a name — the directory can be renamed.
    let wired = false;
    try {
      wired = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks || {}).includes(ROOT);
    } catch { /* reported as not wired */ }
    wired ? row(OK, 'hooks wired', settingsPath) : bad('hooks wired', `run ${join(ROOT, 'install.sh')}`);
    if (!existsSync(EVENTS_FILE)) {
      warn('event log', 'not created yet — it appears on the first event');
    } else {
      const kb = Math.round(statSync(EVENTS_FILE).size / 1024);
      const rotated = existsSync(EVENTS_PREV) ? `, previous generation at ${basename(EVENTS_PREV)}` : '';
      row(OK, 'event log', `${EVENTS_FILE} (${kb} KB${rotated})`);
    }

    out();
    out('This repo');
    if (!ctx.optedIn) {
      bad('opted in', `no ${CONFIG_REL} found — run \`lanes adopt\``);
    } else {
      row(OK, 'opted in', ctx.configPath ?? ctx.projectRoot);
      if (ctx.configError) bad('config parses', ctx.configError);
      if (!ctx.config?.project) bad('config.project', 'missing — required');

      const cmds = ctx.config?.commands || {};
      const missing = ['lint', 'typecheck', 'test'].filter((k) => !cmds[k]);
      missing.length
        ? warn('commands', `missing: ${missing.join(', ')} — /gate will skip those gates`)
        : row(OK, 'commands', `lint, typecheck, test all set`);

      const axes = ctx.config?.review?.domainAxes || [];
      axes.length
        ? row(OK, 'review.domainAxes', `${axes.length} axis/axes`)
        : warn('review.domainAxes', 'empty — the reviewer will only find what your linter finds');

      const wtDir = expandHome(ctx.config?.worktreesDir);
      // The single merge point (lib/context.mjs#findProject) already resolved
      // the effective value; this just labels which source won (D22).
      const wtSource = readLocalOverride(process.cwd()).worktreesDir ? 'local override' : 'committed default';
      if (!wtDir) {
        row(DIM + '·' + RESET, 'worktrees', 'not configured — lanes disabled, rest works');
      } else if (!existsSync(wtDir)) {
        // `lanes new` self-heals this exact state (creates wtDir) as long as its
        // parent exists — matches the same boundary in worktrees.mjs#planCreate.
        existsSync(dirname(wtDir))
          ? warn('worktrees', `${wtDir} does not exist yet — \`lanes new\` will create it ${DIM}(${wtSource})${RESET}`)
          : bad('worktrees', `${wtDir} does not exist, and neither does its parent ${DIM}(${wtSource})${RESET}`);
      } else {
        row(OK, 'worktrees', `${wtDir}  ${DIM}(${wtSource})${RESET}`);
        let stray = [];
        try {
          stray = readdirSync(wtDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !LANE_NAME_RE.test(d.name))
            .map((d) => d.name);
        } catch { /* unreadable — already reported by the row above */ }
        if (stray.length) {
          warn(
            'lane naming',
            `non-\`lane<N>\` director${stray.length > 1 ? 'ies' : 'y'} under worktreesDir, ignored by lanes: ${stray.join(', ')}`,
          );
        }
      }

      const basePort = ctx.config?.basePort;
      if (basePort != null) {
        const bpSource = readLocalOverride(process.cwd()).basePort != null ? 'local override' : 'committed default';
        row(OK, 'basePort', `${basePort}  ${DIM}(${bpSource})${RESET}`);
      } else {
        row(DIM + '·' + RESET, 'basePort', 'not configured — port hint disabled, rest works');
      }

      const services = ctx.config?.dev?.services || [];
      if (services.length) {
        const localPorts = readLocalOverride(process.cwd()).servicePortBase || {};
        const overridden = services.filter((s) => localPorts[s.name] != null).length;
        row(
          OK,
          'service ports',
          `${services.length} declared${overridden ? `, ${overridden} local override(s)` : ''}`,
        );
      }
    }

    out();
    out('This worktree');
    ctx.lane != null
      ? row(OK, 'lane', `${ctx.lane} — ${ctx.worktree}${ctx.port ? ` (port ${ctx.port})` : ''}`)
      : row(DIM + '·' + RESET, 'lane', `${ctx.worktree} is not under worktreesDir`);
    row(ctx.branch ? OK : WARN, 'branch', ctx.branch || 'detached or not a repo');
    ctx.issue
      ? row(OK, 'issue from branch', `#${ctx.issue}`)
      : warn('issue from branch', `'${ctx.branch}' does not match ${ctx.config?.branch?.pattern || 'the default pattern'}`);

    out();
    if (problems) out(`${BAD} ${problems} problem(s), ${warnings} warning(s). Fix the problems before relying on the system.`);
    else if (warnings) out(`${OK} usable, with ${warnings} warning(s) above.`);
    else out(`${OK} all good.`);
    out();
    break;
  }

  default:
    out(
      [
        'lanes — worktree lanes for Claude Code',
        '',
        'Lanes',
        '  lanes new [--from <ref>]       Create the next lane, detached at base (or --from)',
        '  lanes rm <sel> [--force]       Remove the top lane(s); refuses to lose work',
        '  lanes reset <n> [--force]      Detach a lane back to a clean base state',
        '  lanes switch <n> <b> [--create]  Point a lane at another branch',
        '  lanes free                     Lanes safe to take over (used by /architect)',
        '  lanes each <cmd> [--lanes 1,3] Run a command in each lane',
        '',
        'Dev services',
        '  lanes dev [sel]                Start this project\'s services for a lane',
        '  lanes stop [sel]               Stop them (kills the whole process group)',
        '  lanes logs <n> [svc] [-f]      Tail a service log',
        '',
        'Dashboard',
        '  lanes status [--once]          Live dashboard of every lane (--once: one-shot snapshot)',
        '  lanes color [<n> <hex>]        Show or set this machine\'s lane colours',
        '',
        'Setup and gates',
        '  lanes adopt [--force]          Scaffold .claude/agent-system.json',
        '  lanes worktrees-dir [<path>]   Show or set this machine\'s worktreesDir override',
        '  lanes base-port [<n>]          Show or set this machine\'s basePort override',
        '  lanes service-port [<svc> <n>] Show or set a per-service portBase override',
        '  lanes doctor                   Verify the install and this repo config',
        '  lanes stage <name> [detail]    Emit a pipeline stage event',
        '  lanes reviewed                 Mark the current diff reviewed',
        '  lanes allow-commit             One-shot bypass of the commit guard',
        '',
        'Selectors: 1 · 1,3 · 2-4 · . (current lane) · all (default)',
        '',
      ].join('\n'),
    );
}
