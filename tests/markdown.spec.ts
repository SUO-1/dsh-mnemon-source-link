import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { decodeText, matchSnippet, parseMarkdown, splitFrontmatter } from '../src/markdown';

test('parses title/observations/relations/tags/中文', () => {
  const raw = decodeText(readFileSync(new URL('./fixtures/obsidian/graph.md', import.meta.url))).text;
  const item = parseMarkdown({ raw, relPath: 'graph.md', source: 'obsidian', type: 'note', mtimeMs: 0 });
  expect(item.title).toBe('图论笔记');
  expect(item.observations).toContainEqual({ category: 'preference', text: '偏好中文' });
  expect(item.relations).toEqual(expect.arrayContaining([
    { type: 'relates_to', target: '另一篇' }, { type: 'links_to', target: '第三篇' }]));
  expect(item.tags).toContain('学习');
  expect(item.id).toBe('obsidian:graph.md');
});
test('title falls back to filename when no heading', () => {
  const item = parseMarkdown({ raw: '正文没有一级标题。', relPath: 'no-title.md', source: 'obsidian', type: 'note', mtimeMs: 0 });
  expect(item.title).toBe('no-title');
});
test('decode strips BOM and flags invalid bytes', () => {
  const r = decodeText(Buffer.from('\uFEFF正文', 'utf8'));
  expect(r.bom).toBe(true); expect(r.text).toBe('正文');
});

test('parseMarkdown handles CRLF line endings (observations not lost)', () => {
  const raw = '---\r\ntitle: 图论笔记\r\n---\r\n# 图论笔记\r\n\r\n- [preference] 偏好中文\r\n#学习\r\n';
  const item = parseMarkdown({ raw, relPath: 'crlf.md', source: 'obsidian', type: 'note', mtimeMs: 0 });
  expect(item.observations).toHaveLength(1);
  expect(item.observations[0]).toEqual({ category: 'preference', text: '偏好中文' });
  expect(item.title).toBe('图论笔记');
  expect(item.tags).toContain('学习');
});

test('splitFrontmatter separates frontmatter from body', () => {
  const raw = decodeText(readFileSync(new URL('./fixtures/obsidian/graph.md', import.meta.url))).text;
  const sf = splitFrontmatter(raw);
  expect(sf.frontmatter.title).toBe('图论笔记');
  expect(sf.body).not.toContain('---');
  expect(sf.body).not.toContain('tags:');
  expect(sf.body).toContain('# 图论笔记');
});

test('matchSnippet is case-insensitive for latin text', () => {
  const r = matchSnippet('say hello world', 'HELLO', 200);
  expect(r.matched).toBe(true);
  expect(r.text.toLowerCase()).toContain('hello');
});

test('matchSnippet matches Chinese and truncates to maxChars', () => {
  const hit = matchSnippet('一段正文，讲图论基础与最短路。', '图论', 200);
  expect(hit.matched).toBe(true);
  expect(hit.text).toContain('图论');
  const truncated = matchSnippet('x'.repeat(200), 'x', 50);
  expect(truncated.matched).toBe(true);
  expect(truncated.text.length).toBeLessThanOrEqual(50);
});

test('matchSnippet reports matched:false when query absent', () => {
  const r = matchSnippet('nothing here', '缺失词', 200);
  expect(r.matched).toBe(false);
});

test('decodeText flags invalid UTF-8 bytes via hadInvalid', () => {
  const r = decodeText(Buffer.from([0xff, 0xfe, 0x41]));
  expect(r.hadInvalid).toBe(true);
});
