// Ledger adapter: a bounded, read-only view over a single task-ledger Markdown
// file (default `交接.md`). Unlike the obsidian/loginote adapters it does not
// walk a directory — it reads exactly one file and slices it into line-anchored
// entries so every result carries a real `#L<line>` provenance.
//
// READ-ONLY IRON RULE: this module only ever reads the target file. It never
// writes, creates, or deletes anything. A missing file degrades to
// `facts().reachable === false` and `read()` returning `undefined`; it never
// throws.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type {
  AdapterFacts,
  LinkAdapter,
  LinkItem,
  LinkRelation,
  ScanLimits,
} from '../types.js';
import { decodeText, matchSnippet } from '../markdown.js';

export interface LedgerAdapterOptions {
  /** Ledger root. Must be an absolute path; a relative path throws. */
  root: string;
  /** Ledger filename relative to `root`. Defaults to `'交接.md'`. */
  file?: string;
  /**
   * Per-file read ceiling in bytes. Captured once at factory creation; bytes
   * beyond it are never read and the tail chunk is flagged `truncated`.
   */
  maxFileBytes: number;
}

const SOURCE = 'ledger' as const;
const ID_PREFIX = `${SOURCE}:`;
const DEFAULT_FILE = '交接.md';
const MAX_TITLE_CHARS = 60;
/** Chunk boundary: a Markdown heading (levels 1-3) followed by whitespace. */
const HEADING_BOUNDARY = /^#{1,3}\s/;
/** Chunk boundary: a top-level list item (`- ` at column 0). */
const LIST_BOUNDARY = /^-\s/;
/** Captures the heading text after `#{1,3}` and its space. */
const HEADING_TEXT = /^#{1,3}\s+(.*)$/;

