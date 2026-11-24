// Shared Markdown parsing layer for the obsidian / loginote adapters.
// Read-only, dependency-free (minimal built-in frontmatter parser), 0 LLM.

import type { LinkItem, LinkItemType, LinkSourceId } from './types.js';

const BOM_CHAR = '\uFEFF';
const REPLACEMENT_CHAR = '\uFFFD';

/** Strip a UTF-8/UTF-16 BOM, decode as UTF-8 and flag invalid bytes (U+FFFD). */
export function decodeText(buf: Buffer): { text: string; bom: boolean; hadInvalid: boolean } {
  let bom = false;
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true;
    start = 3;
  }
  let text = buf.subarray(start).toString('utf8');
  // A stray BOM can also survive as a code point; strip it too.
  if (text.charCodeAt(0) === 0xfeff) {
    bom = true;
    text = text.slice(1);
  }
  return { text, bom, hadInvalid: text.includes(REPLACEMENT_CHAR) };
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Minimal frontmatter parser: key: value, key: [a, b], key: + "- item" list. */
function parseFrontmatter(lines: string[]): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2].trim();
    if (rawValue === '') {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const item = /^\s*-\s+(.*)$/.exec(lines[j]);
        if (!item) break;
        items.push(stripQuotes(item[1].trim()));
        j += 1;
      }
      if (items.length > 0) {
        fm[key] = items;
        i = j - 1;
      } else {
        fm[key] = '';
      }
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim();
      fm[key] = inner
        ? inner.split(',').map((s) => stripQuotes(s.trim())).filter((s) => s !== '')
        : [];
    } else {
      fm[key] = stripQuotes(rawValue);
    }
  }
  return fm;
}

/** Split optional frontmatter from the body; titleLine = 1-based raw line of first `# ` heading. */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  titleLine?: number;
} {
  const lines = raw.split('\n');
  const firstLine = lines.length > 0 ? lines[0].replace(/^\uFEFF/, '') : '';

  if (firstLine.trim() === '---') {
    let closing = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') {
        closing = i;
        break;
      }
    }
    if (closing !== -1) {
      const frontmatter = parseFrontmatter(lines.slice(1, closing));
      const bodyLines = lines.slice(closing + 1);
      const body = bodyLines.join('\n');
      let titleLine: number | undefined;
      for (let i = 0; i < bodyLines.length; i += 1) {
        if (/^#\s+/.test(bodyLines[i])) {
          titleLine = closing + 2 + i;
          break;
        }
      }
      return { frontmatter, body, titleLine };
    }
  }

  const body = raw.replace(/^\uFEFF/, '');
  const bodyLines = body.split('\n');
  let titleLine: number | undefined;
  for (let i = 0; i < bodyLines.length; i += 1) {
    if (/^#\s+/.test(bodyLines[i])) {
      titleLine = i + 1;
      break;
    }
  }
  return { frontmatter: {}, body, titleLine };
}

function headingTitle(body: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/m.exec(body);
  return match ? match[1].trim() : undefined;
}

function fileStem(relPath: string): string {
  const base = relPath.split(/[\\/]/).pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function collectTags(frontmatter: Record<string, unknown>, body: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const tag = value.trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  };

  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const tag of fmTags) push(String(tag));
  } else if (typeof fmTags === 'string') {
    for (const tag of fmTags.split(',')) push(tag);
  }

  const inlineTags = /(?:^|\s)#([\p{L}\p{N}_\/-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = inlineTags.exec(body)) !== null) {
    push(match[1]);
  }
  return tags;
}

/** Parse one Markdown document into a normalized LinkItem. */
export function parseMarkdown(input: {
  raw: string;
  relPath: string;
  source: LinkSourceId;
  type: LinkItemType;
  mtimeMs: number;
}): LinkItem {
  const { raw, relPath, source, type, mtimeMs } = input;
  const { frontmatter, body, titleLine } = splitFrontmatter(raw);

  const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : '';
  const title = headingTitle(body) ?? (fmTitle || fileStem(relPath));

  const observations: { category: string; text: string }[] = [];
  const relations: { type: string; target: string }[] = [];

  for (const line of body.split('\n')) {
    const observation = /^- \[([^\]]+)\]\s+(.+)$/u.exec(line);
    if (observation) {
      observations.push({ category: observation[1].trim(), text: observation[2].trim() });
      continue;
    }
    const typed = /^-\s+([\w-]+)\s+\[\[([^\]]+)\]\]\s*$/u.exec(line);
    if (typed) {
      relations.push({ type: typed[1], target: typed[2].trim() });
      continue;
    }
    const bare = /^-\s+\[\[([^\]]+)\]\]\s*$/u.exec(line);
    if (bare) {
      relations.push({ type: 'links_to', target: bare[1].trim() });
    }
  }

  const rawTs = frontmatter.updated ?? frontmatter.date;
  const ts =
    typeof rawTs === 'string' && rawTs.trim() ? rawTs.trim() : new Date(mtimeMs).toISOString();

  return {
    id: `${source}:${relPath}`,
    source,
    type,
    title,
    body,
    observations,
    relations,
    tags: collectTags(frontmatter, body),
    ts,
    provenance: { path: relPath, line: titleLine ?? 1 },
  };
}

/** Case-insensitive literal match; use the matching line as the snippet. */
export function matchSnippet(
  body: string,
  query: string,
  maxChars: number,
): { text: string; matched: boolean } {
  const limit = maxChars > 0 ? maxChars : Number.POSITIVE_INFINITY;
  const needle = query ?? '';
  const index = needle ? body.toLowerCase().indexOf(needle.toLowerCase()) : -1;

  if (index === -1) {
    const text = Number.isFinite(limit) ? body.slice(0, limit) : body;
    return { text: text.trim(), matched: false };
  }

  const lineStart = body.lastIndexOf('\n', index) + 1;
  let lineEnd = body.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = body.length;
  let line = body.slice(lineStart, lineEnd);

  if (line.length > limit) {
    const matchInLine = index - lineStart;
    let start = Math.max(0, matchInLine - Math.floor(limit / 2));
    const end = Math.min(line.length, start + limit);
    start = Math.max(0, end - limit);
    line = line.slice(start, end);
  }
  return { text: line.trim(), matched: true };
}
