/**
 * lanes — live dashboard over the event log.
 *
 * Design constraints:
 *   - Zero token cost. This is a plain Node process reading a file; the model
 *     is never involved and never sees any of it.
 *   - Lane numbers are stable: baked into the `lane<N>` directory name at
 *     creation time (D26), never recomputed from position. `lanes rm` frees a
 *     number back up for reuse by the next `lanes new`, so it can still repeat
 *     across two different worktrees over time — see applyEvents below.
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
import { resolveServices, status as serviceStatus, boundPort } from '../lib/services.mjs';
import { readContext } from '../lib/transcript.mjs';
import { readLiveStatuses } from '../lib/live-status.mjs';

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

// `waitingFor` comes straight from an undocumented external file
// (lib/live-status.mjs), which already strips control/ANSI bytes at the trust
// boundary — this only bounds the length, so `pad()` never has to truncate a
// pathological value on every render tick.
const WAITING_FOR_MAX = 200;

function sanitize(s) {
  if (typeof s !== 'string') return '';
  return s.length > WAITING_FOR_MAX ? `${s.slice(0, WAITING_FOR_MAX - 1)}…` : s;
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
  waiting: { icon: '?', color: C.yellow, label: (e) => (e.waitingFor ? `waiting: ${sanitize(e.waitingFor)}` : 'waiting for you') },
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
  // marker alone (applyEvents no longer lets `stage` set `ev`) is the usual way
  // to land here: real progress was recorded with no session to attach it to,
  // so claiming a state — even "offline" — would overclaim.
  if (ev == null) return { icon: '·', color: C.dim, label: () => 'no session seen' };
  // `Object.hasOwn`, not `STATES[ev] ||` — `ev` can come straight from an
  // untrusted live-status file (lib/live-status.mjs) once withLiveOverride
  // assigns it, and a value like `constructor` resolves on the plain object
  // literal via the prototype chain, returning a function where a state
  // descriptor was expected and throwing inside render() the moment
  // `s.label(r)` is called.
  return Object.hasOwn(STATES, ev) ? STATES[ev] : { icon: '·', color: C.dim, label: () => ev };
}

/** Events worth a desktop notification when they arrive live. */
const NOTIFY = {
  idle: () => 'Waiting for you',
  waiting: (e) => (e.waitingFor ? `Needs your input: ${sanitize(e.waitingFor)}` : 'Needs your input'),
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
  return { lanes: new Map(), history: [], sessionHistory: new Map() };
}

// Lane-lifecycle events are facts about a worktree, not about whichever
// session happened to type the command that produced them — `lanes new`/
// `rm`/`reset` run in one session but name a possibly-unrelated lane. The
// per-lane fold below is scoped by construction (its `key` IS that lane), so
// this only matters for the per-session fold, which has no such scoping.
const LANE_LIFECYCLE = new Set(['lane_created', 'lane_removed', 'lane_reset']);

/**
 * `ev` fold rule shared by the per-lane and per-session folds in
 * `applyEvents`: `stage` is a pipeline milestone, not a liveness signal, and
 * must not overwrite the last real state, or a row goes cyan "working" the
 * moment a checkpoint fires and stays that way forever once the session
 * behind it is gone.
 *
 * `LANE_LIFECYCLE` gets the same "must not overwrite" treatment too, but
 * only where the per-session fold calls this — never for the per-lane fold.
 * There, `ev` BECOMING `'lane_created'`/`'lane_reset'` on the row itself is
 * the whole point of those two events (`render()`'s STATE cell shows "lane
 * reset"), and `lane_removed` deletes the row outright rather than reaching
 * this function at all.
 */
function foldEv(e, prev) {
  return e.ev === 'stage' ? (prev.ev ?? null) : e.ev;
}

/**
 * `transcript` fold rule shared by both folds: a new session start is
 * authoritative, like `lane_created` is for the whole row — without this, a
 * `session_start` with no `transcript_path` of its own (payload omitted or
 * empty) would silently inherit the OUTGOING session's transcript via `??`,
 * and render it in live tone as if it belonged to the new one.
 */
function foldTranscript(e, prev) {
  return e.ev === 'session_start' ? (e.transcript ?? null) : (e.transcript ?? prev.transcript ?? null);
}

