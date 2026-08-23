/**
 * Per-lane dev services.
 *
 * Every project declares its own, because no two stacks start the same way — a
 * React client and a Python API in one repo are two services with different
 * commands, different directories and different port series:
 *
 *   "dev": { "services": [
 *     { "name": "web", "command": "pnpm dev --port {port}", "portBase": 300 },
 *     { "name": "api", "cwd": "services/api",
 *       "command": "uv run uvicorn app.main:app --port {port}", "portBase": 400 }
 *   ]}
 *
 * This is the only part of agent-system that owns mutable state (pids) and
 * long-lived child processes. It is imported lazily by exactly the subcommands
 * that need it, so a failure here can never take down the review gate.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { LANES_DIR } from './context.mjs';

const PID_DIR = join(LANES_DIR, 'pids');
const LOG_DIR = join(LANES_DIR, 'logs');

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

/** Blocking sleep. A CLI stopping a process has nothing else to do meanwhile. */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * Port for a lane: the base and the lane number concatenated, matching the
 * top-level `basePort` convention already used for display (base 300, lane 2 →
 * 3002). Addition would collide between services whose bases are close.
 */
export function portFor(base, lane) {
  return `${base}${lane}`;
}

function fill(template, vars) {
  return String(template).replace(/\{(port|lane|worktree|name)\}/g, (_, k) => vars[k] ?? '');
}

/**
 * Resolve a lane's services from config. Returns [] when the project declares
 * none, which is the normal case for a repo that has no dev server.
 */
export function resolveServices(config, lane) {
  const declared = config?.dev?.services;
  if (!Array.isArray(declared) || declared.length === 0) return [];
  const project = safe(config?.project || 'project');

  return declared.flatMap((svc, i) => {
    const name = svc?.name || `service-${i + 1}`;
    if (!svc?.command) return []; // a service without a command is not startable
    const port = portFor(svc.portBase ?? config?.basePort ?? '', lane.lane);
    const vars = { port, lane: lane.lane, worktree: lane.name, name };
    // Keyed by worktree NAME because `lane.lane` can be `null` for a worktree
    // outside `worktreesDir` — a numeric key isn't even available there. Under
    // D26's `lane<N>` naming, name and lane number are otherwise the same
    // value, so the name itself buys no protection against a reused number
    // inheriting a running process's bookkeeping; `removeWorktree`'s
    // running-service refusal is what actually closes that (D18).
    const key = `${project}-${safe(lane.name)}-${safe(name)}`;
    return [{
      name,
      port,
      command: fill(svc.command, vars),
      cwd: svc.cwd && svc.cwd !== '.' ? join(lane.path, svc.cwd) : lane.path,
      url: svc.url ? fill(svc.url, vars) : null,
      pidFile: join(PID_DIR, `${key}.pid`),
      logFile: join(LOG_DIR, `${key}.log`),
    }];
  });
}

/**
 * `{ pid, port }` from the pid file. The port is recorded at start time because
 * the computed port follows `portBase` (top-level or per-service), which can be
 * edited while the process is still running — the truth is what it actually
 * bound to.
 */
function readPidFile(svc) {
  try {
    const [pidRaw, portRaw] = readFileSync(svc.pidFile, 'utf8').trim().split(/\s+/);
    const pid = Number(pidRaw);
    return Number.isInteger(pid) && pid > 0 ? { pid, port: portRaw || null } : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `{ running, pid, port }`. Clears the pid file when the process is gone. */
export function status(svc) {
  const rec = readPidFile(svc);
  if (rec === null) return { running: false, pid: null, port: null };
  if (alive(rec.pid)) return { running: true, pid: rec.pid, port: rec.port };
  try { unlinkSync(svc.pidFile); } catch { /* already gone */ }
  return { running: false, pid: null, port: null };
}

/**
 * `{ port, moved }` for a service given its own `status()`: `port` is the
 * port it actually bound to while running (falling back to the freshly
 * computed one only if a pre-existing pidfile never recorded a port), or the
 * freshly computed one while stopped. `moved` is the `!` marker string when
 * the two disagree — `portBase` can be edited (top-level `basePort` or a
 * service's own, via `lanes service-port`) while the process stays up, so the
 * bound port and a fresh computation can diverge without the process itself
 * doing anything wrong.
 *
 * Shared by `lanes list` (bin/lanes.mjs) and `lanes ui`/`lanes status`
 * (ui/dashboard.mjs) so the two screens can never quietly disagree about the
 * same running service — the same reasoning `lib/worktrees.mjs`'s laneMarks
 * was extracted for.
 */
export function boundPort(svc, st) {
  const port = st.running ? st.port ?? svc.port : svc.port;
  const moved = st.running && st.port && st.port !== svc.port ? '!' : '';
  return { port, moved };
}

export function start(svc) {
  const current = status(svc);
  if (current.running) return { already: true, pid: current.pid };

  mkdirSync(PID_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  if (!existsSync(svc.cwd)) return { error: `cwd does not exist: ${svc.cwd}` };

  let fd;
  try {
    fd = openSync(svc.logFile, 'a');
    const child = spawn(svc.command, {
      cwd: svc.cwd,
      shell: true,
      // detached makes the child a process-group leader, so stopping it can kill
      // the whole tree. `pnpm dev` spawns children; killing only the shell orphans them.
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    if (!child.pid) return { error: 'spawn returned no pid' };
    writeFileSync(svc.pidFile, `${child.pid} ${svc.port}\n`);
    return { pid: child.pid, port: svc.port };
  } catch (err) {
    return { error: String(err && err.message) };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function stop(svc, { graceMs = 2000 } = {}) {
  const current = status(svc);
  if (!current.running) return { notRunning: true };
  const pid = current.pid;

  // Negative pid targets the whole process group — that is the point of spawning
  // detached. Fall back to the bare pid if the group is already gone.
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };

  signal('SIGTERM');
  const deadline = graceMs;
  let waited = 0;
  while (waited < deadline && alive(pid)) {
    sleepSync(100);
    waited += 100;
  }
  const killed = alive(pid) ? (signal('SIGKILL'), 'SIGKILL') : 'SIGTERM';
  try { unlinkSync(svc.pidFile); } catch { /* already gone */ }
  return { pid, signal: killed };
}

export function tailLog(svc, lines = 50) {
  try {
    const text = readFileSync(svc.logFile, 'utf8').split('\n');
    return text.slice(-lines - 1).join('\n');
  } catch {
    return null;
  }
}

