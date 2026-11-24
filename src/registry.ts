// Adapter registry: aggregates the enabled federated Sources behind one
// contract, normalizes configuration, and dispatches per-item calls by the
// namespaced id prefix (`obsidian:` / `loginote:` / `ledger:`).
//
// Read-only orchestrator: it constructs the adapters, fans out every query with
// Promise.all, and re-applies the same strict character budget the adapters use
// so a merged result never exceeds `limits.maxCharacters`.

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type {
  AdapterFacts,
  LinkAdapter,
  LinkItem,
  LinkRelation,
  LinkSourceId,
  ScanLimits,
} from './types.js';
import { matchSnippet } from './markdown.js';
import { createObsidianAdapter } from './adapters/obsidian.js';
import { createLoginoteAdapter } from './adapters/loginote.js';
import { createLedgerAdapter } from './adapters/ledger.js';

export interface LinkSourceConfig {
  enabled: boolean;
  root: string;
  includes?: string[];
  excludes?: string[];
  /** Loginote metadata.json path (defaults to `<root>/metadata.json`). */
  metadataPath?: string;
  /** Ledger filename relative to root (defaults to `交接.md`). */
  file?: string;
}

export interface LinkConfig {
  obsidian: LinkSourceConfig;
  loginote: LinkSourceConfig;
  ledger: LinkSourceConfig;
  maxFiles: number;
  maxFileBytes: number;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export const DEFAULT_LINK_CONFIG: LinkConfig = {
  obsidian: { enabled: false, root: '' },
  loginote: { enabled: false, root: '' },
  ledger: { enabled: false, root: '' },
  maxFiles: DEFAULT_MAX_FILES,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
};

export interface RegistryFacts {
  reachable: boolean;
  count: number;
  revision: string;
  /**
   * Per-source facts. Only **enabled** sources appear here: a disabled source
   * has no key at all (it is not reported as `reachable: false`).
   */
  per: Partial<Record<LinkSourceId, AdapterFacts>>;
}

export interface LinkRegistry {
  readonly adapters: LinkAdapter[];
  facts(): Promise<RegistryFacts>;
  searchAll(q: string, limits: ScanLimits): Promise<LinkItem[]>;
  readItem(id: string): Promise<LinkItem | undefined>;
  listAll(limits: ScanLimits): Promise<LinkItem[]>;
  graph(id: string): Promise<LinkRelation[]>;
  allIds(): Promise<string[]>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v));
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * An enabled source must point at an absolute root. An empty root is just as
 * invalid as a relative one: both are configuration mistakes that would
 * otherwise be silently skipped. Disabled sources are never validated.
 */
function assertEnabledRoot(id: LinkSourceId, root: string): void {
  if (isAbsolute(root)) return;
  throw new Error(
    `dsh-mnemon-source-link: enabled ${id} source requires an absolute root path, got "${root}". ` +
      `Set an absolute path (for example "C:\\Users\\me\\vault") or set enabled:false for this source.`,
  );
}

function normalizeSource(
  raw: unknown,
  id: LinkSourceId,
  defaults: LinkSourceConfig,
): LinkSourceConfig {
  const rec = asRecord(raw);
  const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : defaults.enabled;
  const root = typeof rec.root === 'string' ? rec.root : defaults.root;

  // An enabled source with a relative *or empty* root is rejected loudly: a
  // relative root depends on the process cwd, an empty root means "forgot to
  // configure me". Neither may slip through as a silently skipped source.
  if (enabled) assertEnabledRoot(id, root);

  const out: LinkSourceConfig = { enabled, root };
  const includes = asStringArray(rec.includes);
  if (includes !== undefined) out.includes = includes;
  const excludes = asStringArray(rec.excludes);
  if (excludes !== undefined) out.excludes = excludes;
  if (typeof rec.metadataPath === 'string' && rec.metadataPath.trim() !== '') {
    out.metadataPath = rec.metadataPath;
  }
  if (typeof rec.file === 'string' && rec.file.trim() !== '') {
    out.file = rec.file;
  }
  return out;
}