/**
 * Fold events into state, in place. Called with only the events that are new
 * since the last call, so cost is proportional to what arrived — not to how
 * long the dashboard has been running.
 *
 * Lane key is `${project}#${worktree}`, never the lane number: outside
 * `worktreesDir` `lane` is `null`, so a numeric key isn't even available
 * there. Under D26's `lane<N>` naming the two are otherwise the same value —
 * `lanes rm` frees a number and the next `lanes new` deliberately reuses it —
 * so it is this function, not the key, that stops a freshly created lane from
 * inheriting a removed one's stale state (D18): `lane_removed` below deletes
 * it outright, `lane_created` starts the row from `{}`.
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
      // against. `lane_reset` gets the same treatment as `lane_created`: a
      // lane returned to a clean base state is a fresh start too, and must
      // not keep showing the just-finished task's stage/state/timer/context.
      const prev = (e.ev === 'lane_created' || e.ev === 'lane_reset') ? {} : (state.lanes.get(key) || {});
      state.lanes.set(key, {
        project: e.project ?? prev.project,
        lane: e.lane ?? prev.lane,
        worktree: e.worktree ?? prev.worktree,
        branch: e.branch ?? prev.branch,
        issue: e.issue ?? prev.issue,
        path: e.path ?? prev.path,
        transcript: foldTranscript(e, prev),
        ev: foldEv(e, prev),
        agent: e.ev === 'agent_start' ? e.agent : e.ev === 'agent_end' ? null : prev.agent,
        // Kept folded although render() no longer displays it (#9 dropped the
        // STAGE column) — RECENT reads a stage event's own `e.stage` straight
        // off the raw log, never this field, so nothing currently reads it.
        // Deliberately out of scope for #9, not dead by accident: removing it
        // is a separate call, not a side effect of a display change.
        stage: e.ev === 'stage' ? e.stage : prev.stage,
        // Same reasoning as `ev`: a stage marker must not reset how long the
        // *state* next to it has been true, or FOR lies the instant one fires.
        since: e.ev === 'stage' ? (prev.since ?? e.ts) : e.ts,
      });
    }
    // Per-session fold (#14 Phase 4), additive and independent of the
    // per-lane fold above: a session can outlive the lane row it started in
    // (or never even resolve to one, in principle), and #14's extra rows key
    // on session identity, not lane identity. Every event with a `session`
    // folds here, `busy` included — it is only excluded from `state.history`
    // (the RECENT log) below, not from this fold, matching how `busy`
    // already updates `state.lanes`'s own `ev`.
    if (e.session) {
      const prevS = state.sessionHistory.get(e.session) || {};
      state.sessionHistory.set(e.session, {
        transcript: foldTranscript(e, prevS),
        // `LANE_LIFECYCLE` never overwrites a session's own `ev` — see its
        // comment above — on top of `foldEv`'s shared `stage` exclusion.
        ev: LANE_LIFECYCLE.has(e.ev) ? (prevS.ev ?? null) : foldEv(e, prevS),
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

/**
 * Drops any `state.sessionHistory` entry not in `onScreenSessionIds`,
 * in place. `readLiveStatuses()` is global — every Claude Code session on
 * the machine, any project, any window — so retaining every live session's
 * history would keep `ctxInfo`'s throttled `readContext()` walk (see
 * `watchStatus`) doing real per-tick work for sessions `render()` never
 * looks at. `session_end` is not reliably observed (#12's own
 * investigation), so this is the only eviction path `sessionHistory` has.
 */
