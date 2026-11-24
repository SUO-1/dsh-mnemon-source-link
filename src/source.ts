// The `dsh-mnemon` Composable Memory Source for dsh-mnemon-source-link.
//
// Bridges the three read-only adapters (Obsidian / LogiNote / task ledger),
// aggregated behind `src/registry.ts`, into the host contract via
// `defineMemorySource`. One manifest with four described, read-only routes
// (search / read / browse / related) plus a create() runtime exposing
// facts / project / query / dispose.
//
// Read-only IRON RULE: this Source never writes anything. The read grant it
// issues is an exact-snapshot whitelist (`allowedIds`) that `query` enforces —
// any id outside the grant is rejected before the adapter is touched.

import { randomUUID } from 'node:crypto';
import {
  defineMemorySource,
  memoryInputRecord,
  memoryInputText,
  truncateMemoryText,
} from 'dsh-mnemon/extension-sdk';
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts';
import type {
  MemoryEvidence,
  MemoryEvidenceItem,
  MemoryJsonValue,
  MemoryProjectionRequest,
  MemoryReadGrant,
  MemorySourceDefinition,
  MemorySourceFacts,
  MemorySourceManifest,
  MemoryViewRequest,
} from 'dsh-mnemon/contracts';
import {
  createRegistry,
  normalizeLinkConfig,
  type LinkConfig,
  type LinkRegistry,
  type RegistryFacts,
} from './registry.js';
import type { LinkItem, LinkSourceId, ScanLimits } from './types.js';
import { matchSnippet } from './markdown.js';

export const LINK_SOURCE_TYPE_ID = 'federated-link';
export const LINK_SOURCE_ROLE = 'link';
export const LINK_CAPABILITIES = ['project', 'search', 'read', 'browse', 'related'] as const;

const ROUTE_IDS = ['search', 'read', 'browse', 'related'] as const;

const LINK_MANIFEST: MemorySourceManifest = {
  apiVersion: COMPOSABLE_MEMORY_API_VERSION,
  kind: 'source',
  typeId: LINK_SOURCE_TYPE_ID,
  packageName: 'dsh-mnemon-source-link',
  role: LINK_SOURCE_ROLE,
  capabilities: [...LINK_CAPABILITIES],
  consistency: 'exact-snapshot',
  routes: [
    {
      id: 'search',
      description: 'Search Obsidian / LogiNote / ledger entries pinned into this View.',
      capability: 'search',
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      },
      maxCalls: 2,
      maxResults: 12,
      maxCharacters: 12000,
    },
    {
      id: 'read',
      description: 'Read one federated entry (note / task / ledger item) by id.',
      capability: 'read',
      inputSchema: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: { id: { type: 'string' } },
      },
      maxCalls: 4,
      maxResults: 1,
      maxCharacters: 8000,
    },
    {
      id: 'browse',
      description: 'List recent federated entries, optionally filtered by source.',
      capability: 'browse',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { source: { type: 'string' } },
      },
      maxCalls: 2,
      maxResults: 20,
      maxCharacters: 6000,
    },
    {
      id: 'related',
      description: 'List relations / backlinks declared by one federated entry.',
      capability: 'related',
      inputSchema: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: { id: { type: 'string' } },
      },
      maxCalls: 2,
      maxResults: 10,
      maxCharacters: 4000,
    },
  ],
  management: {
    label: '记忆联动',
    description: '联邦只读记忆源（Obsidian / LogiNote / 台账）',
  },
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function scopeKey(scope: { storage: string; workspaceId?: string; sessionId?: string }): string {
  return `${scope.storage}:${scope.workspaceId ?? ''}:${scope.sessionId ?? ''}`;
}

/** Per-source entry counts keyed by source id (only enabled sources appear). */
function countsOf(facts: RegistryFacts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(facts.per)) {
    out[id] = value ? value.count : 0;
  }
  return out;
}

