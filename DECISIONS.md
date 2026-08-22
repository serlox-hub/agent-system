# Decisions

Why this code is the way it is, and **what was already rejected** — read it before
changing existing behaviour. If something here looks odd, it is load-bearing.

Each entry carries a metadata line: `scope · YYYY-MM · location [· #issue]`.

- **`product`** — the contract with consuming repos. Reversing one changes what
  the tool *is*. High bar to add, high bar to change.
- **`core`** — internal mechanics of this repo. Only matters to someone editing
  it; goes stale when the implementation is rewritten.

Policy for adding, pruning and formatting: see `CLAUDE.md`. Budget: under 150
lines, held by deleting entries whose code is gone — never by deleting a live one
to make room.

---

## D24 — `boundPort()` lives in `lib/services.mjs`, shared by `lanes list` and `lanes ui`
`core` · 2026-08 · `lib/services.mjs:boundPort` · #3
Both renderers computed the bound-port/`!`-divergence formula independently — the same
class of drift `laneMarks` was extracted once to prevent. Rejected: leaving it duplicated,
which issue #3's own Out of scope named — a two-screens-can-disagree formula outweighs
staying inside that line.

## D23 — agent-system never installs a `statusLine` hook, only merges into `hooks`
`product` · 2026-08 · `install.mjs`, `hooks/emit.mjs` · #4
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
`core` · 2026-08 · `lib/worktrees.mjs:124`
`list`/`doctor`/`ui` must stay read-only, but `new` is itself an act of creation —
refusing a path `adopt` just proposed is a dead end. The parent check stops it
from silently creating a stale or mistyped path instead of reporting it.
Rejected: routing through the read-only `worktreesDir()` accessor — the obvious
cleanup, but it reintroduces the refusal this exists to avoid, or makes
list/doctor/ui create directories as a side effect of reading state.

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

## D18 — State keyed to a worktree is keyed by name, never by lane number
`core` · 2026-08 · `lib/services.mjs:resolveServices`, `ui/dashboard.mjs:applyEvents`
Lane numbers are positional and shift when a lane is added or removed, leaving
service bookkeeping or the dashboard's folded state pointing at — or inheriting
from — the wrong worktree; the bound port is recorded in the pid file likewise.
Rejected: keying by lane — it's what the UI displays, but silently wrong on add/remove.

## D17 — Lane colours live per machine, never in the project config
`product` · 2026-08 · `lib/colors.mjs`, `lanes color`
Rejected: a `laneColors` array in the committed config — lane numbers come from
each developer's own worktree names, so lane 3 is a different branch per machine
and a shared palette indexed by it is meaningless. File format is `N=hex` so a
symlink from another tool's colour file syncs them with no code coupling.

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

## D9 — Lane numbers are the alphabetical position under `worktreesDir`
`core` · 2026-08 · `lib/context.mjs:resolveLane`
The number is what the dashboard colour and the dev-server port hang off, so it
has to be stable. Rejected: `git worktree list` order — it is roughly creation
order, so removing and re-adding a worktree renumbers every lane after it, and a
lane number that moves is worse than no lane number.

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

## D5 — Review markers are keyed to a hash of the diff
`core` · 2026-08 · `lib/marks.mjs:diffFingerprint`
Staged + unstaged + untracked. Edit one line after reviewing and the marker goes
stale, so approval cannot outlive the code it approved. Rejected: a timestamp or
HEAD-based marker — both survive edits.

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
