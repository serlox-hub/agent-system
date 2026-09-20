#!/usr/bin/env node
/**
 * Installer / uninstaller.
 *
 *   node install.mjs              install or refresh
 *   node install.mjs --uninstall  remove everything this repo added
 *
 * Idempotent by construction: every install removes what a previous one added
 * (identified by this repo's real path, never by name) and re-adds it. Nothing
 * here touches settings you own — the settings.json merge only removes hook
 * entries whose command points inside this repo, and backs the file up first.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  unlinkSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLAUDE = join(homedir(), '.claude');
const SETTINGS = join(CLAUDE, 'settings.json');
// A shell profile only ever reaches an interactive shell. Claude Code started by
// systemd, cron or any other non-login context inherits none of it, and every
// `lanes` call in the skills fails there — `/gate`'s `lanes reviewed` included,
// which leaves the commit guard blocking a commit nothing can unblock.
const CLI_LINK = join(homedir(), '.local', 'bin', 'lanes');
const UNINSTALL = process.argv.includes('--uninstall');

const log = (s = '') => process.stdout.write(`${s}\n`);
const ok = (s) => log(`\x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => log(`\x1b[33m!\x1b[0m ${s}`);

const ensureDir = (d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); };

/** A symlink we own points somewhere inside this repo. */
function ownedLink(p) {
  try {
    // ROOT + sep, not ROOT: a bare prefix match makes `…/agent-system` own
    // `…/agent-system-lanes/lane1`, so an uninstall here would remove a lane's links.
    return lstatSync(p).isSymbolicLink() && readlinkSync(p).startsWith(ROOT + sep);
  } catch {
    return false;
  }
}

function link(src, dest) {
  let exists = true;
  try { lstatSync(dest); } catch { exists = false; }
  if (exists) {
    if (!lstatSync(dest).isSymbolicLink()) {
      warn(`${dest} exists and is not a symlink — left untouched. Move it aside and re-run.`);
      return 'skipped';
    }
    if (readlinkSync(dest) === src) return 'unchanged';
    unlinkSync(dest);
  }
  symlinkSync(src, dest);
  return 'linked';
}

function linkTree(subdir, target) {
  const srcDir = join(ROOT, subdir);
  if (!existsSync(srcDir)) return;
  ensureDir(target);
  for (const entry of readdirSync(srcDir)) {
    if (link(join(srcDir, entry), join(target, entry)) !== 'skipped') {
      ok(`${subdir}/${entry} → ~/.claude/${basename(target)}/${entry}`);
    }
  }
}

function unlinkTree(target) {
  if (!existsSync(target)) return;
  for (const entry of readdirSync(target)) {
    const p = join(target, entry);
    if (!ownedLink(p)) continue;
    unlinkSync(p);
    ok(`removed ~/.claude/${basename(target)}/${entry}`);
  }
}

// ── Hooks in settings.json ──────────────────────────────────────────
const EMIT = `node ${join(ROOT, 'hooks', 'emit.mjs')}`;
// Shell prescreen, not the .mjs directly: this fires on every Bash call and
// must not pay Node startup unless the command might be a commit.
const GUARD = join(ROOT, 'hooks', 'commit-guard.sh');

const HOOKS = {
  PreToolUse: [
    { matcher: 'Task|Agent', hooks: [{ type: 'command', command: EMIT }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: GUARD }] },
  ],
  PostToolUse: [{ matcher: 'Task|Agent', hooks: [{ type: 'command', command: EMIT }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: EMIT }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: EMIT }] }],
  Stop: [{ hooks: [{ type: 'command', command: EMIT }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: EMIT }] }],
};

/**
 * True when this entry was installed by us — matched on path, not on name.
 * ROOT + sep, not bare ROOT: `…/agent-system` is a substring of
 * `…/agent-system-lanes/lane1`, so an uninstall from the main clone would strip
 * a lane's hook entries. Same boundary as `ownedLink`.
 */
const isOurs = (entry) => JSON.stringify(entry?.hooks || []).includes(ROOT + sep);

