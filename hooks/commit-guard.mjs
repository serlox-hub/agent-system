#!/usr/bin/env node
/**
 * PreToolUse guard on `git commit`.
 *
 * Policy chosen by the user: BLOCK, EXPLAIN, and OFFER A CHOICE.
 *
 * A hook cannot talk to the user directly, so it denies the tool call and
 * returns a reason. The main agent surfaces that reason as a question
 * ("review first, or commit anyway?"). If the user picks "commit anyway", the
 * agent runs `lanes allow-commit` to drop a one-shot bypass token and retries.
 *
 * Markers are keyed by the fingerprint of the diff, so they expire naturally:
 * change one line after reviewing and the guard fires again.
 */

import { resolve } from 'node:path';

import { readHookInput, resolveContext, emit } from '../lib/context.mjs';
import {
  diffFingerprint,
  readMark,
  clearMark,
  changedLineCount,
  REVIEW_MARK,
  BYPASS_MARK,
} from '../lib/marks.mjs';

/**
 * Git options that consume the NEXT token as their value. Without this list a
 * regex-only match fails on `git -C . commit` — the `.` is neither an option nor
 * the subcommand — and the commit slips past the guard unreviewed.
 *
 * Two of them do not merely need skipping: `-C` and `--work-tree` say which tree
 * is being committed, so they also decide which project the guard must resolve.
 * See `commitCwd`.
 */
const VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env',
]);

/**
 * A shell removes quote characters from a word before exec and splits only on
 * UNquoted whitespace — so `git "commit"`, `git com"mit"` and
 * `git -C "my dir" commit` all run as an ordinary `git commit`, and
 * `echo "run git commit later"` runs as one argument to `echo`, not four bare
 * words. A plain `split(/\s+/)` gets every one of those backwards: it treats
 * quote characters as part of the token and whitespace *inside* quotes as a
 * token boundary. This walks the segment the way a shell would instead —
 * unquoted whitespace ends a token, quote characters are dropped rather than
 * kept, and whitespace inside an open quote is just more of the word.
 */
function tokenize(segment) {
  const tokens = [];
  let word = '';
  let quote = null; // the quote character currently open, or null
  let started = false; // word has content, or an (empty) quoted span was seen
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(word);
      word = '';
      started = false;
      continue;
    }
    word += ch;
    started = true;
  }
  if (started) tokens.push(word);
  return tokens;
}

/**
 * Split a command line into segments, keeping the operator that preceded each —
 * `cd` only carries forward across some of them, and a separator-blind split
 * cannot tell which.
 *
 * The list must be every shell command separator, not just the infix
 * operators: a NEWLINE separates two commands exactly as `;` does, and a lone
 * `&` backgrounds the one before it. Miss either and a segment holds two
 * commands at once — `cd there<newline>git commit` then reads as a single `cd`,
 * and the commit inside it is never seen at all.
 */
function splitSegments(command) {
  const parts = String(command).split(/(&&|\|\||;|\||\n|&)/);
  const segments = [];
  let sep = null;
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) segments.push({ text: parts[i], sepBefore: sep });
    else sep = parts[i];
  }
  return segments;
}

/**
 * The directory a `git commit` in this command line would actually run in, or
 * null when the line commits nothing.
 *
 * The hook payload's `cwd` is the SESSION's directory, which is only the
 * commit's directory when the command does not move. `cd lane1 && git commit`
 * and `git -C lane1 commit` both commit somewhere else, and resolving the
 * project from the session's cwd instead guards the wrong repository — it
 * blocks against a tree the commit does not touch, and clears the bypass mark
 * in a root the retry will not read. Worse than a false block: a session
 * sitting in a clean, already-gated repo waves through an unreviewed commit in
 * the repo it `cd`s into.
 *
 * D14 already walks git's option grammar by token to find `commit` at all; the
 * `-C` it walks past is the same value that says where. This reads it rather
 * than discarding it, and follows `cd` for the same reason.
 *
 * Walks tokens instead of pattern-matching, so it accepts every option form
 * (`-C dir`, `--git-dir=x`, `--no-pager`) while refusing the near-misses that a
 * loose regex would swallow: `git log --grep commit` and `git commit-tree` are
 * not commits.
 */
