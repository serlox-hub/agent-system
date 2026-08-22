/**
 * Best-effort reader of a Claude Code session transcript.
 *
 * The transcript format is internal and unversioned — it can change on any
 * release — so every failure mode here degrades to `null` rather than
 * throwing. This is called from `ui/dashboard.mjs`'s render path, which some
 * callers (`printStatus`) invoke with no try/catch of their own.
 */

import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';

/**
 * Fast path: real transcript lines have been measured up to ~817KB, far past
 * a naive small window, so 256KB is not a guess at "big enough" — it is
 * "usually enough, with a full-file fallback for when it isn't."
 */
const TAIL_BYTES = 256 * 1024;

function readTail(path, size, bytes) {
  const len = Math.min(size, bytes);
  const start = size - len;
  const buf = Buffer.allocUnsafe(len);
  let fd;
  try {
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Scan backward for the most recent usable assistant turn. `<synthetic>` is
 * Claude Code's own sentinel for a non-turn marker (session limit, interrupt)
 * and a zero token total is the same kind of non-reading — both would
 * otherwise be misread as "zero tokens in use" instead of skipped.
 */
function scanForContext(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partial line at the start of a tail read, or corrupt bytes
    }
    if (entry?.type !== 'assistant') continue;
    const model = entry?.message?.model;
    if (!model || model === '<synthetic>') continue;
    const usage = entry?.message?.usage;
    if (!usage) continue;
    const tokens =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);
    if (tokens === 0) continue;
    return { tokens, model };
  }
  return null;
}

/** `{ tokens, model }` for the latest usable turn, or `null`. Never throws. */
export function readContext(transcriptPath) {
  try {
    if (!transcriptPath || typeof transcriptPath !== 'string') return null;
    const size = statSync(transcriptPath).size;
    if (size === 0) return null;
    const found = scanForContext(readTail(transcriptPath, size, TAIL_BYTES));
    if (found) return found;
    // Nothing qualifying in the tail — either the file is small and empty of
    // real turns, or a single line near the end is larger than the tail
    // window itself. Retry once against the full file rather than guess.
    if (size > TAIL_BYTES) return scanForContext(readFileSync(transcriptPath, 'utf8'));
    return null;
  } catch {
    return null;
  }
}
