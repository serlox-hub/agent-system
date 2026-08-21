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
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLAUDE = join(homedir(), '.claude');
const SETTINGS = join(CLAUDE, 'settings.json');
const UNINSTALL = process.argv.includes('--uninstall');

const log = (s = '') => process.stdout.write(`${s}\n`);
const ok = (s) => log(`\x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => log(`\x1b[33m!\x1b[0m ${s}`);

const ensureDir = (d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); };

/** A symlink we own points somewhere inside this repo. */
function ownedLink(p) {
  try {
    return lstatSync(p).isSymbolicLink() && readlinkSync(p).startsWith(ROOT);
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

/** True when this entry was installed by us — matched on path, not on name. */
const isOurs = (entry) => JSON.stringify(entry?.hooks || []).includes(ROOT);

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
  const done = mergeSettings();
  log();
  log(done ? 'Uninstalled. Restart open Claude Code sessions.' : 'Uninstall incomplete — see above.');
  log('Left in place, because they are yours to remove:');
  log(`  - ${join(CLAUDE, 'lanes')} — your event log`);
  log('  - the PATH entry for this repo\'s bin/ in your shell profile');
  log('  - every .claude/agent-system.json in your repos');
  log();
} else {
  linkTree('agents', join(CLAUDE, 'agents'));
  linkTree('skills', join(CLAUDE, 'skills'));
  const merged = mergeSettings();
  ensureDir(join(CLAUDE, 'lanes'));

  const BIN = join(ROOT, 'bin');
  const onPath = (process.env.PATH || '').split(':').includes(BIN);

  log();
  if (!merged) {
    log('Install incomplete — see the warnings above.');
  } else {
    const steps = [
      'Restart any open Claude Code session so the new hooks load.',
      'In a repo you want to use this in:  lanes adopt',
      'Fill in review.domainAxes in the generated config — see docs/SETUP.md.',
      'lanes doctor        # verify',
      'lanes ui            # in a spare terminal',
    ];
    if (onPath) {
      ok(`${BIN} is already on your PATH`);
    } else {
      steps.unshift(
        `Put the CLI on your PATH:\n       echo 'export PATH="${BIN}:$PATH"' >> ~/.zshrc && exec zsh`,
      );
    }
    log('Done. Next:');
    steps.forEach((s, i) => log(`  ${i + 1}. ${s}`));
  }
  log();
}
