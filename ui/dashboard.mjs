/**
 * lanes — live dashboard over the event log.
 *
 * Design constraints:
 *   - Zero token cost. This is a plain Node process reading a file; the model
 *     is never involved and never sees any of it.
 *   - Lane numbers are stable: the alphabetical position under `worktreesDir`,
 *     not git's own worktree ordering, which shifts on add/remove. A lane number
 *     that moves is worse than no lane number.
 *   - Bounded memory. It is meant to sit in a terminal for weeks, so state is
 *     folded incrementally and history is capped — nothing accumulates.
 *   - Never crash. A malformed line, a vanished directory or a resize must
 *     degrade the display, not kill the process.
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { EVENTS_FILE, resolveContext, issueFromBranch } from '../lib/context.mjs';
import { laneColorFor } from '../lib/colors.mjs';
import { enumerateLanes, laneMarks } from '../lib/worktrees.mjs';

const HISTORY_LIMIT = 12;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
};

function fmtElapsed(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function pad(s, w) {
  const str = String(s ?? '');
  return str.length > w ? `${str.slice(0, w - 1)}…` : str.padEnd(w);
}

/** Incremental reader: keeps a byte offset so we only parse what is new. */
class EventTail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.partial = '';
  }

  read() {
    if (!existsSync(this.file)) return [];
    let size;
    try {
      size = statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // The emitter rotated the log (or it was truncated). Start over rather
      // than emit garbage from a stale offset.
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];
    const len = size - this.offset;
    const buf = Buffer.allocUnsafe(len);
    let fd;
    try {
      fd = openSync(this.file, 'r');
      readSync(fd, buf, 0, len, this.offset);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
    this.offset = size;
    const text = this.partial + buf.toString('utf8');
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* skip torn or malformed line */ }
    }
    return out;
  }
}

const STATES = {
  agent_start: { icon: '●', color: C.green, label: (e) => `${e.agent || 'agent'} running` },
  agent_end: { icon: '●', color: C.cyan, label: () => 'working' },
  busy: { icon: '●', color: C.cyan, label: () => 'working' },
  stage: { icon: '◆', color: C.cyan, label: (e) => `stage: ${e.stage}` },
  idle: { icon: '▲', color: C.yellow, label: () => 'waiting for you' },
  reviewed: { icon: '✓', color: C.green, label: () => 'reviewed, ready to commit' },
  commit_reviewed: { icon: '✓', color: C.green, label: () => 'committing' },
  commit_bypass: { icon: '✓', color: C.dim, label: () => 'committing (unreviewed)' },
  commit_blocked: { icon: '■', color: C.red, label: () => 'commit blocked — needs review' },
  session_start: { icon: '○', color: C.dim, label: () => 'session open' },
  session_end: { icon: '○', color: C.grey, label: () => 'offline' },
  lane_created: { icon: '+', color: C.green, label: () => 'lane created' },
  lane_removed: { icon: '−', color: C.grey, label: () => 'lane removed' },
};

function stateOf(ev) {
  // null/undefined means the fold never saw a liveness event at all for this
  // lane — distinct from `session_end`, which means it saw one close. A stage
  // marker alone (applyEvents no longer lets `stage` set `ev`) is the usual way
  // to land here: real progress was recorded with no session to attach it to,
  // so claiming a state — even "offline" — would overclaim.
  if (ev == null) return { icon: '·', color: C.dim, label: () => 'no session seen' };
  return STATES[ev] || { icon: '·', color: C.dim, label: () => ev };
}

/** Events worth a desktop notification when they arrive live. */
const NOTIFY = {
  idle: () => 'Waiting for you',
  commit_blocked: () => 'Commit blocked — needs review',
  agent_end: (e) => `${e.agent || 'Agent'} finished`,
};

/**
 * Every lane/row in this file falls back to worktree when there is no lane
 * (applyEvents' key at line ~157, render's `·` placeholder) — worktree is the
 * one identifier that always exists, since resolveLane always sets it from the
 * directory basename even when lane is null (lib/context.mjs:86-99). The
 * notification title follows the same fallback so it is never unidentifiable.
 */
export function notifyTitle(e) {
  return `${e.project || 'lanes'}${e.lane ? ` · lane ${e.lane}` : e.worktree ? ` · ${e.worktree}` : ''}${e.issue ? ` · #${e.issue}` : ''}`;
}

