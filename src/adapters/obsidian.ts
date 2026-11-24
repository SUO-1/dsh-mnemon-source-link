// Obsidian adapter: a bounded, cache-backed, read-only view over a vault of
// Markdown notes. Never writes to disk. All traversal/bounding lives in
// scan.ts; this module only maps a ScanResult into the federated LinkAdapter
// contract (facts / search / read / list / graph).

import { isAbsolute } from 'node:path';
import type {
  AdapterFacts,
  LinkAdapter,
  LinkItem,
  LinkRelation,
  ScanLimits,
} from '../types.js';
import { matchSnippet, parseMarkdown } from '../markdown.js';
import {
  createScanCache,
  scanMarkdown,
  type ScanCache,
  type ScannedFile,
} from '../scan.js';

export interface ObsidianAdapterOptions {
  /** Vault root. Must be an absolute path; a relative path throws. */
  root: string;
  /** Directory names to skip at any depth (defaults to scan.ts defaults). */
  excludes?: string[];
  maxFiles: number;
  /**
   * Per-file read ceiling. Captured once at factory creation and reused for
   * every scan so the cache's truncation boundary never shifts under it.
   */
  maxFileBytes: number;
}

const SOURCE = 'obsidian' as const;
const ID_PREFIX = `${SOURCE}:`;

/** Case-insensitive title hit test; an empty query never counts as a hit. */
function titleHits(title: string, query: string): boolean {
  if (query.length === 0) return false;
  return title.toLowerCase().includes(query.toLowerCase());
}

/** Numeric timestamp for ordering; unparseable values sort as oldest. */
function tsValue(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Accumulate items under a strict character budget (body length).
 *
 * The total body characters returned never exceed `limits.maxCharacters`:
 * - `maxResults <= 0` or `maxCharacters <= 0` from the outset ⇒ empty array.
 * - The first item is always kept; if it alone exceeds the budget its body is
 *   sliced to the remaining characters and the copy is flagged `truncated`.
 *   (The cached item is never mutated.)
 * - Later items are included only when they fit the remaining budget; once the
 *   budget is exhausted iteration stops.
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
      // First item alone overflows: return a truncated copy within the budget.
      out.push({ ...item, body: item.body.slice(0, remaining), truncated: true });
      remaining = 0;
    } else {
      break;
    }
  }
  return out;
}

export function createObsidianAdapter(opts: ObsidianAdapterOptions): LinkAdapter {
  const { root, excludes, maxFiles, maxFileBytes } = opts;

  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new Error(`obsidian adapter root must be an absolute path: ${String(root)}`);
  }

  // One cache for the lifetime of the adapter: reused across every request.
  const cache: ScanCache = createScanCache();

  const parse = (file: ScannedFile, raw: string): LinkItem =>
    parseMarkdown({
      raw,
      relPath: file.relPath,
      source: SOURCE,
      type: 'note',
      mtimeMs: file.mtimeMs,
    });

  const scan = () =>
    scanMarkdown(root, { excludes, maxFiles, maxFileBytes, parse, cache });

  const items = (): LinkItem[] =>
    scan()
      .files.map((f) => f.item)
      .filter((item): item is LinkItem => item !== undefined);

  const readById = (id: string): LinkItem | undefined => {
    if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return undefined;
    const relPath = id.slice(ID_PREFIX.length);
    if (!relPath) return undefined;
    return items().find((item) => item.provenance.path === relPath);
  };

  return {
    id: SOURCE,
    label: { zh: 'Obsidian', en: 'Obsidian' },

    async facts(): Promise<AdapterFacts> {
      const result = scan();
      return { reachable: result.reachable, count: result.count, revision: result.revision };
    },

    async search(q: string, limits: ScanLimits): Promise<LinkItem[]> {
      const query = q ?? '';
      const scored: { item: LinkItem; score: number }[] = [];
      for (const item of items()) {
        const byTitle = titleHits(item.title, query);
        const byBody = matchSnippet(item.body, query, limits.maxCharacters).matched;
        if (!byTitle && !byBody) continue;
        scored.push({ item, score: byTitle ? 2 : 1 });
      }
      scored.sort((a, b) => b.score - a.score || tsValue(b.item.ts) - tsValue(a.item.ts));
      return takeWithinBudget(
        scored.map((s) => s.item),
        limits,
      );
    },

    async read(id: string): Promise<LinkItem | undefined> {
      return readById(id);
    },

    async list(limits: ScanLimits): Promise<LinkItem[]> {
      const all = items().sort((a, b) => tsValue(b.ts) - tsValue(a.ts));
      return takeWithinBudget(all, limits);
    },

    async graph(id: string): Promise<LinkRelation[]> {
      const item = readById(id);
      return item ? item.relations : [];
    },

    dispose(): void {
      cache.entries.clear();
    },
  };
}
