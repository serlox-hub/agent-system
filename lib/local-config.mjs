/**
 * Per-machine config override, outside the committed `.claude/agent-system.json`.
 *
 * Two developers on the same team may want their lanes somewhere different from
 * each other (different disk, different naming convention), which a single
 * committed value can never satisfy for both (D22). Resolved at the MAIN
 * worktree's root via `--git-common-dir` — not the current worktree's own
 * `.claude/` — so every lane of the same repo shares one override file
 * automatically, with no project-name key to fall out of sync on rename.
 *
 * Gitignored and never leaves the machine, so an absolute path is fine here.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gitLine } from './git.mjs';

export const LOCAL_CONFIG_REL = join('.claude', 'agent-system.local.json');

/**
 * Absolute path to the MAIN worktree's root, even when `cwd` is a linked
 * worktree — `--git-common-dir` always resolves to the shared `.git` the main
 * worktree owns. Same resolution `detectProjectName` uses (bin/lanes.mjs).
 *
 * `--git-common-dir` prints relative to CWD, not to the toplevel — resolving it
 * against `--show-toplevel` instead (an earlier bug here) silently climbs out
 * of the repo whenever `cwd` is a subdirectory, since the two only coincide at
 * the root itself.
 */
export function mainWorktreeRoot(cwd) {
  const common = gitLine(cwd, ['rev-parse', '--git-common-dir']);
  if (!common) return null;
  return dirname(resolve(cwd, common));
}

export function localConfigPath(cwd) {
  const root = mainWorktreeRoot(cwd);
  return root ? join(root, LOCAL_CONFIG_REL) : null;
}

/**
 * `{ worktreesDir?: string, basePort?: number, servicePortBase?: { [name]: number } }`.
 * Never throws — `{}` on missing/malformed file.
 */
export function readLocalOverride(cwd) {
  const path = localConfigPath(cwd);
  if (!path || !existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * Whether `LOCAL_CONFIG_REL` is actually protected by this repo's `.gitignore`.
 * False for "no .gitignore at all" too — that is the one case `writeLocalOverride`
 * cannot fix for itself (adding one from nothing is `adopt`'s call, not this
 * module's), so callers use this to warn rather than assume the write is safe.
 */
export function isGitignored(cwd) {
  const root = mainWorktreeRoot(cwd);
  const gitignorePath = root ? join(root, '.gitignore') : null;
  if (!gitignorePath || !existsSync(gitignorePath)) return false;
  try {
    return readFileSync(gitignorePath, 'utf8')
      .split('\n')
      .some((l) => l.trim() === LOCAL_CONFIG_REL);
  } catch {
    return false;
  }
}

/** Best-effort: appends the ignore entry if a `.gitignore` exists and lacks it. */
function ensureIgnored(cwd) {
  const root = mainWorktreeRoot(cwd);
  if (!root) return;
  const gitignorePath = join(root, '.gitignore');
  if (!existsSync(gitignorePath)) return;
  try {
    const contents = readFileSync(gitignorePath, 'utf8');
    if (contents.split('\n').some((l) => l.trim() === LOCAL_CONFIG_REL)) return;
    const sep = contents === '' || contents.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignorePath, `${contents}${sep}${LOCAL_CONFIG_REL}\n`);
  } catch {
    // Best-effort; callers check the outcome with isGitignored(cwd) if they care.
  }
}

/**
 * Shallow-merges `patch` in, creating the file (and `.claude/`) if absent.
 * Every writer funnels through here, so the gitignore-ensure guard lives here
 * too — not duplicated per caller (D22): the file is the load-bearing secret
 * of the whole per-machine-override design, and the invariant belongs next to
 * the write, not next to one of its callers.
 */
export function writeLocalOverride(cwd, patch) {
  const path = localConfigPath(cwd);
  if (!path) return null;
  const merged = { ...readLocalOverride(cwd), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  ensureIgnored(cwd);
  return merged;
}
