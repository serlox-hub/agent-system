import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';

const HISTORY_LIMIT = 12;

/** Incremental reader: keeps a byte offset so we only parse what is new. */
export class EventTail {
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
 * `createLaneSource`) doing real per-tick work for sessions `render()` never
 * looks at. `session_end` is not reliably observed (#12's own
 * investigation), so this is the only eviction path `sessionHistory` has.
 */
export function pruneSessionHistory(state, onScreenSessionIds) {
  for (const sessionId of state.sessionHistory.keys()) {
    if (!onScreenSessionIds.has(sessionId)) state.sessionHistory.delete(sessionId);
  }
}