/** No usable source ⇒ unavailable; any unreachable source ⇒ degraded; else ready. */
function availabilityOf(
  facts: RegistryFacts,
  adapterCount: number,
): 'ready' | 'degraded' | 'unavailable' {
  if (!facts.reachable || adapterCount === 0) return 'unavailable';
  return Object.values(facts.per).every((value) => value?.reachable === true)
    ? 'ready'
    : 'degraded';
}

/** Read the whitelist out of an exact-snapshot read grant, defensively. */
function grantAllowedIds(grant: MemoryReadGrant): string[] {
  const value = grant.value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const ids = (value as Record<string, MemoryJsonValue>).allowedIds;
    if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
  }
  return [];
}

/** Read the per-source counts embedded into the read grant, defensively. */
function grantCounts(grant: MemoryReadGrant): Record<string, number> {
  const value = grant.value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const counts = (value as Record<string, MemoryJsonValue>).counts;
    if (counts !== null && typeof counts === 'object' && !Array.isArray(counts)) {
      const out: Record<string, number> = {};
      for (const [key, entry] of Object.entries(counts)) {
        if (typeof entry === 'number') out[key] = entry;
      }
      return out;
    }
  }
  return {};
}

/** Provenance carrying at least { kind, source, path, line? }. */
function provenanceFor(kind: string, item: LinkItem): MemoryJsonValue {
  const provenance: Record<string, MemoryJsonValue> = {
    kind,
    source: item.source,
    path: item.provenance.path,
  };
  if (item.provenance.line !== undefined) provenance.line = item.provenance.line;
  return provenance;
}

/**
 * Derive the source-relative file path carried inside a namespaced item id.
 * Ids look like `obsidian:<relPath>` / `loginote:<relPath>` /
 * `ledger:<relPath>#L<line>`, so drop the `<source>:` prefix and any trailing
 * `#L<line>` fragment. The `related` route synthesizes evidence from a related
 * entry id rather than a parsed LinkItem, so it needs this to satisfy the spec
 * §13 rule that every route's evidence carries a path.
 */
