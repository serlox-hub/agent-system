/**
 * lanes — live dashboard over the event log.
 *
 * Design constraints:
 *   - Zero token cost. This is a plain Node process reading a file; the model
 *     is never involved and never sees any of it.
 *   - Lane numbers are stable: baked into the `lane<N>` directory name at
 *     creation time (D26), never recomputed from position. `lanes rm` frees a
 *     number back up for reuse by the next `lanes new`, so it can still repeat
 *     across two different worktrees over time — see applyEvents in lib/event-fold.mjs.
 *   - Bounded memory. It is meant to sit in a terminal for weeks, so state is
 *     folded incrementally and history is capped — nothing accumulates.
 *   - Never crash. A malformed line, a vanished directory or a resize must
 *     degrade the display, not kill the process.
 */

import { spawn } from 'node:child_process';
import { EVENTS_FILE, resolveContext } from '../lib/context.mjs';
import { EventTail, createState, applyEvents } from '../lib/event-fold.mjs';
import { enumerateLanes } from '../lib/worktrees.mjs';
import { readLiveStatuses } from '../lib/live-status.mjs';
import { buildSnapshot, createLaneSource } from '../lib/lane-model.mjs';
import { C, renderSnapshot } from './dashboard.mjs';

function notify(title, body) {
  try {
    const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
    // A missing `osascript` (anything but macOS) fails asynchronously, as an
    // 'error' event the catch below never sees — unheard, it kills the process.
    spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], {
      stdio: 'ignore',
      detached: true,
    }).on('error', () => { /* notifications are optional */ }).unref();
  } catch { /* notifications are optional */ }
}

/** Build the frame as a string. Callers decide whether to clear the screen. */
export function render(ctx, state, now = Date.now(), laneInfo = enumerateLanes(ctx?.config), ctxInfo = null, liveStatuses = readLiveStatuses()) {
  return renderSnapshot(buildSnapshot(ctx, state, { now, laneInfo, ctxInfo, liveStatuses }), { width: process.stdout.columns });
}

/** `lanes status --once`. Must not clear the terminal — it is a print, not a live view. */
export function printStatus() {
  const ctx = resolveContext(process.cwd());
  const tail = new EventTail(EVENTS_FILE);
  const state = applyEvents(createState(), tail.read());
  process.stdout.write(`${render(ctx, state)}\n`);
}

/** `lanes status`: the same frame as `printStatus`, redrawn in place once a second. */
export async function watchStatus() {
  // A redraw loop into a pipe or a file is an unbounded ANSI dump nobody
  // reads — piping `lanes status` (a script, or an agent's own Bash call)
  // means a one-shot snapshot was wanted, so give it one instead of hanging.
  if (!process.stdout.isTTY) return printStatus();

  const source = createLaneSource(resolveContext(process.cwd()), { onNotify: ({ title, body }) => notify(title, body) });

  process.stdout.write('\x1b[?25l'); // hide cursor
  const restore = () => {
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
    process.exit(0);
  };
  process.on('SIGINT', restore);
  process.on('SIGTERM', restore);

  const paint = () => {
    try {
      source.advance();
      // Full redraw: cheap at this size, and it avoids every partial-update
      // artefact that incremental cursor movement would introduce.
      process.stdout.write(
        `\x1b[2J\x1b[H${renderSnapshot(source.snapshot(), { width: process.stdout.columns })}\n${C.dim}ctrl-c to quit${C.reset}\n`,
      );
    } catch {
      /* never let a render bug kill the dashboard */
    }
  };

  paint();
  const timer = setInterval(paint, 1000);
  process.on('exit', () => clearInterval(timer));
  await new Promise(() => {}); // until interrupted
}
