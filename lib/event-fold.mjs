/**
 * The event log, read and folded: `EventTail` turns the shared JSONL log (D8)
 * into event objects, `applyEvents` folds them into per-lane and per-session
 * state. Nothing here reads git, live statuses or transcripts —
 * lib/lane-model.mjs joins those in.
 *
 * Both halves run inside `lanes status`'s watch loop, which is meant to stay
 * up for weeks:
 *   - Never crash, never lose an event. A line that is not an event is
 *     skipped and a nested field dropped, a torn last line waits for the rest
 *     of it, a rotated log is drained before the new one is followed, and a
 *     failing read costs one frame: the next read starts from the same byte.
 *   - Bounded memory. The fold is incremental — its cost follows what
 *     arrived, not how long the log is. `history` is capped at HISTORY_LIMIT,
 *     `lanes` holds one entry per worktree seen (`lane_removed` deletes its
 *     own), and `sessionHistory` shrinks only through `pruneSessionHistory`.
 *     State added here needs a bound of its own, or it grows for as long as
 *     the loop runs.
 */

import { statSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { stripControlBytes } from './live-status.mjs';

const HISTORY_LIMIT = 12;

// One read buffer for every tail: reads are synchronous, so none can overlap.
const SCRATCH = Buffer.allocUnsafe(64 * 1024);
const NO_BYTES = Buffer.alloc(0);

// Control/ANSI bytes are stripped where log lines become strings — every
// reader goes through `EventTail` — not in `emit()` (lib/context.mjs): the
// dashboard replays logs written by older builds, which a write-side strip
// never reaches. Paths stay raw, like live-status's `cwd`: they are matched
// against the filesystem, never printed.
const PATH_KEYS = new Set(['path', 'transcript']);

function stripEventStrings(key, value) {
  return typeof value === 'string' && !PATH_KEYS.has(key) ? stripControlBytes(value) : value;
}

/**
 * Incremental reader, `tail -F`-style: keeps the log open with a byte offset
 * into it, so each read parses only what is new.
 *
 * Rotation — `emit()`'s `renameSync` to `events.jsonl.1` (lib/context.mjs) —
 * is detected by inode, not by size: once the path names a different file,
 * the open one is read to EOF before the new one is opened at offset 0, so an
 * event appended just before a rotation is still news. While the path names no
 * file at all — between that rename and the append that recreates it, or a
 * log moved away and back — the open one is still followed, so a file that
 * comes back is never replayed from byte 0. Nothing here knows the `.1` name.
 * One window stays open: `emit()` appends by path, so a writer that resolved
 * the path just before the rename can land in the old file after its last
 * drain — microseconds, once per 2 MiB.
 *
 * Every event a read returns is a flat object with a string `ev`: see
 * `#drain` for why a line that is valid JSON can still not be one.
 */
export class EventTail {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.offset = 0;
    this.partial = NO_BYTES;
  }

  read() {
    const out = [];
    try {
      let ino = null;
      try { ino = statSync(this.file).ino; } catch { /* no file yet, or rotated away with no successor yet — keep draining the open one */ }
      if (this.fd !== null && ino !== null && fstatSync(this.fd).ino !== ino) {
        this.#drain(out);
        const fd = this.fd;
        this.fd = null;
        closeSync(fd);
      }
      if (this.fd === null) {
        if (ino === null) return out;
        this.fd = openSync(this.file, 'r');
        // A fresh file starts fresh: an unterminated line left at the end of a
        // rotated one is never completed, and glued onto this file's first line
        // it would take that line down with it.
        this.offset = 0;
        this.partial = NO_BYTES;
      } else if (fstatSync(this.fd).size < this.offset) {
        // Truncated in place: same file, but the offset points past its end.
        this.offset = 0;
        this.partial = NO_BYTES;
      }
      this.#drain(out);
    } catch { /* the offset only moves past bytes already consumed, so the next read retries */ }
    return out;
  }

  /**
   * Reads the open file from `offset` to EOF, however many reads that takes —
   * `readSync` may return fewer bytes than asked for, and only those count.
   * The offset and the unterminated tail are committed only once every read
   * succeeded, so a throw re-reads the same bytes next time. Lines are split
   * on the `\n` byte before decoding, so a read ending inside a multi-byte
   * character never corrupts it.
   */
  #drain(out) {
    const chunks = [this.partial];
    let pos = this.offset;
    for (;;) {
      const n = readSync(this.fd, SCRATCH, 0, SCRATCH.length, pos);
      if (n === 0) break;
      chunks.push(Buffer.from(SCRATCH.subarray(0, n)));
      pos += n;
    }
    if (pos === this.offset) return;
    const data = Buffer.concat(chunks);
    const end = data.lastIndexOf(0x0a) + 1;
    this.offset = pos;
    this.partial = Buffer.from(data.subarray(end));
    for (const line of data.toString('utf8', 0, end).split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line, stripEventStrings);
      } catch {
        continue; // a malformed line
      }
      // Every consumer reads `e.ev` and turns fields into strings — a template
      // literal, `Object.hasOwn` — and both throw on `null` or on a JSON object
      // such as `{"toString":null}`. No emitter writes a nested value, so one
      // is dropped rather than the event carrying it.
      if (e === null || typeof e !== 'object' || typeof e.ev !== 'string') continue;
      for (const key of Object.keys(e)) {
        if (e[key] !== null && typeof e[key] === 'object') delete e[key];
      }
      out.push(e);
    }
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
 * the whole point of those two events (`renderSnapshot`'s STATE cell, in
 * ui/dashboard.mjs, shows "lane reset"), and `lane_removed` deletes the row
 * outright rather than reaching this function at all.
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
        // No view renders it (#9 dropped the STAGE column, and RECENT reads a
        // stage event's own `e.stage` off the raw log), but it is not dead:
        // `snapshotLane` (lib/lane-model.mjs) publishes it as `Lane.stage` to
        // every view. Delete it and `Lane.stage` is silently always null — no
        // golden frame catches that, since nothing renders it (D30).
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
 * in place. `readLiveStatuses()` (lib/live-status.mjs) is global — every
 * Claude Code session on the machine, any project, any window — so retaining
 * every live session's history would keep the throttled `readContext()`
 * (lib/transcript.mjs) walk that builds `ctxInfo` (`createLaneSource`,
 * lib/lane-model.mjs) doing real work for sessions no snapshot shows. `session_end` is not reliably observed
 * (#12's own investigation), so this is the only eviction path
 * `sessionHistory` has.
 */
export function pruneSessionHistory(state, onScreenSessionIds) {
  for (const sessionId of state.sessionHistory.keys()) {
    if (!onScreenSessionIds.has(sessionId)) state.sessionHistory.delete(sessionId);
  }
}
