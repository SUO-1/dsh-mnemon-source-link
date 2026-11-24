import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';
import { createRegistry, normalizeLinkConfig } from '../src/registry';

const obsidianRoot = fileURLToPath(new URL('./fixtures/obsidian', import.meta.url));
const ledgerRoot = fileURLToPath(new URL('./fixtures/ledger', import.meta.url));

const L = {
  maxFiles: 5000,
  maxFileBytes: 1_048_576,
  maxResults: 5,
  maxCharacters: 2000,
};

const cfg = normalizeLinkConfig({
  obsidian: { enabled: true, root: obsidianRoot },
  ledger: { enabled: true, root: ledgerRoot },
  loginote: { enabled: false, root: '' },
});

test('registry merges sources, namespaced ids, dispatches read', async () => {
  const reg = createRegistry(cfg);
  const hits = await reg.searchAll('图论', L);
  expect(hits[0].id.startsWith('obsidian:')).toBe(true);
  const all = await reg.allIds();
  expect(all.some((i) => i.startsWith('obsidian:'))).toBe(true);
  expect(all.some((i) => i.startsWith('ledger:'))).toBe(true);
  expect(await reg.readItem('ledger:交接.md#L1')).toBeDefined();
});

test('disabled source is not registered', async () => {
  const f = await createRegistry(cfg).facts();
  expect(Object.keys(f.per).sort()).toEqual(['ledger', 'obsidian']);
});

test('normalizeLinkConfig fills defaults and rejects relative root', () => {
  const c = normalizeLinkConfig({});
  expect(c.maxFiles).toBe(5000);
  expect(() => normalizeLinkConfig({ obsidian: { enabled: true, root: 'rel/path' } })).toThrow();
});

test('readItem dispatches by prefix and returns undefined otherwise', async () => {
  const reg = createRegistry(cfg);
  expect(await reg.readItem('obsidian:graph.md')).toBeDefined();
  expect(await reg.readItem('unknown:foo')).toBeUndefined();
  // A disabled source's prefix is not served.
  expect(await reg.readItem('loginote:vault/day01.md')).toBeUndefined();
});

test('searchAll scores title hits above body-only hits and caps the character budget', async () => {
  const reg = createRegistry(cfg);
  const hits = await reg.searchAll('图论', { ...L, maxResults: 20, maxCharacters: 10_000 });
  expect(hits.length).toBeGreaterThan(0);
  // Title hit (graph.md title is 图论笔记) ranks first.
  expect(hits[0].id).toBe('obsidian:graph.md');

  const tight = await reg.searchAll('图论', { ...L, maxResults: 20, maxCharacters: 8 });
  expect(tight.reduce((n, i) => n + i.body.length, 0)).toBeLessThanOrEqual(8);
});

test('listAll merges sources in ts-desc order without duplicates', async () => {
  const reg = createRegistry(cfg);
  const list = await reg.listAll({ ...L, maxResults: 100, maxCharacters: 100_000 });
  const ids = list.map((i) => i.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.some((i) => i.startsWith('obsidian:'))).toBe(true);
  expect(ids.some((i) => i.startsWith('ledger:'))).toBe(true);
});

test('graph dispatches to the owning adapter', async () => {
  const reg = createRegistry(cfg);
  const rel = await reg.graph('obsidian:graph.md');
  expect(rel.some((r) => r.target === '另一篇')).toBe(true);
  expect(await reg.graph('ledger:交接.md#L1')).toEqual([]);
  expect(await reg.graph('unknown:foo')).toEqual([]);
});
