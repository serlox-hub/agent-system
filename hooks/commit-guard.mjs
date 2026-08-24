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
 * True when any command in the line is `git commit`.
 *
 * Walks tokens instead of pattern-matching, so it accepts every option form
 * (`-C dir`, `--git-dir=x`, `--no-pager`) while refusing the near-misses that a
 * loose regex would swallow: `git log --grep commit` and `git commit-tree` are
 * not commits.
 */
function isGitCommit(command) {
  for (const segment of String(command).split(/&&|\|\||;|\|/)) {
    const tokens = tokenize(segment.trim());
    const start = tokens.findIndex((t) => t === 'git' || t.endsWith('/git'));
    if (start === -1) continue;
    let i = start + 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i += VALUE_OPTS.has(tokens[i]) ? 2 : 1;
    }
    if (tokens[i] === 'commit') return true;
  }
  return false;
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
  if (!isGitCommit(input?.tool_input?.command || '')) allow();

  const ctx = resolveContext(input?.cwd || process.cwd());
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