function commitCwd(command, baseCwd) {
  const segments = splitSegments(command);
  let cwd = baseCwd;
  for (let idx = 0; idx < segments.length; idx += 1) {
    const tokens = tokenize(segments[idx].text.trim());
    if (!tokens.length) continue;

    if (tokens[0] === 'cd') {
      // What decides whether a cd is felt downstream is the operator AFTER it,
      // not the one before: only `&&`, `;` and a newline leave the next command
      // in the new directory. After `||` the cd FAILED, so the old directory
      // still stands; after `|` or `&` it ran in a subshell whose cwd nothing
      // downstream inherits. Reading the operator on the wrong side makes
      // `cd elsewhere || git ...` resolve against a directory the command never
      // reached.
      const sepAfter = segments[idx + 1] ? segments[idx + 1].sepBefore : null;
      if (sepAfter === '&&' || sepAfter === ';' || sepAfter === '\n') {
        const target = tokens[1];
        if (target && !target.startsWith('-')) cwd = resolve(cwd, target);
      }
      continue;
    }

    const start = tokens.findIndex((t) => t === 'git' || t.endsWith('/git'));
    if (start === -1) continue;
    let i = start + 1;
    // Relocation is per-invocation: `-C` composes relatively against what the
    // chain's `cd`s already established, but does not outlive this git call.
    let dir = cwd;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const opt = tokens[i];
      if (VALUE_OPTS.has(opt)) {
        const value = tokens[i + 1];
        // Repeated `-C` is relative to the preceding one, which is what
        // resolve() already does. `--git-dir` is deliberately not followed: it
        // names the .git directory rather than a tree, and git itself pairs it
        // with --work-tree when the two differ.
        if ((opt === '-C' || opt === '--work-tree') && value) dir = resolve(dir, value);
        i += 2;
      } else {
        if (opt.startsWith('--work-tree=')) dir = resolve(dir, opt.slice('--work-tree='.length));
        i += 1;
      }
    }
    if (tokens[i] === 'commit') return dir;
  }
  return null;
}

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

async function main() {
  const input = await readHookInput();
  const cwd = commitCwd(input?.tool_input?.command || '', input?.cwd || process.cwd());
  if (cwd === null) allow();

  const ctx = resolveContext(cwd);
  if (!ctx.optedIn) allow(); // project has not adopted the system
  if (ctx.config?.review?.commitGuard === false) allow(); // explicitly disabled

  const root = ctx.worktreeRoot;
  let fingerprint;
  try {
    fingerprint = diffFingerprint(root);
  } catch {
    allow(); // cannot fingerprint -> never stand in the user's way
  }

  const base = {
    project: ctx.project,
    lane: ctx.lane,
    worktree: ctx.worktree,
    branch: ctx.branch,
    issue: ctx.issue,
    session: input?.session_id || null,
  };

  // One-shot bypass: consumed on use so it cannot linger into the next commit.
  const bypass = readMark(root, BYPASS_MARK);
  if (bypass && (bypass === fingerprint || bypass === '*')) {
    clearMark(root, BYPASS_MARK);
    emit({ ev: 'commit_bypass', ...base });
    allow();
  }

  if (readMark(root, REVIEW_MARK) === fingerprint) {
    emit({ ev: 'commit_reviewed', ...base });
    allow();
  }

  const lines = changedLineCount(root);
  const threshold = ctx.config?.review?.largeDiffThreshold ?? 400;
  const sizeNote =
    lines > threshold
      ? `This diff is ~${lines} changed lines, past the ${threshold}-line mark where review quality drops sharply — splitting the commit is worth suggesting too.`
      : `Diff is ~${lines} changed ${lines === 1 ? 'line' : 'lines'}.`;

  emit({ ev: 'commit_blocked', ...base, detail: `${lines} lines` });

  deny(
    [
      `Commit blocked by agent-system: this diff has not been through /gate. ${sizeNote}`,
      '',
      'Ask the user with AskUserQuestion — do not decide for them:',
      '  1. Run /gate now, then commit (recommended).',
      '  2. Commit anyway, without review.',
      '',
      `If they choose 2: run \`lanes allow-commit\` in ${root}, then retry the identical git commit command.`,
    ].join('\n'),
  );
}

main().catch(() => process.exit(0));
