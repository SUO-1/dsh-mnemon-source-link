import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { LinkItem } from '../src/types';
import {
  computeRevision,
  createScanCache,
  scanMarkdown,
  type ScanCache,
  type ScannedFile,
} from '../src/scan';

const tempDirs: string[] = [];

function tempDir(prefix = 'scan-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeItem(f: ScannedFile, raw: string, title?: string): LinkItem {
  return {
    id: `obsidian:${f.relPath}`,
    source: 'obsidian',
    type: 'note',
    title: title ?? (raw.split('\n')[0] ?? ''),
    body: raw,
    observations: [],
    relations: [],
    tags: [],
    ts: new Date(f.mtimeMs).toISOString(),
    provenance: { path: f.relPath, line: 1 },
  };
}

const parseFirstLine = (f: ScannedFile, raw: string): LinkItem => makeItem(f, raw);

describe('scanMarkdown', () => {
  test('empty directory is reachable with count 0 and a stable revision', () => {
    const root = tempDir();
    const a = scanMarkdown(root, { parse: parseFirstLine });
    const b = scanMarkdown(root, { parse: parseFirstLine });
    expect(a.reachable).toBe(true);
    expect(a.count).toBe(0);
    expect(a.files).toEqual([]);
    expect(typeof a.revision).toBe('string');
    expect(a.revision).toBe(b.revision);
    expect(a.revision).toBe(computeRevision([]));
  });

  test('missing root does not throw; reachable=false, count=0', () => {
    const root = join(tempDir(), 'does-not-exist');
    let result: ReturnType<typeof scanMarkdown> | undefined;
    expect(() => {
      result = scanMarkdown(root, { parse: parseFirstLine });
    }).not.toThrow();
    expect(result!.reachable).toBe(false);
    expect(result!.count).toBe(0);
    expect(result!.files).toEqual([]);
  });

  test('scans nested markdown files and skips non-markdown', () => {
    const root = tempDir();
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'a.md'), '# A\n');
    writeFileSync(join(root, 'sub', 'b.md'), '# B\n');
    writeFileSync(join(root, 'skip.txt'), 'not markdown');

    const result = scanMarkdown(root, { parse: parseFirstLine });
    expect(result.count).toBe(2);
    const rels = result.files.map((f) => f.relPath).sort();
    expect(rels).toEqual(['a.md', 'sub/b.md']);
    expect(result.files.every((f) => f.item?.title.startsWith('#'))).toBe(true);
    expect(result.reachable).toBe(true);
  });

  test('oversized file is read only up to maxFileBytes and flagged truncated', () => {
    const root = tempDir();
    const big = 'x'.repeat(5000);
    writeFileSync(join(root, 'big.md'), big);

    let seenRaw = '';
    const result = scanMarkdown(root, {
      maxFileBytes: 100,
      parse: (f, raw) => {
        seenRaw = raw;
        return makeItem(f, raw);
      },
    });

    expect(result.count).toBe(1);
    const file = result.files[0];
    expect(file.size).toBe(5000);
    expect(file.truncated).toBe(true);
    expect(seenRaw.length).toBeLessThanOrEqual(100);
    expect(file.item?.body.length).toBeLessThanOrEqual(100);
  });

  test('small file is not truncated', () => {
    const root = tempDir();
    writeFileSync(join(root, 'small.md'), '# hi\n');
    const result = scanMarkdown(root, { maxFileBytes: 1024, parse: parseFirstLine });
    expect(result.files[0].truncated).toBe(false);
  });

  test('escape guard never reads files outside root (.. / symlink) and logs diagnostics', () => {
    const base = tempDir();
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const sentinel = join(outside, 'sentinel.md');
    writeFileSync(sentinel, '# SENTINEL secret\n');
    writeFileSync(join(root, 'inside.md'), '# inside\n');

    // A junction/symlink inside root that points outside root.
    let linkCreated = false;
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction');
      linkCreated = true;
    } catch {
      try {
        symlinkSync(outside, join(root, 'escape'), 'dir');
        linkCreated = true;
      } catch {
        linkCreated = false;
      }
    }

    const result = scanMarkdown(root, { parse: parseFirstLine });
    const sentinelReal = realpathSync(sentinel);
    expect(result.files.some((f) => realpathSync(f.absPath) === sentinelReal)).toBe(false);
    expect(result.files.some((f) => f.item?.body.includes('SENTINEL'))).toBe(false);
    // inside.md still found.
    expect(result.files.some((f) => f.relPath === 'inside.md')).toBe(true);

    if (linkCreated) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test('honours maxFiles upper bound and records a diagnostic', () => {
    const root = tempDir();
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(join(root, `f${i}.md`), `# ${i}\n`);
    }
    const result = scanMarkdown(root, { maxFiles: 3, parse: parseFirstLine });
    expect(result.files.length).toBeLessThanOrEqual(3);
    expect(result.count).toBeLessThanOrEqual(3);
    expect(result.diagnostics.some((d) => /maxFiles/i.test(d))).toBe(true);
  });

  test('strips BOM before handing raw to parse', () => {
    const root = tempDir();
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Hello\n', 'utf8')]);
    writeFileSync(join(root, 'bom.md'), bom);

    const result = scanMarkdown(root, { parse: parseFirstLine });
    expect(result.count).toBe(1);
    const title = result.files[0].item!.title;
    expect(title).not.toContain('\uFEFF');
    expect(title).toBe('# Hello');
  });

  test('reuses cached parsed item when (absPath,mtimeMs,size) unchanged', () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.md'), '# A\n');
    writeFileSync(join(root, 'b.md'), '# B\n');

    let calls = 0;
    const cache: ScanCache = createScanCache();
    const parse = (f: ScannedFile, raw: string): LinkItem => {
      calls += 1;
      return makeItem(f, raw);
    };

    const first = scanMarkdown(root, { parse, cache });
    expect(first.count).toBe(2);
    expect(calls).toBe(2);

    const second = scanMarkdown(root, { parse, cache });
    expect(second.count).toBe(2);
    // No new parses: cache hits reuse the parsed items.
    expect(calls).toBe(2);
    expect(second.files.map((f) => f.item?.title).sort()).toEqual(['# A', '# B']);
  });

  test('re-parses after a file changes', () => {
    const root = tempDir();
    const path = join(root, 'a.md');
    writeFileSync(path, '# A\n');
    let calls = 0;
    const cache = createScanCache();
    const parse = (f: ScannedFile, raw: string): LinkItem => {
      calls += 1;
      return makeItem(f, raw);
    };
    scanMarkdown(root, { parse, cache });
    expect(calls).toBe(1);
    writeFileSync(path, '# A changed and longer\n');
    const second = scanMarkdown(root, { parse, cache });
    expect(calls).toBe(2);
    expect(second.files[0].item?.title).toBe('# A changed and longer');
  });

  test('aborted signal returns promptly with an aborted diagnostic', () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.md'), '# A\n');
    const controller = new AbortController();
    controller.abort();

    const result = scanMarkdown(root, { parse: parseFirstLine, signal: controller.signal });
    expect(result.reachable).toBe(true);
    expect(result.diagnostics.some((d) => /aborted/i.test(d))).toBe(true);
    expect(result.files.length).toBe(0);
  });
});

describe('computeRevision', () => {
  test('is order-independent and sensitive to changes', () => {
    const a = { relPath: 'a.md', mtimeMs: 1, size: 10 };
    const b = { relPath: 'b.md', mtimeMs: 2, size: 20 };
    expect(computeRevision([a, b])).toBe(computeRevision([b, a]));
    expect(computeRevision([a, b])).not.toBe(computeRevision([a]));
    expect(computeRevision([a, b])).not.toBe(
      computeRevision([{ ...a, size: 11 }, b]),
    );
  });
});
