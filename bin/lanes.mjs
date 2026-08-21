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
import { dirname, join, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const { resolveContext, emitWithContext, expandHome, EVENTS_FILE, EVENTS_PREV, LANES_DIR, CONFIG_REL } =
  await import(join(ROOT, 'lib', 'context.mjs'));
const { diffFingerprint, writeMark, REVIEW_MARK, BYPASS_MARK } = await import(
  join(ROOT, 'lib', 'marks.mjs')
);
const { git, gitLine } = await import(join(ROOT, 'lib', 'git.mjs'));
const { readColors, setColor, ansi, DEFAULT_PALETTE, COLORS_FILE } = await import(
  join(ROOT, 'lib', 'colors.mjs')
);

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

  // `--git-common-dir` is the MAIN worktree's .git, even from a linked worktree.
  const common = gitLine(cwd, ['rev-parse', '--git-common-dir']);
  if (common) {
    const abs = common.startsWith('/')
      ? common
      : join(gitLine(cwd, ['rev-parse', '--show-toplevel']), common);
    return basename(dirname(abs));
  }
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
  case 'ui': {
    const { runUi } = await import(join(ROOT, 'ui', 'dashboard.mjs'));
    await runUi();
    break;
  }

  case 'status': {
    const { printStatus } = await import(join(ROOT, 'ui', 'dashboard.mjs'));
    printStatus();
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

  case 'adopt': {
    const root = gitLine(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (!root) die('Not inside a git repository.');
    const dest = join(root, CONFIG_REL);
    if (existsSync(dest) && !rest.includes('--force')) {
      die(`${dest} already exists. Re-run with --force to overwrite, or edit it directly.`);
    }

    const { pm, commands, hasDev } = detectCommands(root);
    const worktreesDir = detectWorktreesDir(process.cwd());
    const config = {
      // Points editors (VSCode etc.) at this install's schema for hover docs and
      // autocomplete on every field — the config documents itself, no separate
      // doc page to keep in sync. Absolute, since it must resolve from any repo.
      $schema: join(ROOT, 'config', 'agent-system.schema.json'),
      project: detectProjectName(process.cwd()),
      ...(worktreesDir ? { worktreesDir, basePort: 300 } : {}),
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
    out();
    out(`  project        ${config.project}`);
    out(`  package mgr    ${pm || 'not detected'}`);
    out(`  worktrees      ${worktreesDir || `${DIM}none detected — lanes disabled, everything else works${RESET}`}`);
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
    out('  /review — hover the field in your editor (this file ships with $schema),');
    out('  or read config/agent-system.schema.json, for how to write them.');
    out();
    out('Then: lanes doctor');
    break;
  }

  // ── Worktree lifecycle and dev services ───────────────────────────
  // These import lazily on purpose: the service supervisor is the only part of
  // the system that owns child processes and mutable pid state, and a failure in
  // it must never be able to take down `lanes reviewed` or the commit guard.
  case 'list':
  case 'new':
  case 'rm':
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
      die(
        'No lanes found. Set `worktreesDir` in .claude/agent-system.json, or create one:\n' +
          '  lanes new <name> --branch <branch>',
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
      const name = rest.find((a) => !a.startsWith('-'));
      if (!name) die('Usage: lanes new <name> [--branch <branch>] [--from <ref>]');
      const branch = rest[rest.indexOf('--branch') + 1];
      const from = rest.includes('--from') ? rest[rest.indexOf('--from') + 1] : undefined;
      const plan = worktrees.planCreate(ctx.config, name);
      if (plan.error) die(plan.error);
      if (plan.renumbered.length) {
        out(`${WARN} creating "${name}" renumbers existing lanes, because lane numbers are`);
        out('  the alphabetical position. Colours and ports move with the number:');
        for (const r of plan.renumbered) out(`    ${r.name}: lane ${r.from} → ${r.to}`);
        out(`  Name it so it sorts last (e.g. ${lanes[lanes.length - 1]?.name.replace(/\d+$/, (n) => Number(n) + 1) || 'x-5'}) to avoid this.`);
        out();
      }
      const res = worktrees.createWorktree(ctx.config, name, branch, from);
      if (res.error) die(res.error);
      out(`${OK} lane ${res.lane} — ${name}${branch ? ` on ${branch}` : ''}`);
      out(`  ${res.path}`);
      break;
    }

    if (cmd === 'rm') {
      const force = rest.includes('--force');
      const targets = select(rest.find((a) => !a.startsWith('-')));
      if (!targets.length) die('Usage: lanes rm <lane|name> [--force]');
      for (const l of targets) {
        const res = worktrees.removeWorktree(ctx.config, l, { force });
        if (res.error) {
          out(`${BAD} ${res.error}`);
          continue;
        }
        out(`${OK} removed lane ${l.lane} — ${res.removed}${res.wasForced ? ' (forced)' : ''}`);
        if (res.branchKept) {
          out(`${DIM}  branch ${res.branchKept} still exists — reusing this name needs`);
          out(`  \`git branch -d ${res.branchKept}\` first, or \`lanes new ${res.removed} --branch <other>\`${RESET}`);
        }
      }
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

    if (cmd === 'list') {
      const w = (s, n) => String(s ?? '').padEnd(n);
      out(`${'#'.padEnd(3)}${w('WORKTREE', 16)}${w('BRANCH', 28)}${w('STATE', 14)}SERVICES`);
      out(`${DIM}${'─'.repeat(84)}${RESET}`);
      for (const l of lanes) {
        const svcs = sv.resolveServices(ctx.config, l);
        const rendered = svcs.length
          ? svcs.map((s) => {
              const st = sv.status(s);
              // Show the port it actually bound to when running: a lane can be
              // renumbered while a service is up, moving its computed port.
              const port = st.running ? st.port ?? s.port : s.port;
              const moved = st.running && st.port && st.port !== s.port ? '!' : '';
              return st.running
                ? `\x1b[32m${s.name}:${port}${moved}\x1b[0m`
                : `${DIM}${s.name}:${port}${RESET}`;
            }).join('  ')
          : `${DIM}none declared${RESET}`;
        const marks = [
          l.dirty ? `\x1b[33m~${l.dirtyCount}\x1b[0m` : '',
          l.ahead ? `\x1b[32m+${l.ahead}\x1b[0m` : '',
          l.behind ? `\x1b[31m-${l.behind}\x1b[0m` : '',
        ].filter(Boolean).join(' ') || (worktrees.isFree(l) ? `${DIM}free${RESET}` : '');
        out(`${w(l.lane, 3)}${w(l.name, 16)}${w(l.branch, 28)}${marks.padEnd(14 + 9)}${rendered}`);
      }
      out();
      out(`${DIM}~n uncommitted · +n ahead of origin/${worktrees.baseBranch(ctx.config)} · -n behind · svc! = running on a port from before a renumber${RESET}`);
      break;
    }

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
        out('  see the "Dev services" section of docs/SETUP.md.');
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
        ? warn('commands', `missing: ${missing.join(', ')} — /review will skip those gates`)
        : row(OK, 'commands', `lint, typecheck, test all set`);

      const axes = ctx.config?.review?.domainAxes || [];
      axes.length
        ? row(OK, 'review.domainAxes', `${axes.length} axis/axes`)
        : warn('review.domainAxes', 'empty — the reviewer will only find what your linter finds');

      const wtDir = expandHome(ctx.config?.worktreesDir);
      if (!wtDir) {
        row(DIM + '·' + RESET, 'worktrees', 'not configured — lanes disabled, rest works');
      } else if (!existsSync(wtDir)) {
        bad('worktrees', `${wtDir} does not exist`);
      } else {
        row(OK, 'worktrees', wtDir);
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
        '  lanes list                     Worktrees, branches, dirty state, services',
        '  lanes new <name> [--branch b]  Create a lane (warns if it renumbers others)',
        '  lanes rm <sel> [--force]       Remove a lane; refuses to lose work',
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
        '  lanes ui                       Live dashboard of every lane',
        '  lanes status                   One-shot snapshot',
        '  lanes color [<n> <hex>]        Show or set this machine\'s lane colours',
        '',
        'Setup and gates',
        '  lanes adopt [--force]          Scaffold .claude/agent-system.json',
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