function mergeSettings() {
  ensureDir(CLAUDE);
  let settings = {};
  if (existsSync(SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    } catch (err) {
      warn(`${SETTINGS} is not valid JSON (${err.message}) — refusing to touch it.`);
      warn('Fix the file and re-run. No changes were made to it.');
      return false;
    }
    const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(SETTINGS, backup);
    ok(`backup → ${backup}`);
  }

  settings.hooks = settings.hooks || {};
  for (const [event, entries] of Object.entries(HOOKS)) {
    const kept = (settings.hooks[event] || []).filter((e) => !isOurs(e));
    if (UNINSTALL) {
      if (kept.length) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    } else {
      settings.hooks[event] = [...kept, ...entries];
    }
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  ok(UNINSTALL ? `hooks removed from ${SETTINGS} (your other hooks kept)` : `hooks merged into ${SETTINGS} (existing hooks preserved)`);
  return true;
}

// ── Run ─────────────────────────────────────────────────────────────
log();
log(`${UNINSTALL ? 'Uninstalling' : 'Installing'} agent-system — ${ROOT}`);
log();

if (UNINSTALL) {
  unlinkTree(join(CLAUDE, 'agents'));
  unlinkTree(join(CLAUDE, 'skills'));
  if (ownedLink(CLI_LINK)) {
    unlinkSync(CLI_LINK);
    ok(`removed ${CLI_LINK}`);
  }
  const done = mergeSettings();
  log();
  log(done ? 'Uninstalled. Restart open Claude Code sessions.' : 'Uninstall incomplete — see above.');
  log('Left in place, because they are yours to remove:');
  log(`  - ${join(CLAUDE, 'lanes')} — your event log`);
  log('  - any PATH entry you added to your shell profile by hand');
  log('  - every .claude/agent-system.json in your repos');
  log();
} else {
  linkTree('agents', join(CLAUDE, 'agents'));
  linkTree('skills', join(CLAUDE, 'skills'));
  const merged = mergeSettings();
  ensureDir(join(CLAUDE, 'lanes'));

  const BIN = join(ROOT, 'bin');
  // Symlink, never a copy: it points back into this clone, so `git pull` stays
  // the whole upgrade (D16). A copy would go stale the moment you pulled.
  ensureDir(dirname(CLI_LINK));
  // A linked worktree's `.git` is a file (a `gitdir:` pointer); a clone's is a
  // directory. This repo develops itself in lanes, so ROOT is very often one —
  // and a machine-wide `lanes` aimed at a lane dies on the next `lanes rm`,
  // taking `lanes reviewed` and `lanes doctor` with it. The agents/skills links
  // and the hooks have always had this exposure; the CLI must not join them,
  // because it is the one whose loss blocks a commit nothing can unblock.
  let inWorktree = false;
  try { inWorktree = lstatSync(join(ROOT, '.git')).isFile(); } catch { /* treat as a clone */ }
  let linked = false;
  if (inWorktree) {
    warn(`${CLI_LINK} not touched — this is a linked worktree, and the link would break on \`lanes rm\`. Run install.sh from the main clone.`);
  } else {
    // ~/.local/bin is the user's own directory and `lanes` is a generic name, so
    // unlike ~/.claude/{agents,skills} this is not a namespace we own. Refusing
    // outright is not available here: a clone that moved leaves a link we no
    // longer recognise as ours, and re-linking it is what makes "re-run
    // install.sh after you move the clone" true. So replace — but never
    // silently: name the old target so it can be put back.
    if (!ownedLink(CLI_LINK)) {
      try {
        if (lstatSync(CLI_LINK).isSymbolicLink()) {
          warn(`replacing ${CLI_LINK} — it pointed at ${readlinkSync(CLI_LINK)}`);
        }
      } catch { /* nothing there, nothing to announce */ }
    }
    linked = link(join(BIN, 'lanes'), CLI_LINK) !== 'skipped';
    if (linked) ok(`bin/lanes → ${CLI_LINK}`);
  }
  // Advise the directory we actually linked into, even when this repo's own
  // bin/ is already on PATH: that one reaches your shell and nothing else.
  const PATH_DIR = linked ? dirname(CLI_LINK) : BIN;
  const onPath = (process.env.PATH || '').split(':').includes(PATH_DIR);

  log();
  if (!merged) {
    log('Install incomplete — see the warnings above.');
  } else {
    const steps = [
      'Restart any open Claude Code session so the new hooks load.',
      'In a repo you want to use this in:  lanes adopt',
      'Fill in review.domainAxes in the generated config — see docs/SETUP.md.',
      'lanes doctor        # verify',
      'lanes status        # in a spare terminal',
    ];
    if (onPath) {
      ok(`${PATH_DIR} is already on your PATH`);
    } else {
      // A profile entry only ever reaches an interactive shell, so on its own it
      // does not restore what ~/.local/bin/lanes would have given a launcher.
      const caveat = linked
        ? '\n       (interactive shells only — a launcher needs ~/.local/bin in its own\n        PATH too; see docs/SETUP.md §1)'
        : `\n       (interactive shells only, and ${CLI_LINK} was left alone — resolve that\n        conflict too, or systemd/cron still will not find \`lanes\`)`;
      steps.unshift(
        `Put the CLI on your PATH:\n       echo 'export PATH="${PATH_DIR}:$PATH"' >> ~/.zshrc && export PATH="${PATH_DIR}:$PATH"${caveat}`,
      );
    }
    log('Done. Next:');
    steps.forEach((s, i) => log(`  ${i + 1}. ${s}`));
  }
  log();
}
