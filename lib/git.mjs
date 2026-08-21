/**
 * The one git helper.
 *
 * Every caller here runs inside a hook or a CLI command, so the contract is
 * always the same: never throw, never inherit stderr, always bounded in time.
 * Callers distinguish "no result" from "command failed" by checking for an
 * empty string — which is correct for every use in this repo, since none of
 * them care *why* git declined to answer.
 */

import { execFileSync } from 'node:child_process';

export function git(cwd, args, opts = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
  } catch {
    return '';
  }
}

/** Trimmed single-line output, the common case for rev-parse and friends. */
export function gitLine(cwd, args) {
  return git(cwd, args).trim();
}

/**
 * For operations that create or destroy things, where git's own complaint is
 * the only useful diagnostic. `git()` deliberately swallows it — fine when you
 * only care whether there was an answer, useless when a worktree failed to be
 * created and the reason is "branch already exists".
 */
export function gitTry(cwd, args) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? '').trim(),
      status: err?.status ?? null,
    };
  }
}
