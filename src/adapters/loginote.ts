// LogiNote adapter: a bounded, cache-backed, read-only view over a LogiNote
// vault of Markdown notes plus an optional metadata.json sidecar.
//
// READ-ONLY IRON RULE: this module only ever calls readFileSync on
// metadata.json. It never writes, creates, or deletes any file — especially not
// metadata.json. A missing or corrupt sidecar never throws; it degrades to
// "no metadata" and records a diagnostic.
//
// All directory traversal / bounding lives in scan.ts; this module only maps a
// ScanResult (augmented with metadata merges) into the LinkAdapter contract.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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

export interface LoginoteAdapterOptions {
  /** Vault directory. Must be an absolute path; a relative path throws. */
  root: string;
  /** metadata.json path. Defaults to `<root>/metadata.json`. */
  metadataPath?: string;
  maxFiles: number;
  /**
   * Per-file read ceiling. Captured once at factory creation and reused for
   * every scan so the cache's truncation boundary never shifts under it.
   */
  maxFileBytes: number;
}

const SOURCE = 'loginote' as const;
const ID_PREFIX = `${SOURCE}:`;
const METADATA_PREFIX = `${ID_PREFIX}metadata:`;

/** A metadata entry normalized to the few fields the adapter understands. */
interface MetaEntry {
  id: string;
  title?: string;
  /** Relative path with forward slashes, already normalized. */
  path?: string;
  type?: string;
  /** Raw due/dueDate/deadline text. */
  due?: string;
  tags: string[];
  /** updated/created timestamp text, if present. */
  ts?: string;
}

interface MetadataResult {
  entries: MetaEntry[];
  diagnostics: string[];
}

/** Normalize a path for comparison: forward slashes, no leading `./` or `/`. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Filename without its extension (relative path may use either separator). */
function fileStem(relPath: string): string {
  const base = relPath.split(/[\\/]/).pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v !== '');
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  return [];
}

/** First non-empty string among the given candidates. */
function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** Best-effort ISO normalization of a date-ish string; unparseable stays raw. */
function toIso(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

/**
 * Extract the raw entry list from any of the accepted metadata shapes:
 * - a top-level array of entries;
 * - `{ notes: [...] }` / `{ items: [...] }` / `{ tasks: [...] }`;
 * - an `id → object` map (any object of objects).
 * Returns `undefined` when no recognizable shape is present.
 */
function extractEntries(parsed: unknown): { id?: string; obj: unknown }[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed.map((obj) => ({ obj }));
  }
  if (parsed && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>;
    for (const key of ['notes', 'items', 'tasks'] as const) {
      const value = rec[key];
      if (Array.isArray(value)) return value.map((obj) => ({ obj }));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.entries(value as Record<string, unknown>).map(([id, obj]) => ({ id, obj }));
      }
    }
    const mapEntries: { id?: string; obj: unknown }[] = [];
    let sawObject = false;
    for (const [id, value] of Object.entries(rec)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sawObject = true;
        mapEntries.push({ id, obj: value });
      }
    }
    if (sawObject) return mapEntries;
  }
  return undefined;
}

