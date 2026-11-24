import { describe, expect, it } from 'vitest';
import type { LinkAdapter, LinkItem, ScanLimits } from '../src/types.js';

const item: LinkItem = {
  id: 'obsidian:notes/hello.md',
  source: 'obsidian',
  type: 'note',
  title: 'Hello',
  body: 'world',
  observations: [],
  relations: [],
  tags: [],
  ts: '2026-01-01T00:00:00.000Z',
  provenance: { path: 'notes/hello.md' },
};

describe('shared LinkItem types', () => {
  it('assembles a minimal LinkItem and keeps its values at runtime', () => {
    expect(item.source === 'obsidian' && item.provenance.path).toBe('notes/hello.md');
  });

  it('LinkAdapter signatures are usable (compile-time assembly)', () => {
    const limits: ScanLimits = { maxFiles: 10, maxFileBytes: 1024, maxResults: 5, maxCharacters: 500 };
    const adapter: LinkAdapter = {
      id: 'ledger',
      label: { zh: '台账', en: 'Ledger' },
      facts: async () => ({ reachable: true, count: 0, revision: 'r0' }),
      search: async (_q, _limits) => [],
      read: async (_id) => undefined,
      list: async (_limits) => [],
      graph: async (_id) => [],
    };
    expect(adapter.id).toBe('ledger');
    expect(limits.maxResults).toBe(5);
  });
});