/** Fill every missing field from `DEFAULT_LINK_CONFIG`; validate enabled roots. */
export function normalizeLinkConfig(raw: unknown): LinkConfig {
  const rec = asRecord(raw);
  return {
    obsidian: normalizeSource(rec.obsidian, 'obsidian', DEFAULT_LINK_CONFIG.obsidian),
    loginote: normalizeSource(rec.loginote, 'loginote', DEFAULT_LINK_CONFIG.loginote),
    ledger: normalizeSource(rec.ledger, 'ledger', DEFAULT_LINK_CONFIG.ledger),
    maxFiles: asPositiveInt(rec.maxFiles, DEFAULT_LINK_CONFIG.maxFiles),
    maxFileBytes: asPositiveInt(rec.maxFileBytes, DEFAULT_LINK_CONFIG.maxFileBytes),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers (mirror the adapters' ranking/budget semantics)
// ---------------------------------------------------------------------------

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
 * Accumulate items under a strict character budget (body length). Identical to
 * the adapters' `takeWithinBudget`: the total body characters never exceed
 * `limits.maxCharacters`, the first item is always kept (a truncated copy is
 * flagged when it alone overflows), and later items are only included while
 * they fit.
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

function concat<T>(groups: T[][]): T[] {
  const out: T[] = [];
  for (const group of groups) for (const item of group) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function createRegistry(config: LinkConfig): LinkRegistry {
  const adapters: LinkAdapter[] = [];

  // Enabled sources must resolve to an absolute root; an enabled-but-unusable
  // source is a configuration error, never a silently skipped one.
  if (config.obsidian.enabled) {
    assertEnabledRoot('obsidian', config.obsidian.root);
    adapters.push(
      createObsidianAdapter({
        root: config.obsidian.root,
        excludes: config.obsidian.excludes,
        maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes,
      }),
    );
  }
  if (config.loginote.enabled) {
    assertEnabledRoot('loginote', config.loginote.root);
    adapters.push(
      createLoginoteAdapter({
        root: config.loginote.root,
        metadataPath: config.loginote.metadataPath,
        maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes,
      }),
    );
  }
  if (config.ledger.enabled) {
    assertEnabledRoot('ledger', config.ledger.root);
    adapters.push(
      createLedgerAdapter({
        root: config.ledger.root,
        file: config.ledger.file,
        maxFileBytes: config.maxFileBytes,
      }),
    );
  }

  /** Resolve the adapter that owns a namespaced id, if any. */
  const dispatch = (id: string): LinkAdapter | undefined => {
    if (typeof id !== 'string') return undefined;
    for (const adapter of adapters) {
      if (id.startsWith(`${adapter.id}:`)) return adapter;
    }
    return undefined;
  };

  const registry: LinkRegistry = {
    adapters,

    async facts(): Promise<RegistryFacts> {
      const entries = await Promise.all(
        adapters.map(async (adapter) => [adapter.id, await adapter.facts()] as const),
      );
      const per: Partial<Record<LinkSourceId, AdapterFacts>> = {};
      let count = 0;
      let reachable = false;
      for (const [id, facts] of entries) {
        per[id] = facts;
        count += facts.count;
        reachable = reachable || facts.reachable;
      }
      // Stable hash over the per-source revisions, independent of adapter order.
      const revision = createHash('sha256')
        .update(
          JSON.stringify(
            Object.entries(per)
              .map(([key, value]) => [key, value.revision])
              .sort(),
          ),
        )
        .digest('hex');
      return { reachable, count, revision, per };
    },

    async searchAll(q: string, limits: ScanLimits): Promise<LinkItem[]> {
      const query = q ?? '';
      const groups = await Promise.all(adapters.map((adapter) => adapter.search(query, limits)));
      const seen = new Set<string>();
      const scored: { item: LinkItem; score: number }[] = [];
      for (const item of concat(groups)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const byTitle = titleHits(item.title, query);
        const byBody = matchSnippet(item.body, query, limits.maxCharacters).matched;
        if (!byTitle && !byBody) continue;
        scored.push({ item, score: byTitle ? 2 : 1 });
      }
      scored.sort((a, b) => b.score - a.score || tsValue(b.item.ts) - tsValue(a.item.ts));
      return takeWithinBudget(
        scored.map((entry) => entry.item),
        limits,
      );
    },

    async readItem(id: string): Promise<LinkItem | undefined> {
      const adapter = dispatch(id);
      return adapter ? adapter.read(id) : undefined;
    },

    async listAll(limits: ScanLimits): Promise<LinkItem[]> {
      const groups = await Promise.all(adapters.map((adapter) => adapter.list(limits)));
      const seen = new Set<string>();
      const unique: LinkItem[] = [];
      for (const item of concat(groups)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        unique.push(item);
      }
      unique.sort((a, b) => tsValue(b.ts) - tsValue(a.ts));
      return takeWithinBudget(unique, limits);
    },

    async graph(id: string): Promise<LinkRelation[]> {
      const adapter = dispatch(id);
      return adapter ? adapter.graph(id) : [];
    },

    async allIds(): Promise<string[]> {
      // A budget wide enough that no adapter truncates: every candidate id is
      // returned for the readGrant whitelist.
      const wide: ScanLimits = {
        maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes,
        maxResults: Number.MAX_SAFE_INTEGER,
        maxCharacters: Number.MAX_SAFE_INTEGER,
      };
      const groups = await Promise.all(adapters.map((adapter) => adapter.list(wide)));
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const item of concat(groups)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        ids.push(item.id);
      }
      return ids;
    },

    dispose(): void {
      for (const adapter of adapters) adapter.dispose?.();
    },
  };

  return registry;
}