/** Read metadata.json exactly once, read-only. Never throws. */
function loadMetadata(metadataPath: string): MetadataResult {
  let rawText: string;
  try {
    rawText = readFileSync(metadataPath, 'utf8');
  } catch {
    return { entries: [], diagnostics: [`metadata not readable: ${metadataPath}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Corrupt sidecar => treat as "no metadata", never propagate.
    return { entries: [], diagnostics: [`metadata not valid JSON: ${metadataPath}`] };
  }
  const rawEntries = extractEntries(parsed);
  if (rawEntries === undefined) {
    return { entries: [], diagnostics: [`metadata shape unrecognized: ${metadataPath}`] };
  }
  const entries: MetaEntry[] = [];
  rawEntries.forEach(({ id, obj }, index) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const rec = obj as Record<string, unknown>;
    const entry: MetaEntry = {
      id: pickString(rec.id, rec.key, id) ?? `entry-${index}`,
      title: pickString(rec.title, rec.name),
      path: pickString(rec.path, rec.file, rec.relativePath),
      type: pickString(rec.type),
      due: pickString(rec.due, rec.dueDate, rec.deadline),
      tags: toStringArray(rec.tags),
      ts: pickString(rec.updated, rec.created),
    };
    if (entry.path) entry.path = normPath(entry.path);
    entries.push(entry);
  });
  return { entries, diagnostics: [] };
}

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

/** Whether a metadata entry describes a task (explicit type or a due date). */
function entryIsTask(entry: MetaEntry): boolean {
  return entry.type === 'task' || (entry.due !== undefined && entry.due !== '');
}

/**
 * Accumulate items under a strict character budget (body length). Mirrors the
 * Obsidian adapter's `takeWithinBudget` (not exported there): the total body
 * characters never exceed `limits.maxCharacters`, the first item is always kept
 * (truncated copy flagged when it alone overflows), and later items are only
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

export function createLoginoteAdapter(opts: LoginoteAdapterOptions): LinkAdapter {
  const { root, maxFiles, maxFileBytes } = opts;

  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new Error(`loginote adapter root must be an absolute path: ${String(root)}`);
  }

  const metadataPath = opts.metadataPath ?? join(root, 'metadata.json');

  // One cache for the lifetime of the adapter: reused across every request.
  const cache: ScanCache = createScanCache();

  // Metadata is read once, read-only, at factory time. Diagnostics are retained
  // for debugging but never surfaced as errors and never affect `reachable`.
  const metadata = loadMetadata(metadataPath);
  const metadataEntries = metadata.entries;
  const metadataDiagnostics = metadata.diagnostics;
  void metadataDiagnostics;

  const parse = (file: ScannedFile, raw: string): LinkItem =>
    parseMarkdown({
      raw,
      relPath: file.relPath,
      source: SOURCE,
      type: 'note',
      mtimeMs: file.mtimeMs,
    });

  const scan = () => scanMarkdown(root, { maxFiles, maxFileBytes, parse, cache });

  /** Merge the read-only metadata sidecar onto the scanned Markdown items. */
  const items = (): LinkItem[] => {
    const base = scan()
      .files.map((f) => f.item)
      .filter((item): item is LinkItem => item !== undefined);

    // Copy each base item so cached entries are never mutated by metadata merges.
    const merged: LinkItem[] = base.map((item) => ({
      ...item,
      observations: [...item.observations],
      relations: [...item.relations],
      tags: [...item.tags],
    }));

    const byPath = new Map<string, LinkItem>();
    const byStem = new Map<string, LinkItem>();
    for (const item of merged) {
      byPath.set(normPath(item.provenance.path), item);
      const stem = fileStem(item.provenance.path).toLowerCase();
      if (!byStem.has(stem)) byStem.set(stem, item);
    }

    for (const entry of metadataEntries) {
      let target: LinkItem | undefined;
      if (entry.path) target = byPath.get(normPath(entry.path));
      if (!target && entry.title) target = byStem.get(entry.title.toLowerCase());

      if (target) {
        target.type = entryIsTask(entry) ? 'task' : 'note';
        for (const tag of entry.tags) {
          if (!target.tags.includes(tag)) target.tags.push(tag);
        }
        if (entry.due) target.observations.push({ category: 'due', text: toIso(entry.due) });
        if (entry.ts) target.ts = entry.ts;
      } else {
        merged.push({
          id: `${METADATA_PREFIX}${entry.id}`,
          source: SOURCE,
          type: 'task',
          title: entry.title ?? entry.id,
          body: '',
          observations: entry.due
            ? [{ category: 'due', text: toIso(entry.due) }]
            : [],
          relations: [],
          tags: [...entry.tags],
          ts: entry.ts ?? new Date(0).toISOString(),
          provenance: { path: '', kind: 'metadata' },
        });
      }
    }
    return merged;
  };

  const readById = (id: string): LinkItem | undefined => {
    if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return undefined;
    return items().find((item) => item.id === id);
  };

  return {
    id: SOURCE,
    label: { zh: 'LogiNote', en: 'LogiNote' },

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
