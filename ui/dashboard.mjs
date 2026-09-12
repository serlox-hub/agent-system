/**
 * The terminal view: `renderSnapshot` draws a `buildSnapshot` result
 * (lib/lane-model.mjs) and decides nothing about what is true. A rule about
 * what a row *means* — the live override, which sessions get a row, what
 * counts as live — belongs in the model, where every view shares it; here it
 * would be one view's private copy, free to drift.
 *
 * Pure — no I/O, no `process` reads, only the clock's local time zone is
 * ambient — which is what lets #19's golden frames pin every byte. And it must
 * not throw on what a snapshot carries: `ev` can come straight from an
 * untrusted live-status file, so `stateOf` falls back on an unknown one
 * rather than looking it up blindly.
 */

import { ansi } from '../lib/colors.mjs';

export const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
};

export function fmtElapsed(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d${String(h % 24).padStart(2, '0')}h`;
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

const STATES = {
  agent_start: { icon: '●', color: C.green, label: (e) => `${e.agent || 'agent'} running` },
  agent_end: { icon: '●', color: C.cyan, label: () => 'working' },
  busy: { icon: '●', color: C.cyan, label: () => 'working' },
  stage: { icon: '◆', color: C.cyan, label: (e) => `stage: ${e.stage}` },
  idle: { icon: '▲', color: C.yellow, label: () => 'waiting for you' },
  waiting: { icon: '?', color: C.yellow, label: (e) => (e.waitingFor ? `waiting: ${e.waitingFor}` : 'waiting for you') },
  reviewed: { icon: '✓', color: C.green, label: () => 'ready to commit' },
  commit_reviewed: { icon: '✓', color: C.green, label: () => 'committing' },
  commit_bypass: { icon: '✓', color: C.dim, label: () => 'committing (unreviewed)' },
  commit_blocked: { icon: '■', color: C.red, label: () => 'blocked, needs review' },
  session_start: { icon: '○', color: C.dim, label: () => 'session open' },
  session_end: { icon: '○', color: C.grey, label: () => 'offline' },
  lane_created: { icon: '+', color: C.green, label: () => 'lane created' },
  lane_removed: { icon: '−', color: C.grey, label: () => 'lane removed' },
  lane_reset: { icon: '↺', color: C.grey, label: () => 'lane reset' },
};

function stateOf(ev) {
  // null/undefined means the fold never saw a liveness event at all for this
  // lane — distinct from `session_end`, which means it saw one close. A stage
  // marker alone (applyEvents, lib/event-fold.mjs, no longer lets `stage` set
  // `ev`) is the usual way to land here: real progress was recorded with no
  // session to attach it to, so claiming a state — even "offline" — would
  // overclaim.
  if (ev == null) return { icon: '·', color: C.dim, label: () => 'no session seen' };
  // `Object.hasOwn`, not `STATES[ev] ||` — `ev` can come straight from an
  // untrusted live-status file (lib/live-status.mjs) once withLiveOverride
  // (lib/lane-model.mjs) assigns it, and a value like `constructor` resolves
  // on the plain object literal via the prototype chain, returning a function
  // where a state descriptor was expected and throwing inside renderSnapshot()
  // the moment `s.label(r)` is called.
  return Object.hasOwn(STATES, ev) ? STATES[ev] : { icon: '·', color: C.dim, label: () => ev };
}

const MARKS_TONE = { danger: `${C.bold}${C.red}`, dirty: C.yellow, ahead: C.green, behind: C.red, unknown: C.yellow, free: C.dim };

/**
 * `[#<issue>] <branch> (<marks>)`, the row's one variable-width cell — issue
 * and marks are always shown in full (they are the decision-relevant part:
 * `lanes free`'s "nothing would be lost" reasoning is built on marks), only
 * the branch/name part itself is ellipsis-truncated when the budget is tight.
 * Composed and measured as plain text first, coloured after, same reason as
 * the old `marksCell` this replaces: `pad()` counts raw `.length` and would
 * misalign on text that already carries ANSI codes.
 *
 * A row with no branch — a foreign-project/vanished-lane row kept alive by
 * `rowsFor`'s fail-open `existsSync` check (lib/lane-model.mjs), or a
 * declared lane mid a transient git-read failure — falls back to the worktree
 * name in the branch slot, the one identifier that always exists (matches
 * `notifyTitle`'s fallback, lib/lane-model.mjs), but still shows a
 * carried-forward issue or marks: a failed *branch* read must not blank an
 * issue number `rowsFor` already decided to keep.
 *
 * Carries no project identity of its own — a row from another project (D8:
 * the events log and live-status dir are both machine-global, so `rowsFor`
 * can surface one) is disambiguated by the snapshot's project groups instead,
 * a header line rather than eating into this cell's already-tight width.
 */
function branchCell(r, width) {
  const issuePrefix = r.issue ? `[#${r.issue}] ` : '';
  const tokens = r.marks;
  const marksPlain = tokens.map((t) => t.text).join(' ');
  const marksSuffix = marksPlain ? ` (${marksPlain})` : '';
  const name = r.branch || r.worktree || '—';
  const nameBudget = Math.max(1, width - issuePrefix.length - marksSuffix.length);
  const nameText = name.length > nameBudget
    ? `${name.slice(0, Math.max(0, nameBudget - 1))}…`
    : name;
  const plain = `${issuePrefix}${nameText}${marksSuffix}`;
  const padded = pad(plain, width);
  if (!marksPlain || plain.length > width) return padded;
  const coloredMarks = tokens.map((t) => `${MARKS_TONE[t.tone]}${t.text}${C.reset}`).join(' ');
  return `${issuePrefix}${nameText} (${coloredMarks})` + padded.slice(plain.length);
}

/** The service line's text: the URL (or `localhost:<port>`), `!` when the port moved, then the count of the rest. */
function serviceText({ url, port, moved, others }) {
  const mark = moved ? '!' : '';
  const text = url ? `${url}${mark}` : `localhost:${port}${mark}`;
  return others > 0 ? `${text} (+${others} more)` : text;
}

export function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

/**
 * "143K·sonnet-5", or "—". The model tag rides alongside the count because
 * the same number means different things on different models — a raw token
 * count with no context-window-size table to compare it against (D25: never a
 * percentage — no fixed denominator is right for every model). No literal
 * "ctx" in the text: the CTX column header already says so, same as STAGE/
 * STATE cells never repeated their own column name.
 */
function ctxCell(context) {
  if (!context) return '—';
  return `${fmtTokens(context.tokens)}·${context.model.replace(/^claude-/, '')}`;
}

const LANE_WIDTH = 3;
// Fits every STATES label and every agent name this repo's own agents produce
// in full (longest: "spec-challenger running" at 25 with its icon). Two
// STATES labels (commit_blocked, reviewed) were shortened to fit this rather
// than widening it — see their wording above.
const STATE_WIDTH = 26;
// Hours-only overflowed this at 1000h (~42 days idle — ordinary under D20); d/h
// holds the same 7 chars out to "999d23h". 7 is load-bearing: renderSnapshot()'s
// reserved budget (below) is solved against the 100-col cap (D29).
const FOR_WIDTH = 7;
const CTX_WIDTH = 24; // fits the worst realistic model id after stripping "claude-" (~19 chars) + tokens
const CTX_MIN_TERM_WIDTH = 85; // below this, drop the CTX column outright rather than starve BRANCH
const BRANCH_FLOOR = 20;

/**
 * The STATE and FOR cells, shared by a lane's own row and #14's extra
 * session rows — LANE, BRANCH and CTX differ enough between the two (lane
 * colour vs dim, a real branch vs a bare session name, and — even once both
 * read a real transcript — the primary row's CTX dims when not live while an
 * extra row's never does) that STATE/FOR are the only two cells genuinely the
 * same rule either way. Extracted so a status added to `STATES` only needs
 * its colour/label rule written once, instead of drifting between two
 * copies — the same failure mode `serviceFor`'s own docstring
 * (lib/lane-model.mjs) documents having already been paid for once, when its
 * two halves were independently re-derived and disagreed.
 *
 * `labelInput` is whatever `STATES[ev].label` expects: the snapshot lane for
 * the primary row (`agent_start`'s `e.agent`, `stage`'s `e.stage`, …), or the
 * extra session itself, which only ever carries a live busy/idle/waiting
 * status and has no `agent`/`stage` of its own.
 */
function stateAndForCells(ev, labelInput, since, now) {
  const s = stateOf(ev);
  return [
    s.color + pad(`${s.icon} ${s.label(labelInput)}`, STATE_WIDTH) + C.reset,
    (ev === 'idle' || ev === 'waiting' ? C.yellow : C.dim) + pad(since ? fmtElapsed(now - since) : '—', FOR_WIDTH) + C.reset,
  ];
}

/**
 * The terminal's view of a `buildSnapshot` result: every ANSI code, column
 * width and line of the frame, none of the rules deciding what it says. Pure
 * — no I/O and no `process` reads — so the caller passes the raw terminal
 * width.
 */
export function renderSnapshot(snapshot, { width } = {}) {
  const { now } = snapshot;
  const out = [];

  // D29: capped at 100 even on a wider terminal, deliberately — the frame
  // stays a consistent, compact shape rather than stretching back out to show
  // more of the branch name the way it used to. Still adaptive downward: on
  // anything narrower it shrinks with `width`, floored at 60; an unknown
  // width (`undefined`/0, e.g. not a TTY) renders at 100.
  const termWidth = Math.min(Math.max(60, width || 100), 100);
  const showCtx = termWidth >= CTX_MIN_TERM_WIDTH;
  // 4 single-space gaps between 5 cells (LANE BRANCH STATE FOR CTX), or 3
  // between 4 when CTX is dropped — BRANCH is the only cell excluded, since
  // it is the free variable the rest of this reservation solves for.
  const reserved = LANE_WIDTH + STATE_WIDTH + FOR_WIDTH + (showCtx ? CTX_WIDTH + 4 : 3);
  const branchWidth = Math.max(BRANCH_FLOOR, termWidth - reserved);

  const title = `agent-system${snapshot.project ? ` · ${snapshot.project}` : ''}`;
  const clock = fmtClock(now);
  const headerCells = [pad('#', LANE_WIDTH), pad('BRANCH', branchWidth), pad('STATE', STATE_WIDTH), pad('FOR', FOR_WIDTH)];
  if (showCtx) headerCells.push(pad('CTX', CTX_WIDTH));
  const headerRow = headerCells.join(' ');
  const titleWidth = termWidth;
  // The rule under the header must never render narrower than the header
  // itself, or its tail (STATE, FOR) hangs past the rule with nothing
  // underlining it. Measured from the real string rather than a hand-kept
  // constant, so widening a column can never silently reopen that gap.
  const barWidth = Math.max(headerRow.length, titleWidth);
  const gap = Math.max(1, titleWidth - title.length - clock.length);
  out.push(`${C.bold}${title}${C.reset}${C.dim}${' '.repeat(gap)}${clock}${C.reset}`);
  out.push('');
  out.push(`${C.bold}${headerRow}${C.reset}`);
  out.push(`${C.dim}${'─'.repeat(barWidth)}${C.reset}`);

  if (snapshot.groups.length === 0) {
    out.push(`${C.dim}  No lanes yet. Start a Claude Code session in a configured worktree.${C.reset}`);
  }

  // Blank between lanes, not after every one: keeps the visual grouping this
  // loop exists for, and is what binds an optional service line to the row
  // above it now that most lanes are back down to a single row. Leaves the
  // trailing `out.push('')` below as the single, unconditional separator
  // before RECENT, in both the populated and empty-lanes cases. A new
  // project group gets the same blank-line separator before it, with its
  // header line taking the place of the group's first row for that purpose.
  let firstBlock = true;
  for (const { project, lanes } of snapshot.groups) {
    if (!firstBlock) out.push('');
    out.push(`${C.dim}${project}${C.reset}`);
    firstBlock = false;

    lanes.forEach((r, i) => {
      if (i > 0) out.push('');
      const [stateCell, forCell] = stateAndForCells(r.ev, r, r.since, now);
      const cells = [
        ansi(r.color) + pad(r.lane ?? '·', LANE_WIDTH) + C.reset,
        branchCell(r, branchWidth),
        stateCell,
        forCell,
      ];
      if (showCtx) cells.push((r.live ? '' : C.dim) + pad(ctxCell(r.context), CTX_WIDTH) + C.reset);
      out.push(cells.join(' '));

      // Extra session rows directly beneath — no blank line, and before the
      // service line below, so a lane's session rows stay adjacent to its own
      // row; the service line (one dev-server URL per lane, not per session)
      // reads as the whole block's footer instead of splitting two session
      // rows apart. The blank line pushed at the top of this callback still
      // only separates one lane's whole block from the next.
      for (const s of r.extraSessions) {
        const [extraStateCell, extraForCell] = stateAndForCells(s.status, s, s.since, now);
        const extraCells = [
          C.dim + pad('·', LANE_WIDTH) + C.reset,
          C.dim + pad(s.name || s.sessionId, branchWidth) + C.reset,
          extraStateCell,
          extraForCell,
        ];
        // Always live-toned, never dimmed: unlike row `[0]`, an extra row only
        // ever exists for a session `readLiveStatuses()` (lib/live-status.mjs)
        // just confirmed is live.
        if (showCtx) extraCells.push(pad(ctxCell(s.context), CTX_WIDTH));
        out.push(extraCells.join(' '));
      }

      if (r.service) {
        out.push(`${' '.repeat(LANE_WIDTH + 1)}${C.dim}${serviceText(r.service)}${C.reset}`);
      }
    });
  }

  out.push('');
  out.push(`${C.bold}RECENT${C.reset}`);
  if (snapshot.history.length === 0) out.push(`${C.dim}  (nothing yet)${C.reset}`);
  // Unlike the lane table above, RECENT is one chronological log — grouping
  // by project would break the ordering that makes it useful, so every entry
  // (D8: the events log is machine-global, so this can mix in another
  // project's own) gets a per-line project tag instead, `ctx.project`'s own
  // rows included — unlike the table, nothing here already names the current
  // project once for the whole block, so leaving it out would make the
  // exact-same-project rows the unlabelled special case instead of the
  // labelled one. Unconditional, unlike an earlier version gated on whether
  // `state.history` currently mixes projects: that flag flips as the
  // HISTORY_LIMIT-capped window rolls, reflowing all 12 lines by a column
  // width on every tick a foreign event enters or leaves it — visible jitter
  // with no state change the user caused, exactly what D29 (above) and D37
  // (lib/lane-model.mjs) already rule against. RECENT lines carry no
  // fixed-width cap (`detail` alone runs to 300 chars), so the always-on
  // column costs nothing the frame was protecting.
  for (const e of snapshot.history.slice().reverse()) {
    const s = stateOf(e.ev);
    // Fall back to worktree name when there is no lane number — same fallback
    // as `branchCell`'s ghost-row case and `notifyTitle` (lib/lane-model.mjs),
    // so a row is never reduced to the bare `·` placeholder with nothing to
    // identify it by.
    const rawWho = e.lane ?? e.worktree ?? '·';
    // An event with no lane falls back to its worktree name (above), which
    // for a main-repo/non-lane session is that repo's own directory name —
    // the same string `projectTag` always shows right next to it now that
    // the tag is unconditional. Collapsing `who` to `·` only in that exact
    // collision avoids printing e.g. "agent-system agent-system" side by
    // side, without touching the fallback for every other case (a real lane
    // number never collides).
    const projectText = e.project || '';
    const who = projectText && projectText === rawWho ? '·' : rawWho;
    const whoColor = e.lane != null ? ansi(e.color) : C.dim;
    const projectTag = `${C.dim}${pad(projectText, 12)} ${C.reset}`;
    out.push(
      `${C.dim}${fmtClock(e.ts)}${C.reset}  ${projectTag}${whoColor}${pad(who, 13)}${C.reset}${s.color}${s.icon} ${pad(s.label(e), 30)}${C.reset}${C.dim}${e.detail || ''}${C.reset}`,
    );
  }
  return out.join('\n');
}
