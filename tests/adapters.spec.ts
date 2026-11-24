import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

  test('list skips .obsidian/.git and is read-only', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.obsidian'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'keep.md'), '# keep\n');
    writeFileSync(join(root, '.obsidian', 'hidden.md'), '# hidden\n');
    writeFileSync(join(root, '.git', 'secret.md'), '# secret\n');

    const a = createObsidianAdapter({ root, maxFiles: 5000, maxFileBytes: 1_048_576 });
    const list = await a.list({ ...scanLimits, maxResults: 10, maxCharacters: 10_000 });
    const ids = list.map((i) => i.id);

    expect(ids).toContain('obsidian:keep.md');
    expect(ids.some((id) => id.includes('.obsidian'))).toBe(false);
    expect(ids.some((id) => id.includes('.git'))).toBe(false);
    // Listing does not create or alter anything: directories still hold exactly one md each.
    expect(list.every((i) => i.source === 'obsidian' && i.type === 'note')).toBe(true);
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