function filePathFromId(id: string, source: string): string {
  const prefix = `${source}:`;
  const rest = id.startsWith(prefix) ? id.slice(prefix.length) : id;
  return rest.replace(/#L\d+$/, '');
}

const SOURCE_LABELS: Record<LinkSourceId, string> = {
  obsidian: 'Obsidian',
  loginote: 'LogiNote',
  ledger: '台账',
};

/** Human-readable projection: per-source counts + the most recent titles. */
function indexCard(facts: RegistryFacts, recentTitles: string[]): string {
  const counts = countsOf(facts);
  const lines: string[] = ['记忆联动 · 联邦只读记忆源'];
  for (const id of ['obsidian', 'loginote', 'ledger'] as const) {
    if (id in counts) lines.push(`- ${SOURCE_LABELS[id]}: ${counts[id]} 条`);
  }
  if (recentTitles.length > 0) {
    lines.push('最近条目：');
    for (const title of recentTitles) lines.push(`- ${title}`);
  }
  return truncateMemoryText(lines.join('\n'), 4000);
}

// ---------------------------------------------------------------------------
// Source definition
// ---------------------------------------------------------------------------

export function createLinkMemorySource(config: Partial<LinkConfig> = {}): MemorySourceDefinition {
  return defineMemorySource({
    manifest: LINK_MANIFEST,
    create(context) {
      const effective = normalizeLinkConfig({ ...context.configuration, ...config });
      const registry: LinkRegistry = createRegistry(effective);
      const snapshots = new Map<string, { revision: string; facts: RegistryFacts }>();

      const limits = (maxResults: number, maxCharacters: number): ScanLimits => ({
        maxFiles: effective.maxFiles,
        maxFileBytes: effective.maxFileBytes,
        maxResults,
        maxCharacters,
      });

      return {
        async facts(request: MemoryViewRequest): Promise<MemorySourceFacts> {
          const f = await registry.facts();
          snapshots.set(scopeKey(request.scope), { revision: f.revision, facts: f });
          return {
            sourceInstanceKey: context.sourceInstanceKey,
            sourceTypeId: LINK_SOURCE_TYPE_ID,
            role: LINK_SOURCE_ROLE,
            availability: availabilityOf(f, registry.adapters.length),
            revision: f.revision,
            capabilities: [...LINK_CAPABILITIES],
            routeIds: [...ROUTE_IDS],
            actionIds: [],
            hints: { counts: countsOf(f) },
          };
        },

        async project(request: MemoryProjectionRequest) {
          const snap = snapshots.get(scopeKey(request.scope));
          if (!snap || snap.revision !== request.expectedRevision) {
            throw new Error('federated-link projection revision changed during composition');
          }

          const allowedIds = await registry.allIds();
          const counts = countsOf(snap.facts);
          const readGrant: MemoryReadGrant = {
            id: `${context.sourceInstanceKey}/grant/${snap.revision}`,
            sourceInstanceKey: context.sourceInstanceKey,
            schema: 'dsh-mnemon.federated-link/v1',
            value: { allowedIds, counts },
            revision: snap.revision,
            consistency: 'exact-snapshot',
          };

          // Recent items feed both the presentation list and the index card.
          const recent = await registry.listAll(limits(24, Number.MAX_SAFE_INTEGER));
          const presentationItems = recent.map((item) => ({
            id: item.id,
            title: truncateMemoryText(item.title, 120),
          }));

          const fragments = request.includeProjection
            ? [
                {
                  id: `${context.sourceInstanceKey}/projection`,
                  sourceInstanceKey: context.sourceInstanceKey,
                  mode: request.mode,
                  text: truncateMemoryText(
                    indexCard(
                      snap.facts,
                      recent.slice(0, 5).map((item) => item.title),
                    ),
                    request.maxCharacters,
                  ),
                  revision: snap.revision,
                  provenance: { sourceTypeId: LINK_SOURCE_TYPE_ID },
                },
              ]
            : [];

          return {
            fragments,
            readGrant,
            presentation: {
              visibleItems: allowedIds.length,
              totalItems: allowedIds.length,
              items: presentationItems,
            },
          };
        },

        async query(request): Promise<MemoryEvidence> {
          // browse accepts an all-optional payload (including null/undefined);
          // note memoryInputRecord(null) would throw, so normalize those to {}.
          const input: Record<string, MemoryJsonValue> =
            request.input === null || request.input === undefined
              ? {}
              : memoryInputRecord(request.input, 'federated-link input');
          const allowed = grantAllowedIds(request.grant);
          const budget = request.route.maxCharacters ?? Number.MAX_SAFE_INTEGER;

          const items: MemoryEvidenceItem[] = [];
          let truncated = false;
          let remaining = budget;
          let queryText: string | undefined;

          // Enforce the strict per-route character ceiling while appending.
          const push = (item: MemoryEvidenceItem): void => {
            if (remaining <= 0) {
              truncated = true;
              return;
            }
            let text = item.text;
            if (text.length > remaining) {
              text = truncateMemoryText(text, remaining);
              truncated = true;
            }
            items.push({ ...item, text });
            remaining -= text.length;
          };

          // `request.route` is a composed `MemoryViewRoute`: its `id` is the View
          // Route id, namespaced by the Source instance key (`source:link/search`).
          // Dispatch on the Source's own route id — anything else falls through
          // to `default` and silently returns empty evidence inside a real View.
          switch (request.route.sourceRouteId) {
            case 'search': {
              const q = memoryInputText(input.query, 'query', 2000, false) ?? '';
              queryText = q;
              // Clamp `limit` to [1, route.maxResults] instead of throwing: the
              // host schema only constrains "integer", so a reasonable limit:20
              // must not brick the route. Non-integers fall back to 10.
              const rawLimit =
                typeof input.limit === 'number' && Number.isInteger(input.limit)
                  ? input.limit
                  : 10;
              const limit = Math.min(request.route.maxResults ?? 12, Math.max(1, rawLimit));
              const hits = await registry.searchAll(q, limits(limit, budget));
              for (const item of hits) {
                if (items.length >= limit || remaining <= 0) break;
                if (!allowed.includes(item.id)) continue;
                const byTitle = q.length > 0 && item.title.toLowerCase().includes(q.toLowerCase());
                const snippet = matchSnippet(item.body, q, remaining);
                push({
                  id: item.id,
                  text: `${item.title}\n${snippet.text}`,
                  provenance: provenanceFor('match', item),
                  score: byTitle ? 2 : 1,
                });
              }
              break;
            }

            case 'read': {
              // memoryInputText is required ⇒ `id` is present at runtime and an
              // absent id already throws there; the `undefined` arm only keeps
              // the type narrowed for `allowed.includes`.
              const id = memoryInputText(input.id, 'id', 300);
              if (id === undefined || !allowed.includes(id)) {
                throw new Error('federated-link read outside this View ReadGrant');
              }
              const item = await registry.readItem(id);
              if (!item) {
                return {
                  id: `evidence:${randomUUID()}`,
                  viewId: request.view.id,
                  routeId: request.route.id,
                  sourceInstanceKey: context.sourceInstanceKey,
                  observedAt: new Date().toISOString(),
                  truncated: false,
                  items: [],
                  unavailable: 'not-found',
                  metadata: { counts: grantCounts(request.grant) },
                };
              }
              const text = truncateMemoryText(item.body, budget);
              if (text.length < item.body.length) truncated = true;
              push({ id: item.id, text, provenance: provenanceFor('read', item) });
              break;
            }

            case 'browse': {
              const src = memoryInputText(input.source, 'source', 20, false) as
                | LinkSourceId
                | undefined;
              const cap = request.route.maxResults ?? 20;
              const listed = await registry.listAll(limits(cap, budget));
              for (const item of listed) {
                if (items.length >= cap || remaining <= 0) break;
                if (!allowed.includes(item.id)) continue;
                if (src !== undefined && item.source !== src) continue;
                push({
                  id: item.id,
                  text: `${item.title}\n${matchSnippet(item.body, '', remaining).text}`,
                  provenance: provenanceFor('browse', item),
                });
              }
              break;
            }

            case 'related': {
              // memoryInputText is required ⇒ `id` is present at runtime and an
              // absent id already throws there; the `undefined` arm only keeps
              // the type narrowed for the whitelist check.
              const id = memoryInputText(input.id, 'id', 300);
              // Enforce the ReadGrant whitelist BEFORE touching the adapter: an
              // out-of-grant id must never leak relations.
              if (id === undefined || !allowed.includes(id)) {
                throw new Error('federated-link related outside this View ReadGrant');
              }
              const relations = await registry.graph(id);
              const source = id.slice(0, Math.max(0, id.indexOf(':'))) as LinkSourceId;
              const sourcePath = filePathFromId(id, source);
              const cap = request.route.maxResults ?? 10;
              for (let n = 0; n < relations.length && items.length < cap; n += 1) {
                if (remaining <= 0) break;
                const rel = relations[n];
                push({
                  id: `${id}#rel:${n}`,
                  text: `${rel.type} → ${rel.target}`,
                  provenance: { kind: 'relation', source, path: sourcePath },
                });
              }
              break;
            }

            default:
              break;
          }

          const metadata: Record<string, MemoryJsonValue> = {
            counts: grantCounts(request.grant),
          };
          if (queryText !== undefined) metadata.query = queryText;

          return {
            id: `evidence:${randomUUID()}`,
            viewId: request.view.id,
            routeId: request.route.id,
            sourceInstanceKey: context.sourceInstanceKey,
            observedAt: new Date().toISOString(),
            truncated,
            items,
            metadata,
          };
        },

        dispose(): void {
          registry.dispose();
          snapshots.clear();
        },
      };
    },
  });
}
