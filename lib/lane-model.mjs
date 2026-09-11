import { existsSync } from 'node:fs';
import { EVENTS_FILE, issueFromBranch } from './context.mjs';
import { laneHexFor } from './colors.mjs';
import { EventTail, createState, applyEvents, pruneSessionHistory } from './event-fold.mjs';
import { enumerateLanes, laneMarks } from './worktrees.mjs';
import { resolveServices, status as serviceStatus, boundPort } from './services.mjs';
import { readContext } from './transcript.mjs';
import { readLiveStatuses } from './live-status.mjs';

// `waitingFor` reaches the model from two places: live-status files and raw
// log events, for RECENT and raw-event notifications (no emitter in this repo
// writes one). Each strips control/ANSI bytes at its own trust boundary
// (lib/live-status.mjs, `EventTail` in lib/event-fold.mjs), so this only
// bounds the length. Applied once, on the model side, to every `waitingFor` a
// snapshot carries and to every notification body; no view re-bounds it.
const WAITING_FOR_MAX = 200;

function sanitize(s) {
  if (typeof s !== 'string') return '';
  return s.length > WAITING_FOR_MAX ? `${s.slice(0, WAITING_FOR_MAX - 1)}…` : s;
}

/**
 * Events worth a desktop notification when they arrive live. Looked up with
 * `Object.hasOwn`, never a bare `NOTIFY[ev]?.()`, for the reason `stateOf`
 * gives: `__proto__` resolves to a non-callable and throws, and inherited
 * methods such as `constructor` and `toString` are callable and return a
 * truthy value that is sent as a notification reading `[object Object]`.
 */
const NOTIFY = {
  idle: () => 'Waiting for you',
  waiting: (e) => (e.waitingFor ? `Needs your input: ${sanitize(e.waitingFor)}` : 'Needs your input'),
  commit_blocked: () => 'Commit blocked — needs review',
  agent_end: (e) => `${e.agent || 'Agent'} finished`,
};

/**
 * Every lane/row falls back to worktree when there is no lane (applyEvents'
 * key in lib/event-fold.mjs, renderSnapshot's `·` placeholder) — worktree is
 * the one identifier that always exists, since resolveLane always sets it from
 * the directory basename even when lane is null (lib/context.mjs:86-99). The
 * notification title follows the same fallback so it is never unidentifiable.
 */
