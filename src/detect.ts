// Best-effort discovery of the three federated source roots, so a fresh
// install can pre-fill the settings form (and feed the source) without the
// user typing absolute paths by hand.
//
// Everything here is heuristic and side-effect free: it only *reads* a small,
// bounded set of directories and never throws. Any value the user saves in the
// settings form overrides the detected default.

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DetectedRoots {
  obsidian: string;
  loginote: string;
  ledger: string;
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path exists as either a file or a directory. */
function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function childDirs(base: string, max = 80): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, max)
      .map((entry) => join(base, entry.name));
  } catch {
    return [];
  }
}

/**
 * First directory at or below `bases` (breadth-first, depth-limited) that has a
 * child named `marker` (a folder such as `.obsidian`, or a file such as
 * `metadata.json`). That directory is the candidate root.
 */
function findWithMarker(bases: readonly string[], marker: string, depth: number): string | undefined {
  const seen = new Set<string>();
  const queue = bases.filter(dirExists).map((dir) => ({ dir, level: 0 }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const { dir, level } = next;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (pathExists(join(dir, marker))) return dir;
    if (level < depth) {
      for (const child of childDirs(dir)) queue.push({ dir: child, level: level + 1 });
    }
  }
  return undefined;
}

function detectObsidian(): string {
  const env = process.env.OBSIDIAN_VAULT;
  if (env !== undefined && dirExists(env)) return env;
  // An Obsidian vault is the directory that directly holds the `.obsidian/`
  // metadata folder.
  const bases = [
    join('D:', 'azb', '数据', 'Obsidian笔记'),
    join(homedir(), 'Documents'),
    join(homedir(), 'Obsidian'),
  ];
  return findWithMarker(bases, '.obsidian', 2) ?? '';
}

function detectLoginote(): string {
  const env = process.env.LOGINOTE_VAULT;
  if (env !== undefined && dirExists(env)) return env;
  // A LogiNote library holds a `metadata.json` beside its `vault/` markdown tree.
  const bases = [
    join('D:', 'azb', '数据', 'LogiNote'),
    join(homedir(), 'LogiNote'),
    join(homedir(), 'Documents'),
  ];
  const base = findWithMarker(bases, 'metadata.json', 2);
  if (base === undefined) return '';
  // Prefer the `vault/` child when the marker sits one level above it.
  const vault = join(base, 'vault');
  return dirExists(vault) ? vault : base;
}

function detectLedger(): string {
  const env = process.env.LEDGER_ROOT;
  if (env !== undefined && dirExists(env)) return env;
  // The ledger source points at the workspace this plugin is developed/installed
  // from: the repository two levels above this module (lib/ or src/ → package →
  // workspace root, which holds `ledger/` and `交接.md`).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..');
  } catch {
    return '';
  }
}

let cached: DetectedRoots | undefined;

/** Detected once per process; never throws. Empty string means "not found". */
export function detectDefaultRoots(): DetectedRoots {
  if (cached !== undefined) return cached;
  const safe = (fn: () => string): string => {
    try {
      return fn();
    } catch {
      return '';
    }
  };
  cached = {
    obsidian: safe(detectObsidian),
    loginote: safe(detectLoginote),
    ledger: safe(detectLedger),
  };
  return cached;
}
