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

import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { EVENTS_FILE, resolveContext, expandHome } from '../lib/context.mjs';
import { laneColorFor } from '../lib/colors.mjs';

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
};

function stateOf(ev) {
  return STATES[ev] || { icon: '·', color: C.dim, label: () => ev };
}

/** Events worth a desktop notification when they arrive live. */
const NOTIFY = {
  idle: () => 'Waiting for you',
  commit_blocked: () => 'Commit blocked — needs review',
  agent_end: (e) => `${e.agent || 'Agent'} finished`,
};

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
 * Lane key is `${project}#${lane ?? worktree}` so a worktree outside the
 * configured directory still gets a row rather than silently vanishing.
 */
export function applyEvents(state, events) {
  for (const e of events) {
    if (!e || !e.ev) continue;
    const key = `${e.project || '?'}#${e.lane ?? e.worktree ?? '?'}`;
    const prev = state.lanes.get(key) || {};
    state.lanes.set(key, {
      project: e.project ?? prev.project,
      lane: e.lane ?? prev.lane,
      worktree: e.worktree ?? prev.worktree,
      branch: e.branch ?? prev.branch,
      issue: e.issue ?? prev.issue,
      ev: e.ev,
      agent: e.ev === 'agent_start' ? e.agent : e.ev === 'agent_end' ? null : prev.agent,
      stage: e.ev === 'stage' ? e.stage : prev.stage,
      since: e.ts,
    });
    // `busy` fires on every user message; in the log it is noise.
    if (e.ev !== 'busy') {
      state.history.push(e);
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
    }
  }
  return state;
}

/** All lanes a project declares, so idle worktrees still get a row. */
function declaredLanes(ctx) {
  const dir = expandHome(ctx?.config?.worktreesDir);
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function rowsFor(ctx, lanes) {
  const project = ctx?.project;
  const rows = [];
  const seen = new Set();

  declaredLanes(ctx).forEach((name, i) => {
    const lane = i + 1;
    const key = `${project}#${lane}`;
    seen.add(key);
    rows.push({ lane, worktree: name, ...(lanes.get(key) || { ev: 'session_end' }) });
  });

  // Anything in the log that is not a declared lane of the current project —
  // another repo, or a worktree outside the configured directory.
  for (const [key, st] of lanes) {
    if (!seen.has(key)) rows.push(st);
  }
  return rows;
}

/** Build the frame as a string. Callers decide whether to clear the screen. */
export function render(ctx, state, now = Date.now()) {
  const rows = rowsFor(ctx, state.lanes);
  const colorFor = laneColorFor();
  const width = Math.max(60, process.stdout.columns || 100);
  const out = [];

  const title = `agent-system${ctx?.project ? ` · ${ctx.project}` : ''}`;
  const clock = fmtClock(now);
  const gap = Math.max(1, Math.min(width, 92) - title.length - clock.length);
  out.push(`${C.bold}${title}${C.reset}${C.dim}${' '.repeat(gap)}${clock}${C.reset}`);
  out.push('');
  out.push(
    `${C.bold}${pad('#', 3)}${pad('WORKTREE', 16)}${pad('BRANCH', 30)}${pad('ISSUE', 7)}${pad('STATE', 28)}FOR${C.reset}`,
  );
  out.push(`${C.dim}${'─'.repeat(Math.min(width, 92))}${C.reset}`);

  if (rows.length === 0) {
    out.push(`${C.dim}  No lanes yet. Start a Claude Code session in a configured worktree.${C.reset}`);
  }

  for (const r of rows) {
    const s = stateOf(r.ev);
    const laneColor = colorFor(r.lane);
    out.push(
      pad(r.lane ?? '·', 3) +
        laneColor + pad(r.worktree, 16) + C.reset +
        pad(r.branch || '—', 30) +
        pad(r.issue ? `#${r.issue}` : '—', 7) +
        s.color + pad(`${s.icon} ${s.label(r)}`, 28) + C.reset +
        (r.ev === 'idle' ? C.yellow : C.dim) + (r.since ? fmtElapsed(now - r.since) : '—') + C.reset,
    );
  }

  out.push('');
  out.push(`${C.bold}RECENT${C.reset}`);
  if (state.history.length === 0) out.push(`${C.dim}  (nothing yet)${C.reset}`);
  for (const e of state.history.slice().reverse()) {
    const s = stateOf(e.ev);
    out.push(
      `${C.dim}${fmtClock(e.ts)}${C.reset}  ${pad(e.lane ?? '·', 3)}${s.color}${s.icon} ${pad(s.label(e), 30)}${C.reset}${C.dim}${e.detail || ''}${C.reset}`,
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

  const paint = () => {
    try {
      const fresh = tail.read();
      for (const e of fresh) {
        const body = NOTIFY[e.ev]?.(e);
        if (body) {
          notify(`${e.project || 'lanes'} · lane ${e.lane ?? '?'}${e.issue ? ` · #${e.issue}` : ''}`, body);
        }
      }
      applyEvents(state, fresh);
      // Full redraw: cheap at this size, and it avoids every partial-update
      // artefact that incremental cursor movement would introduce.
      process.stdout.write(
        `\x1b[2J\x1b[H${render(ctx, state)}\n${C.dim}ctrl-c to quit${C.reset}\n`,
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