export function notifyTitle(e) {
  return `${e.project || 'lanes'}${e.lane ? ` · lane ${e.lane}` : e.worktree ? ` · ${e.worktree}` : ''}${e.issue ? ` · #${e.issue}` : ''}`;
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

/**
 * A lane's first running declared service, or `null` when nothing is running
 * — the service line beneath the row is conditional, so "should it show" and
 * "what does it say" are one decision, not two: an earlier version split them
 * into `serviceCell`/`serviceRunning`, each re-deriving
 * `resolveServices`/`serviceStatus` independently, which read the same
 * pidfile twice per lane per paint and checked only `svcs[0]` for both — a
 * lane whose *second* declared service was the one running showed nothing at
 * all. This checks every declared service and returns whichever one is
 * actually up, with a count of the rest (`others`) — there is no room for a
 * full list once the row is this narrow. A row with no `.name` is a foreign
 * project's or a vanished lane's (see rowsFor): it never carries the live
 * `.path`/`.lane` resolveServices needs, and `.name` never resolves against
 * any config but the current project's, so it is never passed in at all.
 *
 * `port` is the bound port, not the freshly computed one — `portBase` can be
 * edited while the service stays up — and `moved` flags the two disagreeing.
 * It applies to `url` too: a url template is filled with the freshly computed
 * port, which can just as easily be stale.
 *
 * `serviceStatus` (`lib/services.mjs`'s `status`) deletes the pidfile of a
 * confirmed-dead process, so calling this — and therefore `buildSnapshot()` —
 * is not side-effect-free: every `lanes status` frame self-heals a stale
 * pidfile.
 */
function serviceFor(ctx, r) {
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
  const { port, moved } = boundPort(running, st);
  return { url: running.url, port, moved: Boolean(moved), others: svcs.length - 1 };
}

/**
 * `{ tokens, model }` for a transcript, or `null`.
 *
 * `ctxInfo`, when supplied, is a `Map<transcriptPath, {tokens,model}|null>`
 * refreshed on the same ~20-tick cadence as `laneInfo` (see
 * `createLaneSource`) rather than read fresh every second — a real
 * transcript's trailing line can run
 * past the 256KB fast-path window, and the full-file fallback that follows
 * measures 7-12ms on real multi-MB files, not the sub-millisecond figure a
 * per-row-per-tick read assumed. `printStatus` has no tick loop to throttle
 * against, so it omits `ctxInfo` and reads fresh — a one-shot snapshot.
 *
 * Resolved whatever the view's width: `buildSnapshot` cannot know it, so
 * `lanes status --once` below 85 columns reads transcripts for a CTX column it
 * then drops — accepted in #19, one-shot only, since the watch loop always
 * supplies `ctxInfo`.
 */
function contextFor(transcript, ctxInfo) {
  if (!transcript) return null;
  const info = ctxInfo ? ctxInfo.get(transcript) ?? null : readContext(transcript);
  return info ? { tokens: info.tokens, model: info.model } : null;
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
 * `snapshotLane`'s `extraSessions` filter and `liveTransitionNotifications`'
 * per-session gating (#14 Phase 5) — both need the exact same rule, and a
 * second inline copy is what lets the two drift the next time a state is
 * added to `LANE_WIDE_PROTECTED`.
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
 * this tick (`notifiedKeys`, keyed to match by `createLaneSource`'s
 * `advance()`) so a normal `Stop` — which already notifies off the raw event
 * — never double-fires just because the live file updated in the same tick.
 *
 * Gating: the primary session uses the same `r.ev`/`PROTECTED_LIVE_OVERRIDE`
 * rule as before #14 (row `[0]`'s protection is unchanged, per Phase 4); an
 * extra session uses its own history via `isSessionProtected`, same as
 * `snapshotLane`'s `extraSessions`. A protected or no-longer-live session's
 * baseline is dropped rather than kept stale, in one pass at the end
 * (comparing every tracked key against the ones just proven valid this
 * tick) — so a later reattachment, or the protection lifting, starts clean
 * instead of firing a comparison against old data, and `prevLiveEv` never
 * grows unbounded.
 *
 * Callers must pass the COMPLETE row set: the final pass treats any tracked
 * key not re-validated this call as gone, so a filtered `rows` would
 * silently drop the omitted lanes' baselines. The one caller
 * (`createLaneSource`'s `advance()`) always passes `rowsFor(...)` whole.
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
        const body = Object.hasOwn(NOTIFY, live.status) ? NOTIFY[live.status]({ ...r, waitingFor: live.waitingFor }) : null;
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

/**
 * Everything `lanes status` shows, decided as data: one plain-JSON object
 * carrying every rule about *what* is true — the live override, D37's session
 * order, D38's CTX source, D40's extra-row gating, own-project-first grouping,
 * the running service — and nothing about how it looks. `renderSnapshot` is
 * the terminal's view of it; another view reads the same object instead of
 * re-deriving these rules, which is how two copies of them would drift.
 *
 * Not side-effect-free: reads git (the default `laneInfo`), the live-status
 * files (the default `liveStatuses`), each on-screen transcript when `ctxInfo`
 * is null (see `contextFor`), the colours file, and every declared service's
 * pidfile — deleting a confirmed-dead one (see `serviceFor`).
 */
export function buildSnapshot(ctx, state, {
  now = Date.now(),
  laneInfo = enumerateLanes(ctx?.config),
  ctxInfo = null,
  liveStatuses = readLiveStatuses(),
} = {}) {
  const rows = withLiveOverride(rowsFor(ctx, state.lanes, laneInfo), liveStatuses);
  const hexFor = laneHexFor();

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

  const shared = { ctx, state, hexFor, ctxInfo, liveStatuses };
  return {
    now,
    project: ctx?.project ?? null,
    groups: [...groups].map(([project, groupRows]) => ({
      project,
      lanes: groupRows.map((r) => snapshotLane(r, shared)),
    })),
    history: state.history.map((e) => ({
      ts: e.ts,
      project: e.project ?? null,
      lane: e.lane ?? null,
      worktree: e.worktree ?? null,
      ev: e.ev,
      detail: e.detail ?? null,
      agent: e.agent ?? null,
      stage: e.stage ?? null,
      waitingFor: sanitize(e.waitingFor) || null,
      color: hexFor(e.lane),
    })),
  };
}

/** One `rowsFor` row, after the live override, as a snapshot lane — see `buildSnapshot`. */
function snapshotLane(r, { ctx, state, hexFor, ctxInfo, liveStatuses }) {
  // Every live session under this lane's path, computed once and reused
  // below for both the primary row's CTX (`[0]`) and the extra sessions
  // (`.slice(1)`), rather than calling `findLiveStatuses` twice per lane.
  const laneLive = findLiveStatuses(liveStatuses, r.path);
  const primaryHist = laneLive[0] && state.sessionHistory.get(laneLive[0].sessionId);
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
  return {
    lane: r.lane ?? null,
    worktree: r.worktree ?? null,
    branch: r.branch ?? null,
    issue: r.issue ?? null,
    color: hexFor(r.lane),
    marks: laneMarks(r),
    ev: r.ev ?? null,
    since: r.since ?? null,
    agent: r.agent ?? null,
    stage: r.stage ?? null,
    waitingFor: sanitize(r.waitingFor) || null,
    live: LIVE_EVENTS.has(r.ev),
    context: contextFor(ctxSource.transcript, ctxInfo),
    // One per additional live session sharing this lane's path, beyond the
    // primary `[0]` match `withLiveOverride` already folded into `r` (#14).
    //
    // Gating is per-session (#14 Phase 4), not per row `[0]` like Phase 3's
    // placeholder was: a session's own history — not the primary session's —
    // decides whether ITS row is a lane-wide fact in disguise. A commit
    // blocked by session A tags that event with A's own session id (#13), so
    // it never touches B's fold here and B's row stays visible; if B itself
    // is mid-commit-block, B's own history says so and B's row is the one
    // that hides. Falls open (shows the row) when this session has no
    // history yet — absence of evidence is not evidence of a lane-wide state.
    extraSessions: laneLive.slice(1)
      .filter((s) => !isSessionProtected(state.sessionHistory, s.sessionId))
      .map((s) => ({
        sessionId: s.sessionId,
        name: s.name ?? null,
        status: s.status,
        waitingFor: sanitize(s.waitingFor) || null,
        since: s.statusUpdatedAt ?? null,
        context: contextFor(state.sessionHistory.get(s.sessionId)?.transcript, ctxInfo),
      })),
    service: serviceFor(ctx, r),
  };
}

/**
 * The watch loop's refresh cycle with no terminal in it. `advance()` is one
 * tick, in the order that matters: tail the log, hand each new event's
 * notification to `onNotify` *before* the fold — so a throw anywhere later
 * in the tick never loses a notification whose event was already consumed —
 * fold, read live statuses, run the 20-tick refresh, then hand over the live
 * transitions. One owner calls `advance()` at its cadence (the throttle
 * counts calls, not seconds); any number of consumers call `snapshot()`,
 * which reuses the last `advance()`'s reads — a second view in the same
 * process costs no git, no transcript read and no duplicate notification.
 *
 * Construction replays the existing log into state without notifying: only
 * events that arrive after it are news.
 */
export function createLaneSource(ctx, { onNotify = () => {} } = {}) {
  const tail = new EventTail(EVENTS_FILE);
  const state = createState();

  // Replay history for state, but never notify for it — only live events.
  applyEvents(state, tail.read());

  // Git-derived per-lane data costs a subprocess set per lane, so it is
  // refreshed only every 20 `advance()` calls (~20s at `watchStatus`'s 1 Hz
  // cadence) rather than on every one — including which worktrees exist, so
  // a lane created or removed elsewhere can take up to ~20s to
  // appear/disappear here. Setup-time action, not a per-task one, so that
  // lag is accepted rather than paid for on every tick.
  let tick = -1;
  let laneInfo;
  // A real transcript's tail can miss the 256KB fast-path window and fall
  // back to a full-file read+parse — measured at 7-12ms on real multi-MB
  // files, not the sub-millisecond cost a per-row-per-second read assumed.
  // Throttled on the same 20-tick cadence as laneInfo rather than read fresh
  // every `advance()`; only the transcript paths currently on screen are read.
  let ctxInfo = new Map();
  // Per-session live status from the previous tick, keyed
  // `${project}#${worktree}#${sessionId}` (#14 Phase 5), so a transition
  // (not just a value) can be detected per session, not just per lane —
  // transient watch-loop state, never folded into `state` itself. See
  // liveTransitionNotifications.
  const prevLiveEv = new Map();
  let liveStatuses;
  // `notify()` swallows its own failures; every onNotify gets the same
  // contract here, so a failing notifier costs neither the fold of events
  // already read nor the rest of the tick's notifications.
  const hand = (notification) => {
    try { onNotify(notification); } catch { /* notifications are optional */ }
  };

  return {
    advance() {
      const fresh = tail.read();
      // Keyed per session (#14 Phase 5), matching liveTransitionNotifications'
      // own `${laneKey}#${sessionId}` baseline key — `session ?? 'primary'`
      // falls back to the literal string only for an event with no session
      // tag at all (pre-#13 or a source that never sends one); every event
      // #13 itself emits already carries a real id, which is what actually
      // dedupes against the live-session check below for the common case.
      const notifiedKeys = new Set();
      for (const e of fresh) {
        const body = Object.hasOwn(NOTIFY, e.ev) ? NOTIFY[e.ev](e) : null;
        if (body) {
          hand({ title: notifyTitle(e), body });
          notifiedKeys.add(`${e.project || '?'}#${e.worktree ?? '?'}#${e.session ?? 'primary'}`);
        }
      }
      applyEvents(state, fresh);
      tick += 1;
      // Read here, ABOVE the throttle block below — the sessionHistory prune
      // inside it needs this tick's statuses. Read below it instead, tick 0
      // prunes against `undefined` and throws (dropping that frame and leaving
      // CTX empty until tick 20), and every later prune runs a tick stale —
      // dropping the history, and CTX, of a session that just attached. Read
      // once per tick, unthrottled (unlike laneInfo/ctxInfo below) — a handful
      // of small local JSON files, cheap even every second — and shared
      // between the notification check, the throttled block and `snapshot()`,
      // so everything agrees on one read.
      liveStatuses = readLiveStatuses();
      if (tick % 20 === 0) {
        laneInfo = enumerateLanes(ctx.config);
        const next = new Map();
        for (const { transcript } of state.lanes.values()) {
          if (transcript && !next.has(transcript)) next.set(transcript, readContext(transcript));
        }
        // "On screen" here means every live session matching ANY lane's
        // path, primary (`[0]`) included, not just #14's extra rows: the
        // primary row's own CTX can also resolve through a session's history
        // now (see `snapshotLane`'s `primaryHist`). Scoped this way rather than to
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
      for (const notification of liveTransitionNotifications(rowsFor(ctx, state.lanes, laneInfo), liveStatuses, state.sessionHistory, prevLiveEv, notifiedKeys)) {
        hand(notification);
      }
    },

    snapshot(now = Date.now()) {
      // `laneInfo` is only ever set by `advance()`: without this guard,
      // buildSnapshot's default would quietly read git on a consumer's call.
      if (laneInfo === undefined) throw new Error('snapshot() called before the first advance()');
      return buildSnapshot(ctx, state, { now, laneInfo, ctxInfo, liveStatuses });
    },
  };
}