function notify(title, body) {
  try {
    const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
    spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch { /* notifications are optional */ }
}

export function createState() {
  return { lanes: new Map(), history: [] };
}

/**
 * Fold events into state, in place. Called with only the events that are new
 * since the last call, so cost is proportional to what arrived — not to how
 * long the dashboard has been running.
 *
 * Lane key is `${project}#${worktree}`, never the lane number: the number is
 * only the alphabetical position under `worktreesDir` right now (D9), so it is
 * reused as worktrees come and go. Keying by it — like the bug D18 already
 * fixed once for lib/services.mjs — makes a freshly created lane inherit a
 * removed one's stale state the moment it lands on the same position.
 */
export function applyEvents(state, events) {
  for (const e of events) {
    if (!e || !e.ev) continue;
    const key = `${e.project || '?'}#${e.worktree ?? '?'}`;
    if (e.ev === 'lane_removed') {
      // Authoritative: this name is gone, so nothing it carried (issue, stage,
      // agent) may leak into whatever gets created under the same name next.
      state.lanes.delete(key);
    } else {
      // A fresh occupant starts from nothing — merging into the outgoing
      // lane's leftover state is exactly the name-reuse bug this guards
      // against (lane numbers already had this fixed by keying on name; a
      // recreated name needs the same reset lane numbers get automatically).
      const prev = e.ev === 'lane_created' ? {} : (state.lanes.get(key) || {});
      state.lanes.set(key, {
        project: e.project ?? prev.project,
        lane: e.lane ?? prev.lane,
        worktree: e.worktree ?? prev.worktree,
        branch: e.branch ?? prev.branch,
        issue: e.issue ?? prev.issue,
        path: e.path ?? prev.path,
        // `stage` is a pipeline milestone, not a liveness signal — it must not
        // overwrite the last real session/agent state, or a lane goes cyan
        // "working" the moment a checkpoint fires and stays that way forever
        // once the session behind it is long gone.
        ev: e.ev === 'stage' ? (prev.ev ?? null) : e.ev,
        agent: e.ev === 'agent_start' ? e.agent : e.ev === 'agent_end' ? null : prev.agent,
        stage: e.ev === 'stage' ? e.stage : prev.stage,
        // Same reasoning as `ev`: a stage marker must not reset how long the
        // *state* next to it has been true, or FOR lies the instant one fires.
        since: e.ev === 'stage' ? (prev.since ?? e.ts) : e.ts,
      });
    }
    // `busy` fires on every user message; in the log it is noise.
    if (e.ev !== 'busy') {
      state.history.push(e);
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
    }
  }
  return state;
}

function rowsFor(ctx, lanes, laneInfo) {
  const project = ctx?.project;
  const rows = [];
  const seen = new Set();

  for (const l of laneInfo) {
    const key = `${project}#${l.name}`;
    seen.add(key);
    const prev = lanes.get(key) || { ev: 'session_end' };
    // `lane`/`worktree`/`dirty`/`ahead`/`behind`/`baseKnown` always come from
    // the live git read, never from the stored event — those are keyed by
    // name but may carry a lane number recorded back when this name sat at a
    // different position, and never carried divergence data at all.
    rows.push({
      ...prev,
      ...l,
      worktree: l.name,
      // A transient git failure (fresh value `null`) must never blank a
      // previously-known-good branch — hence nullish, not `||`.
      branch: l.branch ?? prev.branch,
      // Falls back to the last reported issue only when the branch itself
      // could not be read — matching `resolveContext`, which derives the
      // issue from the branch alone with no fallback. If the branch *was*
      // read and simply encodes no issue (e.g. back on base), that is the
      // truth: keeping a stale issue would contradict a fresh "free" MARKS
      // on the same row, since neither this issue nor this branch matches it.
      issue: l.branch ? issueFromBranch(l.branch, ctx?.config) : prev.issue,
    });
  }

  // Anything in the log that is not a declared lane — another repo, or a
  // worktree outside the configured directory. `lanes rm` deletes its entry
  // outright (see applyEvents), so what is left here is either genuinely
  // outside `worktreesDir` or was removed some other way (manual `rm -rf`,
  // `git worktree remove`) with no event to say so. `existsSync` on the path
  // recorded with the event is the backstop for that second case — exact,
  // not name-matched, and works for any project since it needs no git call
  // scoped to the current repo. Events older than the `path` field have none
  // and fail open, same as anything we simply can't verify.
  for (const [key, st] of lanes) {
    if (seen.has(key)) continue;
    if (st.path && !existsSync(st.path)) continue;
    rows.push(st);
  }
  return rows;
}

const MARKS_WIDTH = 12;
const MARKS_TONE = { dirty: C.yellow, ahead: C.green, behind: C.red, unknown: C.yellow, free: C.dim };

/**
 * The plain text (`laneMarks`' tokens joined by ' ') is measured and padded
 * first, since `pad()` counts raw `.length` and would misalign on text that
 * already carries ANSI codes; the coloured version is then wrapped around
 * each token, reusing the padding `pad()` already computed.
 */
function marksCell(r) {
  const tokens = laneMarks(r);
  const plain = tokens.map((t) => t.text).join(' ');
  const padded = pad(plain, MARKS_WIDTH);
  if (!plain || plain.length >= MARKS_WIDTH) return padded;
  const trailing = padded.slice(plain.length);
  const colored = tokens.map((t) => `${MARKS_TONE[t.tone]}${t.text}${C.reset}`).join(' ');
  return colored + trailing;
}

/** Build the frame as a string. Callers decide whether to clear the screen. */
export function render(ctx, state, now = Date.now(), laneInfo = enumerateLanes(ctx?.config)) {
  const rows = rowsFor(ctx, state.lanes, laneInfo);
  const colorFor = laneColorFor();
  const width = Math.max(60, process.stdout.columns || 100);
  const out = [];

  const title = `agent-system${ctx?.project ? ` · ${ctx.project}` : ''}`;
  const clock = fmtClock(now);
  // Wide and fixed on purpose: a narrower adaptive layout would have to hide
  // columns as more get added over time, and STAGE next to STATE is exactly
  // that first addition. Assumes a wide-enough terminal; a split pane wraps.
  const barWidth = Math.min(width, 152);
  const gap = Math.max(1, barWidth - title.length - clock.length);
  out.push(`${C.bold}${title}${C.reset}${C.dim}${' '.repeat(gap)}${clock}${C.reset}`);
  out.push('');
  out.push(
    `${C.bold}${pad('#', 3)}${pad('WORKTREE', 20)}${pad('BRANCH', 40)}${pad('MARKS', MARKS_WIDTH)}${pad('ISSUE', 8)}${pad('STAGE', 18)}${pad('STATE', 32)}FOR${C.reset}`,
  );
  out.push(`${C.dim}${'─'.repeat(barWidth)}${C.reset}`);

  if (rows.length === 0) {
    out.push(`${C.dim}  No lanes yet. Start a Claude Code session in a configured worktree.${C.reset}`);
  }

  for (const r of rows) {
    const s = stateOf(r.ev);
    const laneColor = colorFor(r.lane);
    out.push(
      pad(r.lane ?? '·', 3) +
        laneColor + pad(r.worktree, 20) + C.reset +
        pad(r.branch || '—', 40) +
        marksCell(r) +
        pad(r.issue ? `#${r.issue}` : '—', 8) +
        C.dim + pad(r.stage || '—', 18) + C.reset +
        s.color + pad(`${s.icon} ${s.label(r)}`, 32) + C.reset +
        (r.ev === 'idle' ? C.yellow : C.dim) + (r.since ? fmtElapsed(now - r.since) : '—') + C.reset,
    );
  }

  out.push('');
  out.push(`${C.bold}RECENT${C.reset}`);
  if (state.history.length === 0) out.push(`${C.dim}  (nothing yet)${C.reset}`);
  for (const e of state.history.slice().reverse()) {
    const s = stateOf(e.ev);
    // Fall back to worktree name when there is no lane number — same fallback
    // as the main table's WORKTREE column and notifyTitle, so a row is never
    // reduced to the bare `·` placeholder with nothing to identify it by.
    const who = e.lane ?? e.worktree ?? '·';
    const whoColor = e.lane != null ? colorFor(e.lane) : C.dim;
    out.push(
      `${C.dim}${fmtClock(e.ts)}${C.reset}  ${whoColor}${pad(who, 13)}${C.reset}${s.color}${s.icon} ${pad(s.label(e), 30)}${C.reset}${C.dim}${e.detail || ''}${C.reset}`,
    );
  }
  return out.join('\n');
}

/** One-shot snapshot. Must not clear the terminal — it is a print, not a UI. */
export function printStatus() {
  const ctx = resolveContext(process.cwd());
  const tail = new EventTail(EVENTS_FILE);
  const state = applyEvents(createState(), tail.read());
  process.stdout.write(`${render(ctx, state)}\n`);
}

export async function runUi() {
  const ctx = resolveContext(process.cwd());
  const tail = new EventTail(EVENTS_FILE);
  const state = createState();

  // Replay history for state, but never notify for it — only live events.
  applyEvents(state, tail.read());

  process.stdout.write('\x1b[?25l'); // hide cursor
  const restore = () => {
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
    process.exit(0);
  };
  process.on('SIGINT', restore);
  process.on('SIGTERM', restore);

  // Git-derived per-lane data costs a subprocess set per lane, so it is
  // refreshed only every 20 ticks (~20s at the 1Hz redraw below) rather than
  // on every paint — including which worktrees exist, so a lane created or
  // removed elsewhere can take up to ~20s to appear/disappear here. Setup-time
  // action, not a per-task one, so that lag is accepted rather than paid for
  // on every tick.
  let tick = -1;
  let laneInfo;

  const paint = () => {
    try {
      const fresh = tail.read();
      for (const e of fresh) {
        const body = NOTIFY[e.ev]?.(e);
        if (body) {
          notify(notifyTitle(e), body);
        }
      }
      applyEvents(state, fresh);
      tick += 1;
      if (tick % 20 === 0) laneInfo = enumerateLanes(ctx.config);
      // Full redraw: cheap at this size, and it avoids every partial-update
      // artefact that incremental cursor movement would introduce.
      process.stdout.write(
        `\x1b[2J\x1b[H${render(ctx, state, Date.now(), laneInfo)}\n${C.dim}ctrl-c to quit${C.reset}\n`,
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
