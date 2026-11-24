import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { createLedgerAdapter } from '../src/adapters/ledger';
import { createLoginoteAdapter } from '../src/adapters/loginote';
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

const loginoteRoot = fileURLToPath(new URL('./fixtures/loginote', import.meta.url));

describe('createLoginoteAdapter', () => {
  test('loginote marks due entries as task and keeps metadata read-only', async () => {
    const metaPath = `${loginoteRoot}/metadata.json`;
    const before = createHash('sha1').update(readFileSync(metaPath)).digest('hex');
    const a = createLoginoteAdapter({
      root: loginoteRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    const list = await a.list({
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
      maxResults: 10,
      maxCharacters: 4000,
    });
    const day01 = list.find((i) => i.title.includes('day01'));
    expect(day01?.type).toBe('task');
    expect(day01?.observations.some((o) => o.category === 'due')).toBe(true);
    expect(day01?.id).toBe('loginote:vault/day01.md');
    const after = createHash('sha1').update(readFileSync(metaPath)).digest('hex');
    expect(after).toBe(before); // metadata.json was not modified
  });

  test('loginote survives missing metadata.json', async () => {
    const a = createLoginoteAdapter({
      root: `${loginoteRoot}/vault`,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    expect((await a.facts()).reachable).toBe(true);
    const list = await a.list({
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
      maxResults: 10,
      maxCharacters: 4000,
    });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((i) => i.source === 'loginote')).toBe(true);
  });

  test('loginote read is prefix-scoped and returns undefined for unknown ids', async () => {
    const a = createLoginoteAdapter({
      root: loginoteRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    const item = await a.read('loginote:vault/day01.md');
    expect(item?.title).toContain('day01');
    expect(item?.type).toBe('task');
    expect(await a.read('loginote:does/not/exist.md')).toBeUndefined();
    expect(await a.read('obsidian:vault/day01.md')).toBeUndefined();
  });

  test('unmatched metadata entries surface as standalone loginote metadata tasks', async () => {
    const a = createLoginoteAdapter({
      root: loginoteRoot,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
    });
    const list = await a.list({
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
      maxResults: 20,
      maxCharacters: 20_000,
    });
    const standalone = list.find((i) => i.id === 'loginote:metadata:n2');
    expect(standalone?.type).toBe('task');
    expect(standalone?.tags).toEqual([]);
    expect(standalone?.observations.some((o) => o.category === 'due')).toBe(true);
  });

  test('factory rejects a relative root', () => {
    expect(() =>
      createLoginoteAdapter({ root: 'relative/path', maxFiles: 5000, maxFileBytes: 1_048_576 }),
    ).toThrow();
  });

  test('facts revision folds in the metadata.json content hash', async () => {
    const root = tempDir('loginote-rev-');
    const notePath = join(root, 'note.md');
    const metaPath = join(root, 'metadata.json');
    writeFileSync(notePath, '# note\n\nbody\n');
    writeFileSync(
      metaPath,
      JSON.stringify({ notes: [{ id: 'a', title: 'note', dueDate: '2026-01-01' }] }),
    );

    const make = (): ReturnType<typeof createLoginoteAdapter> =>
      createLoginoteAdapter({ root, maxFiles: 5000, maxFileBytes: 1_048_576 });

    const revA = (await make().facts()).revision;
    // Unchanged content => identical revision from a fresh adapter.
    expect((await make().facts()).revision).toBe(revA);

    // Metadata-only change (dueDate) => revision must change even though the
    // Markdown files are byte-for-byte identical.
    writeFileSync(
      metaPath,
      JSON.stringify({ notes: [{ id: 'a', title: 'note', dueDate: '2027-02-02' }] }),
    );
    const revB = (await make().facts()).revision;
    expect(revB).not.toBe(revA);

    // Markdown-only change => revision must also change.
    writeFileSync(notePath, '# note\n\nchanged body\n');
    const revC = (await make().facts()).revision;
    expect(revC).not.toBe(revB);
  });
});

const ledgerRoot = fileURLToPath(new URL('./fixtures/ledger', import.meta.url));

describe('createLedgerAdapter', () => {
  const bigLimits = {
    maxFiles: 5000,
    maxFileBytes: 1_048_576,
    maxResults: 20,
    maxCharacters: 4000,
  };

  test('ledger splits entries and keeps line provenance', async () => {
    const a = createLedgerAdapter({ root: ledgerRoot, maxFileBytes: 1_048_576 });
    const list = await a.list({ maxFiles: 5000, maxFileBytes: 1_048_576, maxResults: 20, maxCharacters: 4000 });
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.every((i) => typeof i.provenance.line === 'number' && i.provenance.line > 0)).toBe(true);
    expect(list.some((i) => i.id.startsWith('ledger:交接.md#L'))).toBe(true);
  });

  test('ledger search finds the right entry; missing file is not fatal', async () => {
    const a = createLedgerAdapter({ root: ledgerRoot, maxFileBytes: 1_048_576 });
    const r = await a.search('解析器', { maxFiles: 5000, maxFileBytes: 1_048_576, maxResults: 5, maxCharacters: 2000 });
    expect(r.length).toBeGreaterThan(0);
    const bad = createLedgerAdapter({ root: ledgerRoot, file: '不存在.md', maxFileBytes: 1_048_576 });
    expect((await bad.facts()).reachable).toBe(false);
    expect(await bad.read('ledger:不存在.md#L1')).toBeUndefined();
  });

  test('ledger read locates a chunk by id; graph is empty', async () => {
    const a = createLedgerAdapter({ root: ledgerRoot, maxFileBytes: 1_048_576 });
    const list = await a.list(bigLimits);
    const target = list.find((i) => i.body.includes('解析器'));
    expect(target).toBeDefined();
    const read = await a.read(target!.id);
    expect(read?.id).toBe(target!.id);
    expect(read?.source).toBe('ledger');
    expect(read?.type).toBe('ledger');
    expect(read?.tags).toEqual([]);
    expect(read?.observations).toEqual([]);
    expect(await a.graph(target!.id)).toEqual([]);
    expect(await a.read('ledger:交接.md#L999')).toBeUndefined();
    expect(await a.read('obsidian:交接.md#L1')).toBeUndefined();
  });

  test('ledger marks the truncated tail chunk when the file exceeds maxFileBytes', async () => {
    const root = tempDir('ledger-trunc-');
    writeFileSync(join(root, '交接.md'), `# top\n\n- ${'x'.repeat(200)}\n- tail 末尾\n`);
    const a = createLedgerAdapter({ root, maxFileBytes: 60 });
    const list = await a.list({
      maxFiles: 5000,
      maxFileBytes: 60,
      maxResults: 20,
      maxCharacters: 10_000,
    });
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((i) => i.truncated === true)).toBe(true);
  });
});
