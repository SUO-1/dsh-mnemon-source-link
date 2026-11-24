// Composition integration test: drives the real `dsh-mnemon` Runtime through
// `MemoryCompositionRunner` (contribution install → View compose → Route
// execution) instead of calling the Source definition by hand.
//
// This plugin only contributes a **Source** (`roles: ['source']`), and a View
// cannot be composed without a **Strategy**. To keep the test self-contained
// (no external Strategy package to resolve), this file installs an inline,
// deterministic test Strategy that admits every installed Source with all of
// the read Routes it exposes. It selects no ActionOffers on purpose: the
// federated Source is read-only.
//
// Two Runtime details the assertions below encode explicitly:
//   * View Route ids are namespaced by Source instance key
//     (`source:link/search`), so the raw Source route id is `sourceRouteId`.
//   * `MemoryStrategyManifest.maxActions` must be ≥ 1 (0 is rejected by
//     `defineMemoryStrategy`), even when the Strategy offers no Action.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';
import { MemoryCompositionRunner } from 'dsh-mnemon/testing';
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk';
import {
  COMPOSABLE_MEMORY_API_VERSION,
  type ComposableMemoryView,
  type MemoryViewRoute,
} from 'dsh-mnemon/contracts';
import type { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/index';

const obsidianRoot = fileURLToPath(new URL('./fixtures/obsidian', import.meta.url));
const loginoteRoot = fileURLToPath(new URL('./fixtures/loginote', import.meta.url));
const ledgerRoot = fileURLToPath(new URL('./fixtures/ledger', import.meta.url));

/** All three federated Sources enabled against the checked-in fixtures. */
const FIXTURE_CONFIG = {
  obsidian: { enabled: true, root: obsidianRoot },
  loginote: { enabled: true, root: loginoteRoot },
  ledger: { enabled: true, root: ledgerRoot },
  maxFiles: 5000,
  maxFileBytes: 1_048_576,
};

const STRATEGY_TYPE_ID = 'test-sole';
const STRATEGY_INSTANCE_ID = 'test-strategy';
const LINK_INSTANCE_ID = 'link';

const READ_CAPABILITIES = ['search', 'read', 'browse', 'related'] as const;

// ---------------------------------------------------------------------------
// Inline test Strategy (no external Strategy package)
// ---------------------------------------------------------------------------

const testStrategy = defineMemoryStrategy({
  manifest: {
    apiVersion: COMPOSABLE_MEMORY_API_VERSION,
    kind: 'strategy',
    typeId: STRATEGY_TYPE_ID,
    packageName: 'dsh-mnemon-source-link',
    deterministic: true,
    // This plugin's Source declares role 'link', which the wildcard admits.
    supportedSourceRoles: ['*'],
    maxSources: 10,
    maxRoutes: 20,
    // The runtime requires ≥ 1 here even though we select zero Actions.
    maxActions: 1,
  },
  compose(_request, sources) {
    return {
      strategyTypeId: STRATEGY_TYPE_ID,
      explanation: 'Test Strategy: admit every installed Source with all of its read Routes.',
      sources: sources.map((source) => ({
        sourceInstanceKey: source.sourceInstanceKey,
        routeIds: source.routes.map((route) => route.id),
        actionIds: [],
      })),
    };
  },
});

const testStrategyPlugin = {
  name: 'test-sole-strategy',
  inject: ['mnemonMemory'],
  apply(ctx: Context): void {
    installMemory(ctx, { strategies: [testStrategy] });
  },
};

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

type MountablePlugin = Parameters<MemoryCompositionRunner['mount']>[0];

interface ComposedHarness {
  readonly runner: MemoryCompositionRunner;
  readonly turn: Awaited<ReturnType<MemoryCompositionRunner['beginTurn']>>;
  /** Release the turn and unmount both contributions. */
  close(): Promise<void>;
}

/** Mount the inline Strategy + this plugin into a fresh runtime and compose a View. */
async function composeHarness(config: object): Promise<ComposedHarness> {
  const runner = new MemoryCompositionRunner({
    strategyTypeId: STRATEGY_TYPE_ID,
    strategyFallback: 'sole-strategy',
  });
  let disposeStrategy: (() => Promise<void>) | undefined;
  let disposeLink: (() => Promise<void>) | undefined;
  let turn: ComposedHarness['turn'] | undefined;
  try {
    disposeStrategy = await runner.mount(testStrategyPlugin, { instanceId: STRATEGY_INSTANCE_ID });
    disposeLink = await runner.mount(plugin as unknown as MountablePlugin, {
      instanceId: LINK_INSTANCE_ID,
      config,
    });
    turn = await runner.beginTurn();
  } catch (error) {
    await turn?.release();
    await disposeLink?.();
    await disposeStrategy?.();
    await runner.dispose();
    throw error;
  }
  const composed = turn;
  return {
    runner,
    turn: composed,
    async close() {
      composed.release();
      await disposeLink?.();
      await disposeStrategy?.();
      await runner.dispose();
    },
  };
}

/** Resolve a View Route by its Source route id (`search` / `read` / …). */
function viewRoute(view: ComposableMemoryView, sourceRouteId: string): MemoryViewRoute {
  const route = view.routes.find((candidate) => candidate.sourceRouteId === sourceRouteId);
  if (route === undefined) throw new Error(`View has no route: ${sourceRouteId}`);
  return route;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(
  'composed View exposes the four read routes, keeps provenance, and offers no write Action',
  async () => {
    const harness = await composeHarness(FIXTURE_CONFIG);
    const { runner, turn } = harness;
    try {
      // Composition genuinely happened: one serving generation, composed from
      // this plugin's Source plus the inline Strategy, with zero diagnostics.
      const diagnostics = runner.inspect();
      expect(diagnostics.evaluation.state).toBe('ready');
      expect(diagnostics.evaluation.diagnostics).toEqual([]);
      expect(diagnostics.evaluation.strategyInstanceKey).toBe(
        `strategy:${STRATEGY_INSTANCE_ID}`,
      );
      expect(diagnostics.evaluation.sourceInstanceKeys).toHaveLength(1);
      expect(diagnostics.evaluation.sourceInstanceKeys[0]).toBe(`source:${LINK_INSTANCE_ID}`);
      expect(diagnostics.servingGenerationId).toMatch(/^generation:/);
      const sourceKey = diagnostics.evaluation.sourceInstanceKeys[0]!;

      // Routes: four read-only routes, namespaced by the Source instance key.
      expect(turn.view.strategyTypeId).toBe(STRATEGY_TYPE_ID);
      expect(turn.view.routes).toHaveLength(READ_CAPABILITIES.length);
      expect(turn.view.routes.map((route) => route.sourceRouteId)).toEqual(
        expect.arrayContaining([...READ_CAPABILITIES]),
      );
      expect(turn.view.routes.map((route) => route.capability)).toEqual(
        expect.arrayContaining([...READ_CAPABILITIES]),
      );
      expect(turn.view.routes.every((route) => route.id === `${sourceKey}/${route.sourceRouteId}`))
        .toBe(true);

      // Read-only IRON RULE: no ActionOffer at all, and no write capability.
      expect(turn.view.actionOffers).toHaveLength(0);
      for (const capability of ['write', 'archive', 'forget', 'import', 'maintain'] as const) {
        expect(turn.view.routes.some((route) => route.capability === capability)).toBe(false);
      }

      // The exact-snapshot ReadGrant spans all three fixtures.
      expect(turn.view.readGrants).toHaveLength(1);
      const grant = turn.view.readGrants[0]!;
      expect(grant.sourceInstanceKey).toBe(sourceKey);
      expect(grant.consistency).toBe('exact-snapshot');
      const allowedIds = (grant.value as { allowedIds: string[] }).allowedIds;
      expect(allowedIds).toEqual(
        expect.arrayContaining(['obsidian:graph.md', 'loginote:vault/day01.md']),
      );
      expect(allowedIds.some((id) => id.startsWith('ledger:'))).toBe(true);
      const presentations = turn.view.sourcePresentations ?? [];
      expect(presentations[0]?.visibleItems).toBe(allowedIds.length);

      // Route execution through the Runtime: search keeps provenance.
      const search = await turn.executeRoute(viewRoute(turn.view, 'search').id, { query: '图论' });
      expect(search.routeId).toBe(`${sourceKey}/search`);
      expect(search.sourceInstanceKey).toBe(sourceKey);
      expect(search.truncated).toBe(false);
      expect(search.items.length).toBeGreaterThan(0);
      expect(search.items[0]!.id).toBe('obsidian:graph.md');
      expect(search.items[0]!.provenance).toMatchObject({
        kind: 'match',
        source: 'obsidian',
        path: 'graph.md',
      });

      // browse aggregates all three Sources behind the one Source instance.
      const browse = await turn.executeRoute(viewRoute(turn.view, 'browse').id, {});
      const prefixes = new Set(browse.items.map((item) => item.id.split(':')[0]));
      expect([...prefixes].sort()).toEqual(['ledger', 'loginote', 'obsidian']);

      // read / related work inside the grant and keep their provenance.
      const read = await turn.executeRoute(viewRoute(turn.view, 'read').id, {
        id: 'obsidian:graph.md',
      });
      expect(read.items[0]!.text).toContain('图论');
      expect(read.items[0]!.provenance).toMatchObject({ kind: 'read', path: 'graph.md' });

      const related = await turn.executeRoute(viewRoute(turn.view, 'related').id, {
        id: 'obsidian:graph.md',
      });
      expect(related.items.some((item) => item.text.includes('→'))).toBe(true);

      // Management catalog still sees the Source instance and its descriptor.
      const catalog = await runner.managementCatalog();
      expect(catalog.sources.map((source) => source.sourceInstanceKey)).toEqual([sourceKey]);
      expect(catalog.sources[0]!.management.label).toBe('记忆联动');
      expect(catalog.sources[0]!.role).toBe('link');
    } finally {
      await harness.close();
    }
  },
  20_000,
);

test(
  'read outside the View ReadGrant is rejected by the Runtime',
  async () => {
    const harness = await composeHarness(FIXTURE_CONFIG);
    const { turn } = harness;
    try {
      const sourceKey = turn.view.routes[0]!.sourceInstanceKey;
      // A path that exists nowhere in the fixtures and is absent from the grant.
      await expect(
        turn.executeRoute(viewRoute(turn.view, 'read').id, { id: 'obsidian:not-in-grant.md' }),
      ).rejects.toThrow(/ReadGrant/);

      // `related` enforces the same whitelist before touching any adapter.
      await expect(
        turn.executeRoute(viewRoute(turn.view, 'related').id, { id: 'obsidian:not-in-grant.md' }),
      ).rejects.toThrow(/ReadGrant/);

      // Sanity check: the same route succeeds for an id that IS in the grant.
      const inside = await turn.executeRoute(viewRoute(turn.view, 'read').id, {
        id: 'obsidian:graph.md',
      });
      expect(inside.sourceInstanceKey).toBe(sourceKey);
      expect(inside.items).toHaveLength(1);
      expect(inside.items[0]!.id).toBe('obsidian:graph.md');
    } finally {
      await harness.close();
    }
  },
  20_000,
);

test(
  'an empty Obsidian root still composes and returns empty evidence instead of crashing',
  async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'source-link-empty-'));
    const harness = await composeHarness({
      obsidian: { enabled: true, root: emptyRoot },
      loginote: { enabled: false, root: '' },
      ledger: { enabled: false, root: '' },
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    try {
      expect(harness.runner.inspect().evaluation.state).toBe('ready');
      expect(harness.turn.view.routes).toHaveLength(READ_CAPABILITIES.length);

      // No entries → empty grant, empty evidence, no throw.
      const grant = harness.turn.view.readGrants[0]!;
      expect(grant.value).toEqual({ allowedIds: [], counts: { obsidian: 0 } });

      const search = await harness.turn.executeRoute(viewRoute(harness.turn.view, 'search').id, {
        query: '图论',
      });
      expect(search.items).toEqual([]);
      expect(search.truncated).toBe(false);

      const browse = await harness.turn.executeRoute(viewRoute(harness.turn.view, 'browse').id, {});
      expect(browse.items).toEqual([]);
    } finally {
      await harness.close();
      await rm(emptyRoot, { recursive: true, force: true });
    }
  },
  20_000,
);
