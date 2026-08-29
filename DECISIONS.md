# Decisions

Why this code is the way it is, and **what was already rejected** — read it before
changing existing behaviour. If something here looks odd, it is load-bearing.

Each entry carries a metadata line: `scope · YYYY-MM · location [· #issue]`.

- **`product`** — the contract with consuming repos. Reversing one changes what
  the tool *is*. High bar to add, high bar to change.
- **`core`** — internal mechanics of this repo. Only matters to someone editing
  it; goes stale when the implementation is rewritten.

Policy for adding, pruning and formatting: see `CLAUDE.md`. No line-count
budget — `.md` files are exempt outright, since decision logs need the room
prose takes. Prune only entries whose code is gone or whose decision was
reversed, never to make room.

---

## D31 — `emit()`'s session field is resolved by `hasOwnProperty`, not nullish-coalescing
`core` · 2026-08 · `lib/context.mjs:emit` · #13
Hook emitters (`hooks/emit.mjs`, `hooks/commit-guard.mjs`) always pass an explicit `session` key from their own hook payload, even when its value is null — `hasOwnProperty` lets that win unconditionally, so a hook event with no `session_id` never silently inherits `CLAUDE_CODE_SESSION_ID` from the subprocess environment, which issue #13 explicitly ruled out as unverified for hook-driven events. CLI emitters (`bin/lanes.mjs`, via `emitWithContext`) never pass the key at all, so they always fall back to the env var — every call site gets real attribution with zero code changes there, present or future.
Rejected: `event.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null` — cannot distinguish "the hook resolved no session" from "nobody set the key", so a hook's genuinely-null session would still inherit the ambient env value, reintroducing the exact leak the issue's constraint rules out.
Rejected: threading the env fallback through each of the five `bin/lanes.mjs` call sites individually — a call site added later would silently emit unattributed, with no test to catch it.

