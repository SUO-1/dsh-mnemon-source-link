import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { createObsidianAdapter } from '../src/adapters/obsidian';

const obsidianRoot = fileURLToPath(new URL('./fixtures/obsidian', import.meta.url));

const scanLimits = {
  maxFiles: 5000,
  maxFileBytes: 1_048_576,
  maxResults: 5,
  maxCharacters: 2000,
};

const tempDirs: string[] = [];

function tempDir(prefix = 'obsidian-adapter-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createObsidianAdapter', () => {
  test('search hits graph.md with provenance path', async () => {
    const a = createObsidianAdapter({
      root: obsidianRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    const r = await a.search('图论', scanLimits);
    expect(r[0]?.id).toBe('obsidian:graph.md');
    expect(r[0]?.provenance.path).toBe('graph.md');
  });

  test('read returns full item; unknown id undefined', async () => {
    const a = createObsidianAdapter({
      root: obsidianRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    const item = await a.read('obsidian:graph.md');
    expect(item?.title).toBe('图论笔记');
    expect(item?.observations.some((o) => o.category === 'preference')).toBe(true);
    expect(await a.read('obsidian:missing.md')).toBeUndefined();
  });

  test('read ignores a non-obsidian id prefix', async () => {
    const a = createObsidianAdapter({
      root: obsidianRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    expect(await a.read('loginote:graph.md')).toBeUndefined();
  });

  test('list skips .obsidian/.git and does not modify the root', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.obsidian'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'keep.md'), '# keep\n');
    writeFileSync(join(root, '.obsidian', 'hidden.md'), '# hidden\n');
    writeFileSync(join(root, '.git', 'secret.md'), '# secret\n');

    const snapshot = (): string[] =>
      (readdirSync(root, { recursive: true }) as string[])
        .map((p) => p.replace(/\\/g, '/'))
        .sort();
    const before = snapshot();

    const a = createObsidianAdapter({ root, maxFiles: 5000, maxFileBytes: 1_048_576 });
    const list = await a.list({ ...scanLimits, maxResults: 10, maxCharacters: 10_000 });
    const ids = list.map((i) => i.id);

    // The hidden files really exist on disk ...
    expect(existsSync(join(root, '.obsidian', 'hidden.md'))).toBe(true);
    expect(existsSync(join(root, '.git', 'secret.md'))).toBe(true);
    // ... but the adapter skips their directories.
    expect(ids).toContain('obsidian:keep.md');
    expect(ids).not.toContain('obsidian:.obsidian/hidden.md');
    expect(ids).not.toContain('obsidian:.git/secret.md');
    // ... and listing left the tree byte-for-byte identical (nothing written).
    expect(snapshot()).toEqual(before);
    expect(list.every((i) => i.source === 'obsidian' && i.type === 'note')).toBe(true);
  });

  test('oversized single item is truncated to the budget and flagged', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'big.md'), `# big\n\n${'x'.repeat(200)}`);
    const a = createObsidianAdapter({ root, maxFiles: 5000, maxFileBytes: 1_048_576 });
    const limits = { ...scanLimits, maxResults: 10, maxCharacters: 50 };

    const list = await a.list(limits);
    expect(list.length).toBe(1);
    expect(list[0].truncated).toBe(true);
    expect(list[0].body.length).toBeLessThanOrEqual(50);

    const search = await a.search('x', limits);
    expect(search.reduce((n, i) => n + i.body.length, 0)).toBeLessThanOrEqual(50);
    expect(search.every((i) => i.body.length <= 50)).toBe(true);
  });

  test('items that do not fit the remaining budget are dropped', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.md'), `# a\n${'a'.repeat(30)}`);
    writeFileSync(join(root, 'b.md'), `# b\n${'b'.repeat(30)}`);
    const a = createObsidianAdapter({ root, maxFiles: 5000, maxFileBytes: 1_048_576 });

    const list = await a.list({ ...scanLimits, maxResults: 10, maxCharacters: 40 });
    expect(list.reduce((n, i) => n + i.body.length, 0)).toBeLessThanOrEqual(40);
    expect(list.length).toBe(1);
  });

  test('non-positive character budget yields no items', async () => {
    const a = createObsidianAdapter({
      root: obsidianRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    const zero = { ...scanLimits, maxResults: 10, maxCharacters: 0 };
    expect(await a.list(zero)).toEqual([]);
    expect(await a.search('图论', zero)).toEqual([]);
  });

  test('factory rejects a relative root', () => {
    expect(() =>
      createObsidianAdapter({ root: 'relative/path', maxFiles: 5000, maxFileBytes: 1_048_576 }),
    ).toThrow();
  });

  test('facts reports reachable, count and revision', async () => {
    const a = createObsidianAdapter({
      root: obsidianRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    const facts = await a.facts();
    expect(facts.reachable).toBe(true);
    expect(facts.count).toBeGreaterThanOrEqual(2);
    expect(typeof facts.revision).toBe('string');
  });

  test('graph returns relations for a known item and [] otherwise', async () => {
    const a = createObsidianAdapter({
      root: obsidianRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    const relations = await a.graph('obsidian:graph.md');
    expect(relations.some((r) => r.target === '另一篇')).toBe(true);
    expect(await a.graph('obsidian:missing.md')).toEqual([]);
  });
});
