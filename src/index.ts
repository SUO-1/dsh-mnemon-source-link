// Plugin entry for dsh-mnemon-source-link.
//
// Declares the Cordis plugin contract the DSH Loader resolves at startup —
// `name`, `inject`, and the schemastery `Config` the settings panel renders —
// and installs the federated read-only Source (Obsidian / LogiNote / ledger)
// behind the `mnemonMemory` service with `installMemory`.
//
// The configuration fields are marked `.volatile()`: that is what makes DSH
// expose this entry as a user-editable settings namespace (the Plugins page
// `plugins.bundle.config` seat renders the Client form over `configForms`).
// Volatile values arrive as `Volatile<T>` refs, so `apply` unwraps them into a
// plain snapshot before the Source is built; saving in the form persists to the
// profile document and applies when DSH reloads the entry.
//
// The three roots default to auto-detected paths (see `./detect.ts`) so a fresh
// install is pre-filled; any saved value overrides the detected default.
//
// Read-only IRON RULE: the Source only registers read routes; nothing here
// ever writes to the underlying vaults.

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import {
  defineMemoryPlugin,
  installMemory,
  memoryConfigurationDigest,
} from 'dsh-mnemon/extension-sdk';
import { createLinkMemorySource } from './source.js';
import { detectDefaultRoots } from './detect.js';
import type { LinkConfig } from './registry.js';

export const name = 'dsh-mnemon-source-link';
export const inject = ['mnemonMemory'];

/** Auto-detected default roots, used as the schema defaults (form pre-fill). */
const DETECTED = detectDefaultRoots();

/**
 * Settings for one federated source. Every field is `.volatile()` so DSH
 * projects it into the editable settings namespace, and `.default()` keeps an
 * empty config renderable (defaults fill in) instead of failing validation.
 */
function sourceConfig(defaultRoot: string) {
  return z.object({
    enabled: z.boolean().default(false).volatile(),
    root: z.string().default(defaultRoot).volatile(),
    excludes: z.array(z.string()).default([]).volatile(),
    metadataPath: z.string().default('').volatile(),
    file: z.string().default('交接.md').volatile(),
  });
}

export const Config = z.object({
  obsidian: sourceConfig(DETECTED.obsidian),
  loginote: sourceConfig(DETECTED.loginote),
  ledger: sourceConfig(DETECTED.ledger),
  maxFiles: z.number().step(1).min(1).max(100000).default(5000).volatile(),
  maxFileBytes: z.number().step(1).min(1024).max(50 * 1024 * 1024).default(1048576).volatile(),
});

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Memory Link', 'zh-CN': '记忆联动' },
  description: {
    en: 'Federated read-only memory source (Obsidian / LogiNote / ledger).',
    'zh-CN': '联邦只读记忆源（Obsidian / LogiNote / 台账）。',
  },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.narrative' }],
});

/** Recursively unwrap `Volatile<T>` refs into plain values (arrays/objects too). */
function unwrapVolatile(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return unwrapVolatile((value as { get: () => unknown }).get());
  }
  if (Array.isArray(value)) return value.map(unwrapVolatile);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = unwrapVolatile((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Mount the Source onto the memory service. `config` is the Loader-parsed
 * `Config` — its volatile fields are `Volatile<T>` refs, so unwrap to a plain
 * snapshot before typing it as `Partial<LinkConfig>`; the registry fills the
 * remaining defaults.
 */
export function apply(ctx: Context, config: Partial<LinkConfig> = {}): void {
  const plain = unwrapVolatile(config) as Partial<LinkConfig>;
  installMemory(
    ctx,
    { plugin: memoryPlugin, sources: [createLinkMemorySource(plain)] },
    { effectiveDigest: memoryConfigurationDigest(plain) },
  );
}

export { createLinkMemorySource } from './source.js';
