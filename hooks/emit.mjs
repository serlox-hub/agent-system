#!/usr/bin/env node
/**
 * Universal event emitter for the lanes dashboard.
 *
 * Wired to SessionStart / UserPromptSubmit / Stop / SessionEnd and to
 * PreToolUse+PostToolUse on the subagent tool. It never blocks, never prints
 * to stdout (stdout of a hook is fed back into the session and would cost
 * tokens), and exits 0 no matter what.
 *
 * Token cost: zero. The model never sees any of this.
 */

import { readHookInput, emitWithContext } from '../lib/context.mjs';

/** The subagent-spawning tool has been called both `Task` and `Agent`. */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

function agentNameFrom(input) {
  const ti = input?.tool_input || {};
  return ti.subagent_type || ti.agentType || 'claude';
}

function labelFrom(input) {
  const ti = input?.tool_input || {};
  return ti.description || ti.label || null;
}

const HOOK_MAP = {
  // The main agent finished its turn: nobody is working, the user is the
  // blocker. This is the single most useful signal in the whole UI.
  // `transcript_path` rides here and on SessionStart only — it is constant
  // for a session's lifetime, so every other event carrying it would only
  // grow the log for no benefit (measured: +64% per event on UserPromptSubmit,
  // which fires on every message).
  Stop: (input) => ({ ev: 'idle', transcript: input?.transcript_path || null }),
  // The user replied: the lane is live again.
  UserPromptSubmit: () => ({ ev: 'busy' }),
  SessionStart: (input) => ({
    ev: 'session_start',
    detail: input?.source || null,
    transcript: input?.transcript_path || null,
  }),
  SessionEnd: (input) => ({ ev: 'session_end', detail: input?.reason || null }),
};

async function main() {
  const input = await readHookInput();
  const hook = input?.hook_event_name || process.argv[2] || '';
  const cwd = input?.cwd || process.cwd();
  const session = input?.session_id || null;

  if (hook === 'PreToolUse' || hook === 'PostToolUse') {
    if (!SUBAGENT_TOOLS.has(input?.tool_name)) return; // not a subagent spawn
    emitWithContext(hook === 'PreToolUse' ? 'agent_start' : 'agent_end', cwd, {
      session,
      agent: agentNameFrom(input),
      detail: labelFrom(input),
    });
    return;
  }

  const mapper = HOOK_MAP[hook];
  if (!mapper) return;
  const { ev, detail, transcript } = mapper(input);
  const extra = { session, detail: detail ?? null };
  if (transcript !== undefined) extra.transcript = transcript;
  emitWithContext(ev, cwd, extra);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