export function pruneSessionHistory(state, onScreenSessionIds) {
  for (const sessionId of state.sessionHistory.keys()) {
    if (!onScreenSessionIds.has(sessionId)) state.sessionHistory.delete(sessionId);
  }
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
    // the live git read, never from the stored event — stored events never
    // carried divergence data at all. `project` is likewise never taken from
    // `prev`: this row came from `laneInfo`, i.e. from `ctx`'s own
    // `worktreesDir`, so it belongs to `project` regardless of whether any
    // event ever fired for this exact lane (a fresh lane's `prev` fallback
    // carries no `project` field at all) — without this, a never-touched own
    // lane and a foreign one look identical to the grouping below.
    rows.push({
      ...prev,
      ...l,
      worktree: l.name,
      project,
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
 * `rowsFor`'s fail-open `existsSync` check, or a declared lane mid a transient
 * git-read failure — falls back to the worktree name in the branch slot, the
 * one identifier that always exists (matches `notifyTitle`'s fallback), but
 * still shows a carried-forward issue or marks: a failed *branch* read must
 * not blank an issue number `rowsFor` already decided to keep.
 *
 * Carries no project identity of its own — a row from another project (D8:
 * the events log and live-status dir are both machine-global, so `rowsFor`
 * can surface one) is disambiguated by `render()`'s project grouping instead,
 * a header line rather than eating into this cell's already-tight width.
 */
function branchCell(r, width) {
  const issuePrefix = r.issue ? `[#${r.issue}] ` : '';
  const tokens = laneMarks(r);
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

/**
 * The service line beneath a lane's row, or `null` when nothing is running —
 * the line itself is conditional (unlike the old fixed second line), so
 * "should it show" and "what does it say" are one decision, not two: an
 * earlier version split them into `serviceCell`/`serviceRunning`, each
 * re-deriving `resolveServices`/`serviceStatus` independently, which read the
 * same pidfile twice per lane per paint and checked only `svcs[0]` for both —
 * a lane whose *second* declared service was the one running showed nothing
 * at all. This checks every declared service and shows whichever one is
 * actually up, still with a trailing count of the rest — there is no room for
 * a full list once the row is this narrow. A row with no `.name` is a
 * foreign project's or a vanished lane's (see rowsFor): it never carries the
 * live `.path`/`.lane` resolveServices needs, and `.name` never resolves
 * against any config but the current project's, so it is never passed in at
 * all.
 *
 * `serviceStatus` (`lib/services.mjs`'s `status`) deletes the pidfile of a
 * confirmed-dead process, so calling this — and therefore `render()` — is not
 * side-effect-free: every `lanes status` frame self-heals a stale pidfile.
 */
function serviceLine(ctx, r) {
  if (!r.name) return null;
  const svcs = resolveServices(ctx?.config, r);
  if (!svcs.length) return null;
  let running = null;
  let st = null;
  for (const s of svcs) {
    const status = serviceStatus(s);
    if (status.running) {
      running = s;
      st = status;
      break;
    }
  }
  if (!running) return null;
  // The bound port, not the freshly computed one — `portBase` can be edited
  // while the service stays up. The `!` marker applies to the URL too: a url
  // template is filled with the freshly computed port, which can just as
  // easily be stale.
  const { port, moved } = boundPort(running, st);
  const text = running.url ? `${running.url}${moved}` : `localhost:${port}${moved}`;
  return svcs.length > 1 ? `${text} (+${svcs.length - 1} more)` : text;
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
 *
 * `ctxInfo`, when supplied, is a `Map<transcriptPath, {tokens,model}|null>`
 * refreshed on the same ~20-tick cadence as `laneInfo` (see `watchStatus`) rather
 * than read fresh every second — a real transcript's trailing line can run
 * past the 256KB fast-path window, and the full-file fallback that follows
 * measures 7-12ms on real multi-MB files, not the sub-millisecond figure a
 * per-row-per-tick read assumed. `printStatus` has no tick loop to throttle
 * against, so it omits `ctxInfo` and reads fresh — a one-shot snapshot.
 */
function ctxCell(r, ctxInfo) {
  if (!r.transcript) return '—';
  const info = ctxInfo ? ctxInfo.get(r.transcript) ?? null : readContext(r.transcript);
  if (!info) return '—';
  return `${fmtTokens(info.tokens)}·${info.model.replace(/^claude-/, '')}`;
}

/**
 * Events that mean a Claude Code session is actually attached to the lane
 * right now. An allow-list, not "everything but session_end": several events
 * (lane_created, stage, reviewed, commit_*) come from the CLI or the commit
 * guard, not from session liveness hooks, and can land long after — or with
 * no session ever having existed. Failing closed (default: not live) only
 * over-dims a real value; the deny-list this replaces defaulted to "live",
 * which lies.
 */
const LIVE_EVENTS = new Set(['session_start', 'busy', 'idle', 'waiting', 'agent_start', 'agent_end']);

/**
 * Live status (busy/idle/waiting, from ~/.claude/sessions) is authoritative
 * over a folded `busy`/`idle`/nothing, but must never override one of these
 * richer, lanes-specific states — they come from the CLI or the commit
 * guard, not from session liveness, and carry information a session file
 * knows nothing about (which agent, which commit outcome, a review marker).
 *
 * `agent_end` is deliberately not in this set, unlike `agent_start`: its
 * render (STATES.agent_end) is byte-identical to `busy`, so overriding it
 * loses nothing, and protecting it left the interrupted-mid-subagent case —
 * no `Stop` ever fires, so the row would otherwise stay stuck exactly like
 * the bug #12 exists to fix.
 */
const PROTECTED_LIVE_OVERRIDE = new Set([
  'agent_start', 'reviewed', 'commit_blocked', 'commit_reviewed',
  'commit_bypass', 'lane_created', 'lane_removed', 'lane_reset',
]);

/**
 * States that also suppress #14's extra session rows, not just the primary
 * row's own live override. Each is a fact about the shared git tree or the
 * worktree's own lifecycle (a blocked/reviewed commit, the lane itself being
 * created/removed/reset) — true for every session in the lane alike, so a
 * second session's row would be misleading noise underneath them.
 * `agent_start` (in `PROTECTED_LIVE_OVERRIDE` above, deliberately NOT here)
 * is an action specific to *that* session, not a fact about the lane, so a
 * genuinely independent second session must still get its own row.
 *
 * Spelled out as its own literal, not derived from `PROTECTED_LIVE_OVERRIDE`
 * by subtraction: a future state added there is session-scoped far more
 * often than lane-wide (most of this file's own states are), so deriving
 * "suppress" as the default direction would silently hide a live session
 * the moment someone adds an unrelated protected state — the opposite of
 * what #14 exists to fix. Spelling it out instead makes "also suppress
 * extra rows" an opt-in edit made right here, next to the reasoning above.
 */
const LANE_WIDE_PROTECTED = new Set([
  'reviewed', 'commit_blocked', 'commit_reviewed',
  'commit_bypass', 'lane_created', 'lane_removed', 'lane_reset',
]);

/**
 * Whether a specific session's own folded history (`state.sessionHistory`,
 * #14 Phase 4) says it's currently in a lane-wide-fact state. Shared by
 * `render()`'s extra rows and `liveTransitionNotifications`' per-session
 * gating (#14 Phase 5) — both need the exact same rule, and a second inline
 * copy is what lets the two drift the next time a state is added to
 * `LANE_WIDE_PROTECTED`.
 */
function isSessionProtected(sessionHistory, sessionId) {
  const hist = sessionHistory.get(sessionId);
  return Boolean(hist && LANE_WIDE_PROTECTED.has(hist.ev));
}

/**
 * Prefix match, same idiom as lib/worktrees.mjs's own cwd->lane lookup.
 * Returns every live session whose `cwd` resolves under the lane path (root
 * itself, or a subdirectory launch), ordered deterministically instead of by
 * whatever order `readdirSync` happened to return them in (#14): an
 * exact path match beats a merely-prefix one regardless of when either
 * started, then ascending `startedAt` — oldest wins, not newest — so two
 * entries tied on everything else still resolve the same way on every call.
 * `[0]` is today's single override target; the rest exist for #14's
 * extra-row rendering.
 *
 * Ascending, not descending: under D20 a lane is one long-lived branch, so
 * its longest-running session is the one the row represents (missing/invalid
 * `startedAt` sorts last via `Infinity` — an unknown start time is worse
 * information than a real one, never better, so it can't win a tiebreak by
 * default). A second, newer session in the same lane gets its own row in
 * #14's later phases rather than displacing the primary one — descending
 * order would make the row's identity jump every time a throwaway session is
 * opened in the lane, reintroducing the instability this ordering exists to
 * remove. `sessionId` is the final string-compare tiebreak, guaranteed
 * present by D36.
 */
function findLiveStatuses(liveStatuses, lanePath) {
  if (!lanePath) return [];
  return liveStatuses
    .filter((s) => s.cwd === lanePath || s.cwd.startsWith(`${lanePath}/`))
    .sort((a, b) => {
      const aExact = a.cwd === lanePath ? 0 : 1;
      const bExact = b.cwd === lanePath ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aStarted = Number.isFinite(a.startedAt) ? a.startedAt : Infinity;
      const bStarted = Number.isFinite(b.startedAt) ? b.startedAt : Infinity;
      if (aStarted !== bStarted) return aStarted - bStarted;
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    });
}

/** `rows` with each row's `ev`/`since`/`waitingFor` replaced by its primary live status, per the rule above. */
function withLiveOverride(rows, liveStatuses) {
  return rows.map((r) => {
    if (PROTECTED_LIVE_OVERRIDE.has(r.ev)) return r;
    const live = findLiveStatuses(liveStatuses, r.path)[0];
    if (!live) return r;
    return { ...r, ev: live.status, since: live.statusUpdatedAt ?? r.since, waitingFor: live.waitingFor };
  });
}

/**
 * Compares this tick's live status per SESSION — not just per lane — against
 * the previous tick's (`prevLiveEv`, mutated in place — transient watch-loop
 * state, never folded into `state` itself) and returns the notifications a
 * transition earns (#14 Phase 5: every live match under a row's path, not
 * only the primary `[0]`). Baseline key is `` `${laneKey}#${sessionId}` ``,
 * not just `laneKey`, so two sessions in one lane track independent
 * baselines and a transition on one is never compared against the other's
 * last value. Skips a session already covered by a raw-event notification
 * this tick (`notifiedKeys`, keyed to match by `watchStatus`) so a normal
 * `Stop` — which already notifies off the raw event — never double-fires
 * just because the live file updated in the same tick.
 *
 * Gating: the primary session uses the same `r.ev`/`PROTECTED_LIVE_OVERRIDE`
 * rule as before #14 (row `[0]`'s protection is unchanged, per Phase 4); an
 * extra session uses its own history via `isSessionProtected`, same as
 * `render()`'s rows. A protected or no-longer-live session's baseline is
 * dropped rather than kept stale, in one pass at the end (comparing every
 * tracked key against the ones just proven valid this tick) — so a later
 * reattachment, or the protection lifting, starts clean instead of firing a
 * comparison against old data, and `prevLiveEv` never grows unbounded.
 *
 * Callers must pass the COMPLETE row set: the final pass treats any tracked
 * key not re-validated this call as gone, so a filtered `rows` would
 * silently drop the omitted lanes' baselines. The one caller (`watchStatus`)
 * always passes `rowsFor(...)` whole.
 */
export function liveTransitionNotifications(rows, liveStatuses, sessionHistory, prevLiveEv, notifiedKeys) {
  const out = [];
  const validKeys = new Set();
  for (const r of rows) {
    const laneKey = `${r.project || '?'}#${r.worktree ?? '?'}`;
    findLiveStatuses(liveStatuses, r.path).forEach((live, idx) => {
      const isPrimary = idx === 0;
      const protectedNow = isPrimary ? PROTECTED_LIVE_OVERRIDE.has(r.ev) : isSessionProtected(sessionHistory, live.sessionId);
      if (protectedNow) return;
      const key = `${laneKey}#${live.sessionId}`;
      // A duplicate sessionId under one lane (two live files somehow sharing
      // an id) must not fight over one baseline — each would see the
      // other's write as a "transition" every tick, notifying forever.
      if (validKeys.has(key)) return;
      validKeys.add(key);
      const seenBefore = prevLiveEv.has(key);
      const changed = seenBefore && prevLiveEv.get(key) !== live.status;
      prevLiveEv.set(key, live.status);
      if (changed && !notifiedKeys.has(key)) {
        const body = NOTIFY[live.status]?.({ ...r, waitingFor: live.waitingFor });
        if (body) {
          const title = isPrimary ? notifyTitle(r) : `${notifyTitle(r)} · ${live.name || live.sessionId}`;
          out.push({ title, body });
        }
      }
    });
  }
  for (const key of prevLiveEv.keys()) {
    if (!validKeys.has(key)) prevLiveEv.delete(key);
  }
  return out;
}

const LANE_WIDTH = 3;
// Fits every STATES label and every agent name this repo's own agents produce
// in full (longest: "spec-challenger running" at 25 with its icon). Two
// STATES labels (commit_blocked, reviewed) were shortened to fit this rather
// than widening it — see their wording above.
const STATE_WIDTH = 26;
// Hours-only overflowed this at 1000h (~42 days idle — ordinary under D20); d/h
// holds the same 7 chars out to "999d23h". 7 is load-bearing: render()'s
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
 * copies — the same failure mode `serviceLine`'s own docstring above
 * documents having already been paid for once, when its two halves were
 * independently re-derived and disagreed.
 *
 * `labelInput` is whatever `STATES[ev].label` expects: the whole row `r` for
 * the primary row (`agent_start`'s `e.agent`, `stage`'s `e.stage`, …), or
 * just `{ waitingFor }` for an extra row, which only ever carries a live
 * busy/idle/waiting status and has no `agent`/`stage` of its own.
 */
function stateAndForCells(ev, labelInput, since, now) {
  const s = stateOf(ev);
  return [
    s.color + pad(`${s.icon} ${s.label(labelInput)}`, STATE_WIDTH) + C.reset,
    (ev === 'idle' || ev === 'waiting' ? C.yellow : C.dim) + pad(since ? fmtElapsed(now - since) : '—', FOR_WIDTH) + C.reset,
  ];
}

/** Build the frame as a string. Callers decide whether to clear the screen. */
export function render(ctx, state, now = Date.now(), laneInfo = enumerateLanes(ctx?.config), ctxInfo = null, liveStatuses = readLiveStatuses()) {
  const rows = withLiveOverride(rowsFor(ctx, state.lanes, laneInfo), liveStatuses);
  const colorFor = laneColorFor();
  const width = Math.max(60, process.stdout.columns || 100);
  const out = [];

  // Capped at 100 even on a wider terminal, deliberately — the frame stays a
  // consistent, compact shape rather than stretching back out to show more of
  // the branch name the way it used to. Still adaptive downward: on anything
  // narrower it shrinks with `width`, same as before.
  const termWidth = Math.min(width, 100);
  const showCtx = termWidth >= CTX_MIN_TERM_WIDTH;
  // 4 single-space gaps between 5 cells (LANE BRANCH STATE FOR CTX), or 3
  // between 4 when CTX is dropped — BRANCH is the only cell excluded, since
  // it is the free variable the rest of this reservation solves for.
  const reserved = LANE_WIDTH + STATE_WIDTH + FOR_WIDTH + (showCtx ? CTX_WIDTH + 4 : 3);
  const branchWidth = Math.max(BRANCH_FLOOR, termWidth - reserved);

  const title = `agent-system${ctx?.project ? ` · ${ctx.project}` : ''}`;
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

  if (rows.length === 0) {
    out.push(`${C.dim}  No lanes yet. Start a Claude Code session in a configured worktree.${C.reset}`);
  }

  // Grouped by project: `rows` can mix in lanes from other projects (D8 —
  // the events log and live-status dir are both machine-global), and rather
  // than tagging every such row individually within the tight BRANCH budget,
  // a dim header names each group instead — `ctx`'s own project included, so
  // it reads the same way RECENT's per-line tag does: every row's project is
  // stated, not just the ones that would otherwise be ambiguous.
  const rawGroups = new Map();
  for (const r of rows) {
    const key = r.project || ctx?.project || '?';
    if (!rawGroups.has(key)) rawGroups.set(key, []);
    rawGroups.get(key).push(r);
  }
  // `ctx`'s own group is hoisted to the front rather than trusted to land
  // there by insertion order: `rowsFor`'s first loop (over `laneInfo`, always
  // `ctx.project`) only runs when a declared `lane<N>` worktree exists — with
  // none yet (before the first `lanes new`) or `ctx` unresolved (an
  // unadopted directory), every row comes from its second loop instead,
  // ordered by first-event-arrival across every project on the machine, and
  // a foreign group could insert before this one. A user's own project
  // reading first is the point of the header at all; this makes it true
  // regardless of lane state instead of merely whenever it already happened
  // to be.
  const ownKey = ctx?.project;
  const groups = ownKey && rawGroups.has(ownKey)
    ? new Map([[ownKey, rawGroups.get(ownKey)], ...[...rawGroups].filter(([k]) => k !== ownKey)])
    : rawGroups;

  // Blank between lanes, not after every one: keeps the visual grouping this
  // loop exists for, and is what binds an optional service line to the row
  // above it now that most lanes are back down to a single row. Leaves the
  // trailing `out.push('')` below as the single, unconditional separator
  // before RECENT, in both the populated and empty-lanes cases. A new
  // project group gets the same blank-line separator before it, with its
  // header line taking the place of the group's first row for that purpose.
  let firstBlock = true;
  for (const [project, groupRows] of groups) {
    if (!firstBlock) out.push('');
    out.push(`${C.dim}${project}${C.reset}`);
    firstBlock = false;

    groupRows.forEach((r, i) => {
      if (i > 0) out.push('');
      const live = LIVE_EVENTS.has(r.ev);
      const laneColor = colorFor(r.lane);
      const [stateCell, forCell] = stateAndForCells(r.ev, r, r.since, now);
      // Every live session under this lane's path, computed once and reused
      // below for both the primary row's CTX (`[0]`) and the extra rows
      // (`.slice(1)`), rather than calling `findLiveStatuses` twice per lane.
      const laneLive = findLiveStatuses(liveStatuses, r.path);
      const primaryHist = laneLive[0] && state.sessionHistory.get(laneLive[0].sessionId);
      const cells = [
        laneColor + pad(r.lane ?? '·', LANE_WIDTH) + C.reset,
        branchCell(r, branchWidth),
        stateCell,
        forCell,
      ];
      if (showCtx) {
        // Resolve CTX through the primary session's own history when known
        // (#14 Phase 4), not `r.transcript` alone: `state.lanes`' transcript
        // is last-write-wins across EVERY session in the worktree, not scoped
        // by session, so with two live sessions sharing a lane it can silently
        // hold the wrong one's transcript — invisible before extra rows
        // existed to show the correct value right underneath it. Falls back to
        // `r.transcript` when the primary session has no history of its own
        // (no live match, or one that hasn't emitted a transcript-bearing
        // event yet), so a single-session lane renders byte-identical to
        // before this phase.
        const ctxSource = primaryHist?.transcript ? primaryHist : r;
        cells.push((live ? '' : C.dim) + pad(ctxCell(ctxSource, ctxInfo), CTX_WIDTH) + C.reset);
      }
      out.push(cells.join(' '));

      // Extra rows: one per additional live session sharing this lane's path,
      // beyond the primary `[0]` match `withLiveOverride` already folded into
      // `r` above (#14). Directly beneath — no blank line, and before the
      // service line below, so a lane's session rows stay adjacent to its own
      // row; the service line (one dev-server URL per lane, not per session)
      // reads as the whole block's footer instead of splitting two session
      // rows apart. The blank line pushed at the top of this callback still
      // only separates one lane's whole block from the next.
      //
      // Gating is per-session (#14 Phase 4), not per row `[0]` like Phase 3's
      // placeholder was: a session's own history — not the primary session's —
      // decides whether ITS row is a lane-wide fact in disguise. A commit
      // blocked by session A tags that event with A's own session id (#13), so
      // it never touches B's fold here and B's row stays visible; if B itself
      // is mid-commit-block, B's own history says so and B's row is the one
      // that hides. Falls open (shows the row) when this session has no
      // history yet — absence of evidence is not evidence of a lane-wide state.
      for (const extraLive of laneLive.slice(1)) {
        if (isSessionProtected(state.sessionHistory, extraLive.sessionId)) continue;
        const sessionHist = state.sessionHistory.get(extraLive.sessionId);
        const [extraStateCell, extraForCell] = stateAndForCells(
          extraLive.status, { waitingFor: extraLive.waitingFor }, extraLive.statusUpdatedAt, now,
        );
        const extraCells = [
          C.dim + pad('·', LANE_WIDTH) + C.reset,
          C.dim + pad(extraLive.name || extraLive.sessionId, branchWidth) + C.reset,
          extraStateCell,
          extraForCell,
        ];
        // Always live-toned, never dimmed: unlike row `[0]`, an extra row only
        // ever exists for a session `readLiveStatuses()` just confirmed is live.
        if (showCtx) extraCells.push(pad(ctxCell({ transcript: sessionHist?.transcript }, ctxInfo), CTX_WIDTH));
        out.push(extraCells.join(' '));
      }

      const svcLine = serviceLine(ctx, r);
      if (svcLine) {
        out.push(`${' '.repeat(LANE_WIDTH + 1)}${C.dim}${svcLine}${C.reset}`);
      }
    });
  }

  out.push('');
  out.push(`${C.bold}RECENT${C.reset}`);
  if (state.history.length === 0) out.push(`${C.dim}  (nothing yet)${C.reset}`);
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
  // with no state change the user caused, exactly what D29/D37 already rule
  // against elsewhere in this file. RECENT lines carry no fixed-width cap
  // (`detail` alone runs to 300 chars), so the always-on column costs
  // nothing the frame was protecting.
  for (const e of state.history.slice().reverse()) {
    const s = stateOf(e.ev);
    // Fall back to worktree name when there is no lane number — same fallback
    // as `branchCell`'s ghost-row case and `notifyTitle`, so a row is never
    // reduced to the bare `·` placeholder with nothing to identify it by.
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
    const whoColor = e.lane != null ? colorFor(e.lane) : C.dim;
    const projectTag = `${C.dim}${pad(projectText, 12)} ${C.reset}`;
    out.push(
      `${C.dim}${fmtClock(e.ts)}${C.reset}  ${projectTag}${whoColor}${pad(who, 13)}${C.reset}${s.color}${s.icon} ${pad(s.label(e), 30)}${C.reset}${C.dim}${e.detail || ''}${C.reset}`,
    );
  }
  return out.join('\n');
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
  // A real transcript's tail can miss the 256KB fast-path window and fall
  // back to a full-file read+parse — measured at 7-12ms on real multi-MB
  // files, not the sub-millisecond cost a per-row-per-second read assumed.
  // Throttled on the same 20-tick cadence as laneInfo rather than read fresh
  // every paint; only the transcript paths currently on screen are read.
  let ctxInfo = new Map();
  // Per-session live status from the previous tick, keyed
  // `${project}#${worktree}#${sessionId}` (#14 Phase 5), so a transition
  // (not just a value) can be detected per session, not just per lane —
  // transient watch-loop state, never folded into `state` itself. See
  // liveTransitionNotifications.
  const prevLiveEv = new Map();

  const paint = () => {
    try {
      const fresh = tail.read();
      // Keyed per session (#14 Phase 5), matching liveTransitionNotifications'
      // own `${laneKey}#${sessionId}` baseline key — `session ?? 'primary'`
      // falls back to the literal string only for an event with no session
      // tag at all (pre-#13 or a source that never sends one); every event
      // #13 itself emits already carries a real id, which is what actually
      // dedupes against the live-session check below for the common case.
      const notifiedKeys = new Set();
      for (const e of fresh) {
        const body = NOTIFY[e.ev]?.(e);
        if (body) {
          notify(notifyTitle(e), body);
          notifiedKeys.add(`${e.project || '?'}#${e.worktree ?? '?'}#${e.session ?? 'primary'}`);
        }
      }
      applyEvents(state, fresh);
      tick += 1;
      // Read here, ABOVE the throttle block below, not after it as before
      // #14 Phase 4 — the sessionHistory prune inside that block now needs
      // it. Moving this back down under the block is a TDZ `ReferenceError`
      // that `paint()`'s own `catch {}` swallows silently, freezing the
      // dashboard on its last frame with no error printed anywhere.
      // Otherwise unchanged: read once per tick, unthrottled (unlike
      // laneInfo/ctxInfo below) — a handful of small local JSON files, cheap
      // even every second — shared between the notification check, render(),
      // and the throttled block, so everything agrees on one snapshot.
      const liveStatuses = readLiveStatuses();
      if (tick % 20 === 0) {
        laneInfo = enumerateLanes(ctx.config);
        const next = new Map();
        for (const { transcript } of state.lanes.values()) {
          if (transcript && !next.has(transcript)) next.set(transcript, readContext(transcript));
        }
        // "On screen" here means every live session matching ANY lane's
        // path, primary (`[0]`) included, not just #14's extra rows: the
        // primary row's own CTX can also resolve through a session's history
        // now (see render()'s `primaryHist`). Scoped this way rather than to
        // every live session `readLiveStatuses()` returns, which is global —
        // see `pruneSessionHistory`'s own docstring for why.
        const onScreenSessionIds = new Set(
          rowsFor(ctx, state.lanes, laneInfo).flatMap((r) => findLiveStatuses(liveStatuses, r.path)).map((s) => s.sessionId),
        );
        pruneSessionHistory(state, onScreenSessionIds);
        for (const { transcript } of state.sessionHistory.values()) {
          if (transcript && !next.has(transcript)) next.set(transcript, readContext(transcript));
        }
        ctxInfo = next;
      }
      for (const { title, body } of liveTransitionNotifications(rowsFor(ctx, state.lanes, laneInfo), liveStatuses, state.sessionHistory, prevLiveEv, notifiedKeys)) {
        notify(title, body);
      }
      // Full redraw: cheap at this size, and it avoids every partial-update
      // artefact that incremental cursor movement would introduce.
      process.stdout.write(
        `\x1b[2J\x1b[H${render(ctx, state, Date.now(), laneInfo, ctxInfo, liveStatuses)}\n${C.dim}ctrl-c to quit${C.reset}\n`,
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
