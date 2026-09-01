# Reference

Internals worth knowing, but not needed to use the project day to day. See the
[README](../README.md) for daily use and [`SETUP.md`](SETUP.md) for install
and configuration.

## The commit guard

`git commit` is blocked when the current diff has not been through `/gate`.
The hook cannot talk to you directly, so it denies the call and hands the agent
a reason; the agent then asks you whether to review first or commit anyway. If
you choose to commit anyway it runs `lanes allow-commit` and retries.

The review marker is a hash of the diff, so it cannot outlive the code it
approved: edit one line after reviewing and the guard fires again.

The block message always reports the diff's size, and escalates past
`review.largeDiffThreshold` (default 400 changed lines) to suggest splitting
the commit.

Turn it off per project with `"review": { "commitGuard": false }`.

## Events

Everything is appended to `~/.claude/lanes/events.jsonl` by hooks, and by a few
`lanes` CLI commands directly — the model never sees any of it, so the
dashboard costs zero tokens.

| event | meaning |
|---|---|
| `session_start` / `session_end` | a Claude Code session opened / closed in a lane |
| `busy` | you sent a message; the lane is working |
| `idle` | the agent finished its turn — **the lane is waiting for you** |
| `agent_start` / `agent_end` | a subagent was spawned / returned |
| `stage` | a pipeline stage was entered (`lanes stage …`) |
| `reviewed` | `/gate` marked the diff clean |
| `commit_blocked` / `commit_bypass` / `commit_reviewed` | commit guard outcomes |
| `lane_created` / `lane_removed` | `lanes new` / `lanes rm` or `lanes clear` created or removed a lane |
| `lane_reset` | `lanes reset` returned a lane to a clean base state — the dashboard row starts fresh, same as `lane_created` |

`idle` is the one that earns the dashboard its keep: with four lanes, the thing
you cannot see is which one has been sitting waiting on you for twenty minutes.

Appends are single-line JSON under 4KB, so POSIX `O_APPEND` keeps concurrent
sessions from interleaving without any locking.

`session_start` and `Stop`-driven `idle` events also carry `transcript`, the
session's transcript file path — used by the dashboard to show live context
(token count + model) on each lane's row, read fresh at render time rather
than computed by the hook.

Every event also carries `session`, the id of the Claude Code session that
produced it — taken from the hook payload for hook-driven events, from
`CLAUDE_CODE_SESSION_ID` for the `lanes` CLI, and `null` when a `lanes`
command is run outside Claude Code. Read by the dashboard: it attributes
folded state per session (`state.sessionHistory`) and keys same-tick
notification dedup, so an untagged event double-notifies.

The dashboard's displayed state is not purely event-derived: each render tick
also reads `~/.claude/sessions/*.json`, Claude Code's own live per-session
status file, and lets it override the folded `busy`/`idle`/nothing with the
session's real-time `busy`/`idle`/`waiting` — catching an interrupted turn (no
`Stop` ever fires) or a pending `AskUserQuestion`, neither of which produces
an event above. The richer, lanes-specific states (`agent_start`, `reviewed`,
`commit_*`, `lane_*`) stay authoritative and are never overridden.

More than one live session can share a lane — its own root plus a
subdirectory launch, say. A session launched at the lane root outranks one
launched from a subdirectory; among sessions tied on that, the oldest is
primary (session id breaks a remaining tie). The primary drives the lane's
own row; every other one renders as its own row directly beneath, showing
that session's own name — its session id when Claude Code gave it none —
its live busy/idle/waiting status, and its own context, never the lane's. An
extra row is hidden only when *that* session's own history is a lane-wide
fact (any commit-guard outcome — blocked, reviewed or bypassed — or the lane
itself created/removed/reset), never because the primary session happens to
be in one of those states: the two sessions are otherwise independent, and
each is what earns it its own row.

Both the events log and `~/.claude/sessions/*.json` are per-machine, not
per-project, so a lane from any other repo that has adopted agent-system can
appear in the same dashboard. Rows are grouped by project under a dim header
line, the current project's group always sorting first; RECENT — a single
chronological log, so it cannot group without breaking the ordering that makes
it useful — tags each line with its project instead, current-project rows
included.

## Known limitations

Stated plainly, because finding these yourself later is worse:

- **The architect's boundary is prompt-enforced, not tool-enforced.** It runs in
  your main session (you need a real conversation, and a subagent cannot give
  you one), and the main session has write tools. The boundary is *no
  implementation in the repo* — it may read and quote code, specify exact type
  signatures, and spike outside the repo to check feasibility. If it starts
  handing you an implementation, tell it to stop: that is a prompt failure, not
  a safe design.
- **The commit guard runs on every Bash call.** A few ms for the shell prescreen;
  the Node path (~50ms) only runs when the command mentions `commit`. The
  prescreen over-approximates on purpose — see `DECISIONS.md` D14.
- **The event log keeps one rotated generation** (2 MiB each). It is a dashboard
  feed, not an audit trail; if you want long-term history, ship the JSONL
  somewhere else.
- **Notifications fire for events that arrive while `lanes status` is running,
  and for live-status transitions read from `~/.claude/sessions/*.json` each
  tick** (deduplicated per session, keyed `project#worktree#sessionId`, within
  the same tick — so a normal `Stop` never double-fires, and two sessions
  sharing a lane never suppress each other's notification. A session file
  carrying no id of its own is keyed by pid instead, so — like an untagged
  event, above — its `Stop` can double-fire too). History is
  replayed into the display but never notified, on either path.
- **Project-local agents and skills win over these.** A repo with its own
  `.claude/agents/` or `.claude/skills/` keeps using them, so adopting this
  system there does not change existing behaviour on its own — you get the hooks
  and the dashboard, not the agents. Worth knowing before wondering why `/gate`
  behaves differently in one repo.

## Tests

```bash
npm test
```

A single hand-rolled suite over a real throwaway git repo with real
worktrees: issue extraction, lane numbering, event folding and its bounds,
review-marker staleness, and every branch of the commit guard. No dependencies.

Run it before publishing a change to `lib/`, `hooks/` or `ui/` — the guard's
option parsing in particular is the kind of thing that breaks silently.
