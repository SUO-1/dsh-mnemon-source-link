import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';
import { DEFAULT_MEMORY_VIEW_BUDGET } from 'dsh-mnemon/contracts';
import type { MemoryViewRoute } from 'dsh-mnemon/contracts';
import { createLinkMemorySource } from '../src/source';

const obsidianRoot = fileURLToPath(new URL('./fixtures/obsidian', import.meta.url));
const ledgerRoot = fileURLToPath(new URL('./fixtures/ledger', import.meta.url));
const DEFAULT_BUDGET = DEFAULT_MEMORY_VIEW_BUDGET;

const def = createLinkMemorySource({
  obsidian: { enabled: true, root: obsidianRoot },
  ledger: { enabled: true, root: ledgerRoot },
  loginote: { enabled: false, root: '' },
});

const rt = def.create({
  sourceInstanceKey: 'include:dsh-mnemon-source-link',
  provenance: { packageName: 'dsh-mnemon-source-link', entryId: 'test' },
  configuration: {},
});

const scope = { storage: 'workspace' as const, workspaceId: 'ws' };

/** Build a fully-populated MemoryViewRoute from a manifest route. */
function routeFor(id: string, sourceInstanceKey: string, readGrantId: string): MemoryViewRoute {
  const route = def.manifest.routes!.find((r) => r.id === id)!;
  return {
    ...route,
    id: route.id,
    sourceInstanceKey,
    sourceRouteId: route.id,
    readGrantId,
    description: route.description,
  };
}

test('manifest declares 4 described routes and no write capability', () => {
  expect(def.manifest.kind).toBe('source');
  expect(def.manifest.typeId).toBe('federated-link');
  expect(def.manifest.role).toBe('link');
  expect(def.manifest.routes?.map((r) => r.id)).toEqual(['search', 'read', 'browse', 'related']);
  expect(
    def.manifest.routes?.every(
      (r) => typeof r.description === 'string' && r.description.length > 0,
    ),
  ).toBe(true);
  expect(def.manifest.capabilities).not.toContain('write');
  expect(def.manifest.capabilities).not.toContain('forget');
  expect(def.manifest.capabilities).toEqual(
    expect.arrayContaining(['project', 'search', 'read', 'browse', 'related']),
  );
});

test('facts/project produce revision + readGrant; query search keeps provenance', async () => {
  const f = await rt.facts({ scope, scenario: 'agent.root-turn', budget: DEFAULT_BUDGET });
  expect(f.routeIds).toEqual(expect.arrayContaining(['search', 'read', 'browse', 'related']));
  expect(f.availability).toBe('ready');

  const proj = await rt.project({
    scope,
    sourceInstanceKey: f.sourceInstanceKey,
    expectedRevision: f.revision,
    includeProjection: true,
    mode: 'routed',
    maxCharacters: 4000,
  });
  expect(proj.readGrant).toBeDefined();
  expect(proj.readGrant!.value).toHaveProperty('allowedIds');
  const allowed = (proj.readGrant!.value as { allowedIds: string[] }).allowedIds;
  expect(allowed).toEqual(expect.arrayContaining(['obsidian:graph.md']));
  expect(proj.fragments.length).toBe(1);

  const route = routeFor('search', f.sourceInstanceKey, proj.readGrant!.id);
  const ev = await rt.query!({
    view: { id: 'v1', scope },
    route,
    grant: proj.readGrant!,
    input: { query: '图论' },
  });
  expect(ev.routeId).toBe('search');
  expect(ev.items.length).toBeGreaterThan(0);
  expect(ev.items[0].provenance).toMatchObject({ path: 'graph.md', source: 'obsidian' });
  expect(ev.items[0].id).toBe('obsidian:graph.md');
  expect(ev.truncated).toBe(false);
});

test('read outside grant throws', async () => {
  const f = await rt.facts({ scope, scenario: 'agent.root-turn', budget: DEFAULT_BUDGET });
  const proj = await rt.project({
    scope,
    sourceInstanceKey: f.sourceInstanceKey,
    expectedRevision: f.revision,
    includeProjection: false,
    mode: 'routed',
    maxCharacters: 4000,
  });
  const route = routeFor('read', f.sourceInstanceKey, proj.readGrant!.id);
  await expect(
    rt.query!({
      view: { id: 'v1', scope },
      route,
      grant: proj.readGrant!,
      input: { id: 'obsidian:不存在.md' },
    }),
  ).rejects.toThrow(/ReadGrant/);
});

test('browse lists allowed ids and related emits type → target', async () => {
  const f = await rt.facts({ scope, scenario: 'agent.root-turn', budget: DEFAULT_BUDGET });
  const proj = await rt.project({
    scope,
    sourceInstanceKey: f.sourceInstanceKey,
    expectedRevision: f.revision,
    includeProjection: false,
    mode: 'routed',
    maxCharacters: 4000,
  });
  const browse = await rt.query!({
    view: { id: 'v1', scope },
    route: routeFor('browse', f.sourceInstanceKey, proj.readGrant!.id),
    grant: proj.readGrant!,
    input: { source: 'obsidian' },
  });
  expect(browse.items.every((i) => i.id.startsWith('obsidian:'))).toBe(true);

  const related = await rt.query!({
    view: { id: 'v1', scope },
    route: routeFor('related', f.sourceInstanceKey, proj.readGrant!.id),
    grant: proj.readGrant!,
    input: { id: 'obsidian:graph.md' },
  });
  expect(related.items.some((i) => i.text.includes('→'))).toBe(true);
  expect(related.items[0].provenance).toMatchObject({ kind: 'relation', source: 'obsidian' });
});

test('project with a stale expectedRevision throws', async () => {
  const f = await rt.facts({ scope, scenario: 'agent.root-turn', budget: DEFAULT_BUDGET });
  await expect(
    rt.project({
      scope,
      sourceInstanceKey: f.sourceInstanceKey,
      expectedRevision: 'stale-revision',
      includeProjection: true,
      mode: 'routed',
      maxCharacters: 4000,
    }),
  ).rejects.toThrow(/revision/);
});
