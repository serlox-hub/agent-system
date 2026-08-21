/**
 * Lane colours.
 *
 * Per-machine, never in the project config: lane numbers come from each
 * developer's own worktree names, so lane 3 is a different branch on a different
 * machine and a committed palette indexed by it would be meaningless.
 *
 * The file format is deliberately `N=hex`, one per line — the same shape other
 * worktree helpers use, so `ln -s` from an existing colour file keeps the two in
 * sync with no code dependency between them.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LANES_DIR } from './context.mjs';

export const COLORS_FILE = join(LANES_DIR, 'colors');

/** Fallback palette, cycling past the end. Legible on light and dark terminals. */
export const DEFAULT_PALETTE = ['#4FA3D1', '#64B36A', '#D1904F', '#B07BC9', '#D16B7C', '#4FB3A8'];

const HEX = /^#?([0-9a-fA-F]{6})$/;

export function ansi(hex) {
  const m = HEX.exec(String(hex).trim());
  if (!m) return '';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** `{ 1: 'RRGGBB', ... }` from the per-machine file. Missing file is normal. */
export function readColors() {
  const out = {};
  try {
    for (const line of readFileSync(COLORS_FILE, 'utf8').split('\n')) {
      const m = /^(\d+)\s*=\s*#?([0-9a-fA-F]{6})$/.exec(line.trim());
      if (m) out[Number(m[1])] = m[2];
    }
  } catch {
    /* no file yet — the default palette covers it */
  }
  return out;
}

export function setColor(lane, hex) {
  const m = HEX.exec(String(hex).trim());
  if (!Number.isInteger(lane) || lane < 1) throw new Error('lane must be a positive integer');
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const colors = { ...readColors(), [lane]: m[1] };
  if (!existsSync(LANES_DIR)) mkdirSync(LANES_DIR, { recursive: true });
  const body = Object.keys(colors)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => `${n}=${colors[n]}`)
    .join('\n');
  writeFileSync(COLORS_FILE, `${body}\n`);
  return colors;
}

/** `lane -> ANSI colour`: the developer's override, else the default palette. */
export function laneColorFor(overrides = readColors()) {
  return (lane) => {
    if (!lane) return '';
    if (overrides[lane]) return ansi(overrides[lane]);
    return ansi(DEFAULT_PALETTE[(lane - 1) % DEFAULT_PALETTE.length]);
  };
}
