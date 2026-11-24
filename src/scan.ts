// Bounded, cache-backed directory scan for Markdown sources.
// Consumed by every adapter (obsidian / loginote / ledger).
// Read-only, dependency-free, 0 LLM. Paths go through node:path only.

import { createHash } from 'node:crypto';
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { LinkItem } from './types.js';
import { decodeText } from './markdown.js';

export interface ScannedFile {
  absPath: string;
  relPath: string;
  mtimeMs: number;
  size: number;
  item?: LinkItem;
  truncated: boolean;
}

export interface ScanCache {
  entries: Map<string, { mtimeMs: number; size: number; item?: LinkItem }>;
}

export interface ScanOptions {
  /** Directory names to skip at any depth. Default: ['.git', '.obsidian', 'node_modules']. */
  excludes?: string[];
  /** Hard upper bound on the number of collected files. Default: 5000. */
  maxFiles?: number;
  /** Per-file read ceiling in bytes; larger files are truncated. Default: 1 MiB. */
  maxFileBytes?: number;
  /** Turn one file + its decoded raw text into a LinkItem. */
  parse: (f: ScannedFile, raw: string) => LinkItem;
  /** Caller-owned cache reused across requests; a fresh one is used when omitted. */
  cache?: ScanCache;
  signal?: AbortSignal;
}

export interface ScanResult {
  files: ScannedFile[];
  revision: string;
  count: number;
  reachable: boolean;
  diagnostics: string[];
}

const DEFAULT_EXCLUDES = ['.git', '.obsidian', 'node_modules'];
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

export function createScanCache(): ScanCache {
  return { entries: new Map() };
}

/** sha256 over the sorted `relPath:mtime:size` lines of the (possibly empty) file set. */
export function computeRevision(
  entries: { relPath: string; mtimeMs: number; size: number }[],
): string {
  const lines = entries
    .map((e) => `${e.relPath}:${e.mtimeMs}:${e.size}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function emptyResult(reachable: boolean, diagnostics: string[]): ScanResult {
  return {
    files: [],
    revision: computeRevision([]),
    count: 0,
    reachable,
    diagnostics,
  };
}

export function scanMarkdown(root: string, opts: ScanOptions): ScanResult {
  const excludes = new Set(opts.excludes ?? DEFAULT_EXCLUDES);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const parse = opts.parse;
  const cache = opts.cache ?? createScanCache();
  const signal = opts.signal;
  const isAborted = (): boolean => signal?.aborted === true;

  // Resolve the root up front so `reachable` is accurate and no traversal
  // ever starts from a path outside the canonical root.
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return emptyResult(false, [`root not found or unreadable: ${root}`]);
  }
  let rootStat: Stats;
  try {
    rootStat = statSync(rootReal);
  } catch {
    return emptyResult(false, [`root not statable: ${root}`]);
  }
  if (!rootStat.isDirectory()) {
    return emptyResult(false, [`root is not a directory: ${root}`]);
  }

  const files: ScannedFile[] = [];
  const diagnostics: string[] = [];
  const seenReal = new Set<string>();
  let limitReached = false;
  let abortNoted = false;

  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  const isInsideRoot = (realPath: string): boolean =>
    realPath === rootReal || realPath.startsWith(rootPrefix);

  const noteAborted = (): void => {
    if (!abortNoted) {
      abortNoted = true;
      diagnostics.push('scan aborted by signal');
    }
  };

  const walk = (dirReal: string, relDir: string): void => {
    if (isAborted()) {
      noteAborted();
      return;
    }
    let entries;
    try {
      entries = readdirSync(dirReal, { withFileTypes: true });
    } catch {
      diagnostics.push(`unreadable directory: ${relDir || '.'}`);
      return;
    }

    for (const ent of entries) {
      if (isAborted()) {
        noteAborted();
        return;
      }
      if (excludes.has(ent.name)) continue;

      const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;
      const absCandidate = join(dirReal, ent.name);

      // Resolve through symlinks/junctions before touching anything. Anything
      // whose real path leaves the canonical root is skipped, never read.
      let real: string;
      try {
        real = realpathSync(absCandidate);
      } catch {
        diagnostics.push(`unresolvable entry: ${relPath}`);
        continue;
      }
      if (!isInsideRoot(real)) {
        diagnostics.push(`skipped path escaping root: ${relPath}`);
        continue;
      }
      if (seenReal.has(real)) continue;

      let st: Stats;
      try {
        st = statSync(real);
      } catch {
        diagnostics.push(`stat failed: ${relPath}`);
        continue;
      }

      if (st.isDirectory()) {
        seenReal.add(real);
        walk(real, relPath);
        if (limitReached || isAborted()) return;
        continue;
      }
      if (!st.isFile()) continue;
      if (!MARKDOWN_EXTS.has(extname(ent.name).toLowerCase())) continue;

      if (files.length >= maxFiles) {
        diagnostics.push(`maxFiles limit reached (${maxFiles}); traversal stopped`);
        limitReached = true;
        return;
      }

      seenReal.add(real);
      const { mtimeMs, size } = st;
      const truncated = size > maxFileBytes;

      let item: LinkItem | undefined;
      const cached = cache.entries.get(real);
      if (
        cached &&
        cached.mtimeMs === mtimeMs &&
        cached.size === size &&
        cached.item !== undefined
      ) {
        item = cached.item;
      } else {
        let buf: Buffer;
        try {
          if (truncated) {
            buf = Buffer.allocUnsafe(maxFileBytes);
            const fd = openSync(real, 'r');
            try {
              const read = readSync(fd, buf, 0, maxFileBytes, 0);
              buf = buf.subarray(0, read);
            } finally {
              closeSync(fd);
            }
          } else {
            buf = readFileSync(real);
          }
        } catch {
          diagnostics.push(`read failed: ${relPath}`);
          continue;
        }
        const { text } = decodeText(buf);
        const base: ScannedFile = { absPath: real, relPath, mtimeMs, size, truncated };
        try {
          item = parse(base, text);
        } catch {
          diagnostics.push(`parse failed: ${relPath}`);
          item = undefined;
        }
        if (item !== undefined) {
          cache.entries.set(real, { mtimeMs, size, item });
        }
      }

      const sf: ScannedFile = { absPath: real, relPath, mtimeMs, size, truncated };
      if (item !== undefined) sf.item = item;
      files.push(sf);
    }
  };

  walk(rootReal, '');
  if (isAborted()) noteAborted();

  return {
    files,
    revision: computeRevision(files.map((f) => ({
      relPath: f.relPath,
      mtimeMs: f.mtimeMs,
      size: f.size,
    }))),
    count: files.length,
    reachable: true,
    diagnostics,
  };
}