/** Numeric timestamp for ordering; unparseable values sort as oldest. */
function tsValue(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Case-insensitive title hit test; an empty query never counts as a hit. */
function titleHits(title: string, query: string): boolean {
  if (query.length === 0) return false;
  return title.toLowerCase().includes(query.toLowerCase());
}

/** Normalize a relative path to forward slashes; fall back to the file arg. */
function normalizeRel(rel: string, file: string): string {
  const norm = rel.split(/[\\/]/).join('/');
  return norm === '' ? file.split(/[\\/]/).join('/') : norm;
}

/**
 * Accumulate items under a strict character budget (body length). Mirrors the
 * Obsidian / LogiNote adapters' `takeWithinBudget`: the total body characters
 * never exceed `limits.maxCharacters`, the first item is always kept (a
 * truncated copy is flagged when it alone overflows), and later items are only
 * included while they fit.
 */
function takeWithinBudget(items: LinkItem[], limits: ScanLimits): LinkItem[] {
  const maxResults = limits.maxResults;
  let remaining = limits.maxCharacters;
  const out: LinkItem[] = [];
  if (maxResults <= 0 || remaining <= 0) return out;

  for (const item of items) {
    if (out.length >= maxResults || remaining <= 0) break;
    const len = item.body.length;
    if (len <= remaining) {
      out.push(item);
      remaining -= len;
    } else if (out.length === 0) {
      out.push({ ...item, body: item.body.slice(0, remaining), truncated: true });
      remaining = 0;
    } else {
      break;
    }
  }
  return out;
}

interface Chunk {
  /** 1-based line of the chunk's first line. */
  startLine: number;
  body: string;
}

/**
 * Slice normalized text into line-anchored chunks.
 *
 * A new chunk begins at the first non-blank line and at every heading
 * (`^#{1,3}\s`) or list-item (`^-\s`) line thereafter. Each chunk runs up to
 * (but not including) the next boundary. Trailing blank lines are trimmed off
 * the chunk body. Lines that precede the first boundary are kept as the first
 * chunk rather than dropped.
 */
function chunkText(text: string): Chunk[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  const firstContent = lines.findIndex((line) => line.trim() !== '');
  if (firstContent === -1) return [];

  const starts: number[] = [firstContent];
  for (let i = firstContent + 1; i < lines.length; i += 1) {
    if (HEADING_BOUNDARY.test(lines[i]) || LIST_BOUNDARY.test(lines[i])) {
      starts.push(i);
    }
  }

  const chunks: Chunk[] = [];
  for (let s = 0; s < starts.length; s += 1) {
    const start = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const body = lines.slice(start, end).join('\n').trimEnd();
    if (body === '') continue;
    chunks.push({ startLine: start + 1, body });
  }
  return chunks;
}

/** Title = first line's heading text, else the first line's first 60 chars. */
function titleOf(body: string): string {
  const firstLine = body.split('\n')[0] ?? '';
  const match = HEADING_TEXT.exec(firstLine);
  if (match) {
    const heading = match[1].trim();
    if (heading) return heading;
  }
  return firstLine.slice(0, MAX_TITLE_CHARS);
}

/** Map chunks to LinkItems; only the tail chunk is flagged when truncated. */
function buildItems(
  chunks: Chunk[],
  relPath: string,
  mtimeMs: number,
  truncated: boolean,
): LinkItem[] {
  const ts = new Date(mtimeMs).toISOString();
  return chunks.map((chunk, index) => {
    const item: LinkItem = {
      id: `${SOURCE}:${relPath}#L${chunk.startLine}`,
      source: SOURCE,
      type: 'ledger',
      title: titleOf(chunk.body),
      body: chunk.body,
      observations: [],
      relations: [],
      tags: [],
      ts,
      provenance: { path: relPath, line: chunk.startLine },
    };
    if (truncated && index === chunks.length - 1) item.truncated = true;
    return item;
  });
}

/** Read at most `cap` bytes from the start of a file (never the whole file). */
function readBounded(absPath: string, size: number, cap: number): Buffer {
  const want = Math.max(0, Math.min(cap, size));
  if (want === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(want);
  const fd = openSync(absPath, 'r');
  try {
    let total = 0;
    while (total < want) {
      const read = readSync(fd, buf, total, want - total, total);
      if (read <= 0) break;
      total += read;
    }
    return buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

interface Loaded {
  reachable: boolean;
  relPath: string;
  items: LinkItem[];
  revision: string;
}

const EMPTY_REVISION = createHash('sha256').update('').digest('hex');

export function createLedgerAdapter(opts: LedgerAdapterOptions): LinkAdapter {
  const { root, maxFileBytes } = opts;
  const file = opts.file ?? DEFAULT_FILE;

  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new Error(`ledger adapter root must be an absolute path: ${String(root)}`);
  }

  const absPath = join(root, file);
  const relPath = normalizeRel(relative(root, absPath), file);

  // Cache keyed on (mtime, size): a fresh read is only done when the file changes.
  let cache: { mtimeMs: number; size: number; loaded: Loaded } | undefined;

  const missing = (): Loaded => ({
    reachable: false,
    relPath,
    items: [],
    revision: EMPTY_REVISION,
  });

  const load = (): Loaded => {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(absPath);
      if (!st.isFile()) return missing();
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      return missing();
    }

    if (cache && cache.mtimeMs === mtimeMs && cache.size === size) {
      return cache.loaded;
    }

    const truncated = size > maxFileBytes;
    let text: string;
    try {
      const buf = truncated ? readBounded(absPath, size, maxFileBytes) : readFileSync(absPath);
      text = decodeText(buf).text;
    } catch {
      return missing();
    }

    const items = buildItems(chunkText(text), relPath, mtimeMs, truncated);
    const revision = createHash('sha256')
      .update(`${relPath}:${mtimeMs}:${size}`)
      .digest('hex');
    const loaded: Loaded = { reachable: true, relPath, items, revision };
    cache = { mtimeMs, size, loaded };
    return loaded;
  };

  const readById = (id: string): LinkItem | undefined => {
    if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return undefined;
    return load().items.find((item) => item.id === id);
  };

  return {
    id: SOURCE,
    label: { zh: '任务台账', en: 'Task Ledger' },

    async facts(): Promise<AdapterFacts> {
      const loaded = load();
      return {
        reachable: loaded.reachable,
        count: loaded.reachable ? loaded.items.length : 0,
        revision: loaded.revision,
      };
    },

    async search(q: string, limits: ScanLimits): Promise<LinkItem[]> {
      const query = q ?? '';
      const scored: { item: LinkItem; score: number; line: number }[] = [];
      for (const item of load().items) {
        const byTitle = titleHits(item.title, query);
        const byBody = matchSnippet(item.body, query, limits.maxCharacters).matched;
        if (!byTitle && !byBody) continue;
        scored.push({ item, score: byTitle ? 2 : 1, line: item.provenance.line ?? 0 });
      }
      scored.sort((a, b) => b.score - a.score || a.line - b.line);
      return takeWithinBudget(
        scored.map((s) => s.item),
        limits,
      );
    },

    async read(id: string): Promise<LinkItem | undefined> {
      return readById(id);
    },

    async list(limits: ScanLimits): Promise<LinkItem[]> {
      const all = [...load().items].sort(
        (a, b) =>
          tsValue(b.ts) - tsValue(a.ts) ||
          (a.provenance.line ?? 0) - (b.provenance.line ?? 0),
      );
      return takeWithinBudget(all, limits);
    },

    async graph(id: string): Promise<LinkRelation[]> {
      const item = readById(id);
      return item ? item.relations : [];
    },
  };
}
