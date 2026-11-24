import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // A disabled source has no key at all (not a `reachable: false` placeholder).
  expect('loginote' in f.per).toBe(false);
  expect(f.per.loginote).toBeUndefined();
});

test('normalizeLinkConfig fills defaults and rejects relative root', () => {
  const c = normalizeLinkConfig({});
  expect(c.maxFiles).toBe(5000);
  expect(c.maxFileBytes).toBe(1_048_576);
  expect(() => normalizeLinkConfig({ obsidian: { enabled: true, root: 'rel/path' } })).toThrow();
});

test('an enabled source with an empty root is rejected, a disabled one is not', () => {
  // ① enabled + empty root => clear error (not a silently skipped source)
  expect(() => normalizeLinkConfig({ obsidian: { enabled: true, root: '' } })).toThrow();
  expect(() => normalizeLinkConfig({ ledger: { enabled: true, root: '' } })).toThrow();
  // ② enabled + relative root => clear error
  expect(() => normalizeLinkConfig({ obsidian: { enabled: true, root: 'rel/x' } })).toThrow();
  // ③ disabled + empty root => no throw, and the source is not instantiated
  const c = normalizeLinkConfig({ loginote: { enabled: false, root: '' } });
  expect(c.loginote.enabled).toBe(false);
  expect(c.loginote.root).toBe('');
  const reg = createRegistry(c);
  expect(reg.adapters.some((a) => a.id === 'loginote')).toBe(false);
});

test('createRegistry refuses an enabled source without an absolute root', () => {
  expect(() =>
    createRegistry({
      obsidian: { enabled: true, root: '' },
      loginote: { enabled: false, root: '' },
      ledger: { enabled: false, root: '' },
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    }),
  ).toThrow();
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

test('listAll merges sources without duplicates', async () => {
  const reg = createRegistry(cfg);
  const list = await reg.listAll({ ...L, maxResults: 100, maxCharacters: 100_000 });
  const ids = list.map((i) => i.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.some((i) => i.startsWith('obsidian:'))).toBe(true);
  expect(ids.some((i) => i.startsWith('ledger:'))).toBe(true);
});

test('listAll orders items by ts descending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-order-'));
  try {
    writeFileSync(join(dir, 'older.md'), '# older\n\nolder body\n');
    writeFileSync(join(dir, 'newer.md'), '# newer\n\nnewer body\n');
    const old = new Date('2020-01-01T00:00:00Z');
    const recent = new Date('2024-01-01T00:00:00Z');
    utimesSync(join(dir, 'older.md'), old, old);
    utimesSync(join(dir, 'newer.md'), recent, recent);

    const reg = createRegistry(
      normalizeLinkConfig({ obsidian: { enabled: true, root: dir } }),
    );
    const list = await reg.listAll({ ...L, maxResults: 50, maxCharacters: 100_000 });
    expect(list.map((i) => i.id)).toEqual(['obsidian:newer.md', 'obsidian:older.md']);
    const timestamps = list.map((i) => Date.parse(i.ts));
    expect(timestamps[0]).toBeGreaterThan(timestamps[1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('graph dispatches to the owning adapter', async () => {
  const reg = createRegistry(cfg);
  const rel = await reg.graph('obsidian:graph.md');
  expect(rel.some((r) => r.target === '另一篇')).toBe(true);
  expect(await reg.graph('ledger:交接.md#L1')).toEqual([]);
  expect(await reg.graph('unknown:foo')).toEqual([]);
});