## D30 — `applyEvents`'s folded `stage` field stays, though nothing renders it
`core` · 2026-08 · `ui/dashboard.mjs:applyEvents` · #9
Dropping the STAGE column (#9) was a display decision; the field is the load-bearing half of the guard stopping a stage event from overwriting `ev`/`since`, and has its own test coverage.
Rejected: deleting it as dead state — it looks unread, but removing it risks taking the stage-is-not-a-liveness-signal guard down with it.

## D29 — `lanes status`'s frame caps at 100 columns even on a wider terminal
`core` · 2026-08 · `ui/dashboard.mjs:render` · #9
Keeps one consistent, compact shape at the user's real pane size instead of reflowing on every resize; still adapts down below 100, and drops CTX below 85 rather than starve BRANCH.
Rejected: letting BRANCH absorb the extra room on a wide terminal — recreates the pre-#9 behaviour where the same lane renders a different shape in every pane.

## D28 — `lanes rm` takes no selector; `lanes clear` is the separate command for removing every lane
`product` · 2026-08 · `bin/lanes.mjs`
`removeWorktree` only ever accepts a contiguous run ending at the top of the
stack, so a single `rm` has exactly one legal target: the current top. A bare
`lanes rm` defaulting to it loses no safety, unlike defaulting to `all` —
every lane detached at base is "free", so an unqualified default there could
silently take the whole stack. An explicit lane/name argument is still
accepted, but only as a confirmation that it names that same top lane; `all`
is refused, pointing at `lanes clear`, a different word chosen so mass
removal can't be reached by a typo or muscle-memory on `rm`.
Rejected: keeping `rm <sel>` accepting ranges/`all` as before — it forced
spelling out a target for the one common, always-safe case (pop the top)
purely so the rare, dangerous case (`all`) had somewhere to live; splitting
the verb removes that tension entirely.

## D27 — The exhaustive `lanes` command list lives in `docs/SETUP.md`, not `README.md`
`core` · 2026-08 · `README.md`, `docs/SETUP.md`
The README is the pitch, held near 100 lines, so a 19-command list would crowd
out what actually decides whether someone adopts the tool. Keeping one
canonical list means a new command can't be documented in one place and
forgotten in the other.
Rejected: listing every `lanes` command in the README too — it recreates two
lists that drift, as this same diff's `agents/code-reviewer.md` fix showed:
the pull toward re-syncing satellite files the moment the canonical location
is ambiguous.

## D26 — `lanes new` no longer accepts a name; every lane is auto-numbered (`lane<N>`)
`product` · 2026-08 · `lib/worktrees.mjs:planCreate` · #5
Lane identity moves from user-chosen to tool-generated, so numbers stay stable
across append/pop — a free-form name could still collide or reorder. Rejected:
keeping free-form names — it either forces the same convention anyway, or
tolerates the renumber-on-removal bug this exists to fix.

## D25 — The ctx cell shows a raw token count + model tag, never a percentage
`core` · 2026-08 · `ui/dashboard.mjs:ctxCell` · #4
A percentage needs a per-model context-window denominator; real transcripts on
this machine show sonnet-5 past 350K and opus-5/opus-4-8 past 900K before
auto-compaction, so any fixed denominator is wrong for most rows — the model
tag lets the reader supply it instead.
Rejected: a fixed-denominator percentage — an earlier draft used 200K and real
sonnet-5 sessions hit 165% of it, a confident-looking number that is wrong on
exactly the sessions this feature exists to warn about.

## D24 — `boundPort` stays in `lib/services.mjs`, not inlined into `serviceCell`
`core` · 2026-08 · `lib/services.mjs:boundPort`
Has exactly one caller now (`ui/dashboard.mjs`'s `serviceCell`, `lanes status`'s
only renderer since `lanes list` was retired), but its own branches — stopped,
running-and-matching, running-and-diverged, and a pidfile that never recorded a
port — get direct test coverage this way instead of only exercising it
indirectly through the renderer.
Rejected: inlining it into `serviceCell` now that only one caller is left — the
obvious cleanup, but it drops those branches back into a renderer, untestable
except through the full `render()` output.

## D23 — agent-system never installs a `statusLine` hook, only merges into `hooks`
`product` · 2026-08 · `install.mjs`, `hooks/emit.mjs`, `lib/transcript.mjs` · #4
StatusLine is a single slot in `settings.json` a target project may already own —
clobbering it on install is a silent regression. #4 reads `transcript_path` at render
time instead. Rejected: a statusLine script exposing the precomputed
`context_window.used_percentage` — more accurate, not worth the collision risk.

## D22 — `worktreesDir`, `basePort` and per-service `portBase` all resolve a gitignored per-machine override before the committed default
`product` · 2026-08 · `.claude/agent-system.local.json` · #1
Two developers may want their lanes, port range or per-service ports different
from each other; a single committed value can't satisfy all three — `lanes
adopt` and `lanes worktrees-dir`/`base-port`/`service-port` write these
locally, never committed. Full design: #1.
Rejected: an env var — invisible to `lanes doctor`, unlike the `lanes color` file.
Rejected: resolving the file at each lane's own root — `findProject` has that
directory in hand, but a linked worktree's root isn't shared; every lane would
need its own copy. Resolved at the MAIN worktree's root instead (`--git-common-dir`).

## D21 — `planCreate` creates a missing `worktreesDir` itself, but only if its parent already exists
`core` · 2026-08 · `lib/worktrees.mjs:planCreate`
`doctor`/`status` must stay read-only, but `new` is itself an act of creation —
refusing a path `adopt` just proposed is a dead end. The parent check stops it
from silently creating a stale or mistyped path instead of reporting it.
Rejected: routing through the read-only `worktreesDir()` accessor — the obvious
cleanup, but it reintroduces the refusal this exists to avoid, or makes
doctor/status create directories as a side effect of reading state.

## D15 — The quality gates run only in `/gate` Phase 5, never in the reviewer
`product` · 2026-08 · `skills/gate/SKILL.md`, `agents/code-reviewer.md`
Phases 3-4 modify the tree, so anything validated earlier validated a state that
no longer exists — and on a real repo those commands are minutes, twice.
Rejected: letting the reviewer run them for early signal on failing tests; the
cost is a duplicate pass and the signal is about to be invalidated anyway.

## D14 — Cheap shell prescreen, precise git parsing in Node
`core` · 2026-08 · `hooks/commit-guard.sh`, `hooks/commit-guard.mjs:isGitCommit`
Matchers key on the tool *name*, so the guard fires on every Bash call: the shell
only greps for `commit` (~ms), then Node (~50ms) walks git's option grammar by
token, because options take values. Rejected: a regex — it silently let
`git -C . commit` through, unreviewed.

## D13 — One decision file with `scope` tags, not two files and not ADRs
`core` · 2026-08 · `DECISIONS.md`
Rejected: one file per decision (`docs/adr/`) — to know what decisions exist you
must list a directory and read N files, which is *more* context, and the ADR
template is verbose by design. Rejected: splitting `product`/`core` into two
files — at this size reading both costs the same, and it buys the "which file
does this go in?" problem. Split only if one scope alone outgrows the budget.

## D12 — Opt-in is `.claude/agent-system.json`; absence means total silence
`product` · 2026-08 · `lib/context.mjs:findProject`
No config at a repo root → no events, no commit guard, no warnings. Rejected:
opt-out or auto-detection — every repo you never thought about would start
blocking commits.

## D11 — The architect may spike outside the repo, never implement inside it
`product` · 2026-08 · `skills/architect/SKILL.md`
It reads code, quotes it as evidence, writes exact type signatures, and may spike
to a scratch dir to check feasibility (then deletes it). Rejected: a flat "no code
at all" rule — it made specs vaguer and blocked feasibility checks.

## D20 — Lanes are long-lived infrastructure; "free" means nothing would be lost
`product` · 2026-08 · `lib/worktrees.mjs:isFree`, `skills/architect/SKILL.md`
You create a lane once and cycle branches through it, so `new`/`rm` are setup, not
per-task. Free = clean tree AND (on base OR nothing ahead of it), which is what
`/architect` checks before placing a branch. Rejected: a worktree per task —
churns lane numbers, and lane numbers drive colour and port.

## D19 — Services spawn detached, as process-group leaders
`core` · 2026-08 · `lib/services.mjs:start`
`stop` then signals `-pid` to take the whole tree. Rejected: a plain spawn —
killing the wrapper shell leaves the real dev server orphaned, and the failure is
silent until you find the port still bound.

## D18 — State keyed to a worktree is keyed by name; reuse is closed by explicit lifecycle handling, not by the key
`core` · 2026-08 · `lib/services.mjs:resolveServices`, `ui/dashboard.mjs:applyEvents`, `lib/worktrees.mjs:removeWorktree`
Keyed by name because `lane` is `null` for any worktree outside `worktreesDir`
— keying by lane number there is not an option at all. Under D26's `lane<N>`
naming, name and lane number are the same value, so the key alone no longer
protects against a freed number's state leaking into its next occupant: what
actually closes that is `removeWorktree` refusing while a declared service is
still running, and `applyEvents` deleting folded state on `lane_removed` and
resetting it on `lane_created`. Rejected: keying by lane — it's what the UI
displays, but is `null` outside `worktreesDir` and buys nothing extra inside it.

## D17 — Lane colours live per machine, never in the project config
`product` · 2026-08 · `lib/colors.mjs`, `lanes color`
Rejected: a `laneColors` array in the committed config — lane numbers are
auto-generated identically on every machine, but which branch actually sits in
lane 3 is independent per machine and per work history, so a shared palette
indexed by number is meaningless. File format is `N=hex` so a symlink from
another tool's colour file syncs them with no code coupling.

## D16 — The CLI is not installed anywhere; PATH points at this repo's `bin/`
`product` · 2026-08 · `install.mjs`, `docs/SETUP.md`
`git pull` is then the whole upgrade. Rejected: symlinking into `~/Scripts` —
it assumes that directory exists, and the link silently rots if the clone moves.
Rejected: copying the CLI — a stale copy is worse than no CLI.

## D10 — `bin/lanes` is a POSIX sh wrapper around `lanes.mjs`
`core` · 2026-08 · `bin/lanes`
Rejected: an extensionless Node file with a shebang — its module type comes from
the nearest `package.json`, which breaks as soon as anyone symlinks or copies the
CLI out of the repo. The wrapper hands Node an explicit `.mjs` path instead.

## D8 — One append-only JSONL for events, no locking
`core` · 2026-08 · `lib/context.mjs:emit`
POSIX `O_APPEND` is atomic below PIPE_BUF (4096B) and entries are single-line JSON
well under it, so concurrent sessions cannot interleave; oversized lines are
dropped. Rejected: flock, SQLite, file-per-session — no such problem exists here.

## D6 — `/gate` is a skill; the commit hook is only a thin guard
`product` · 2026-08 · `hooks/commit-guard.mjs`
`/gate` is interactive and writes to disk — a hook can do neither — so the hook
blocks and returns a reason for the agent to ask about. Rejected: running the full
review from the hook, and a read-only reviewer at commit time (loses fix application).

## D5 — Review markers are keyed to per-path blob hashes, and staging is a no-op
`core` · 2026-08 · `lib/marks.mjs:diffFingerprint` · #4
Every path differing from HEAD or untracked, as `path:blobHash` (`path:D` when
deleted), sorted and hashed. Edit one line after reviewing and the marker goes
stale, so approval cannot outlive the code it approved — but `git add` alone is
not an edit and must not invalidate it.
Rejected: `git diff --cached` + `git diff` concatenated — the simpler shape, and
the one this was reverted from: the same edit's text moves between the two
slots the moment it is staged, so staging alone changed the fingerprint and
blocked a commit /gate had just reviewed.
Rejected: a timestamp or HEAD-based marker — both survive edits.

## D4 — The commit guard blocks and offers a choice, rather than warning
`product` · 2026-08 · `hooks/commit-guard.mjs`
A warning gets ignored on busy days; a hard block gets `--no-verify`. Blocking
with a one-shot in-conversation escape hatch (`lanes allow-commit`) keeps the
decision visible without training a bypass.

## D3 — The reviewer is a commit-time gate, not a pipeline stage
`product` · 2026-08 · `hooks/commit-guard.mjs`
So it also catches work written outside `/architect`. **The design depends on
committing small:** at ~200 changed lines findings get applied, at 800 they get
ignored — hence the `largeDiffThreshold` warning.

## D1 — Architect and implementation both run in the main session
`product` · 2026-08 · `skills/architect/SKILL.md`
No "programmer" agent exists. Delegating either to a subagent means leaving the
loop and reviewing a large diff cold, after the misunderstanding has propagated.
Rejected: a full architect→programmer→QA→reviewer pipeline — waterfall with new
names, multiplying the cost of a bad first stage by every stage after it.
