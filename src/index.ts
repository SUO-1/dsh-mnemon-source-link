// Plugin entry for dsh-mnemon-source-link.
//
// Declares the Cordis plugin contract the DSH Loader resolves at startup —
// `name`, `inject`, and the schemastery `Config` the settings panel renders —
// and installs the federated read-only Source (Obsidian / LogiNote / ledger)
// behind the `mnemonMemory` service with `installMemory`.
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
import { registerSettingsBridge } from './settings.js';
import type { LinkConfig } from './registry.js';

export const name = 'dsh-mnemon-source-link';
export const inject = ['mnemonMemory'];

/**
 * Settings for one federated source. Every key stays optional on purpose:
 * schemastery validates only what the user actually filled in, so an empty
 * configuration renders in the panel instead of failing validation.
 */
function sourceConfig() {
  return z.object({
    enabled: z.boolean(),
    root: z.string(),
    excludes: z.array(z.string()),
    metadataPath: z.string(),
    file: z.string(),
  });
}

export const Config = z.object({
  obsidian: sourceConfig(),
  loginote: sourceConfig(),
  ledger: sourceConfig(),
  maxFiles: z.number().step(1).min(1).max(100000),
  maxFileBytes: z.number().step(1).min(1024).max(50 * 1024 * 1024),
});

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Memory Link', 'zh-CN': '记忆联动' },
  description: {
    en: 'Federated read-only memory source (Obsidian / LogiNote / ledger).',
    'zh-CN': '联邦只读记忆源（Obsidian / LogiNote / 台账）。',
  },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.link' }],
});

/**
 * Mount the Source onto the memory service. `config` is whatever the Loader
 * parsed out of `Config` — a partial object — so it is typed as such and the
 * registry fills the remaining defaults.
 */
export function apply(ctx: Context, config: Partial<LinkConfig> = {}): void {
  installMemory(
    ctx,
    { plugin: memoryPlugin, sources: [createLinkMemorySource(config)] },
    { effectiveDigest: memoryConfigurationDigest(config) },
  );

  // Settings bridge: the Client form (registered in `plugins.bundle.config`)
  // reads and writes this plugin's configuration through one Host route.
  const webServer = ctx.get('webServer') as
    | {
        register(route: {
          kind: 'exact' | 'prefix';
          path: string;
          handler: (
            req: import('node:http').IncomingMessage,
            res: import('node:http').ServerResponse,
          ) => void | Promise<void>;
        }): () => void;
      }
    | undefined;
  const configEditor = ctx.get('configEditor') as
    | {
        edit(
          entry: unknown,
          change: (
            current: Record<string, unknown>,
            inherited: Record<string, unknown>,
          ) => Record<string, unknown>,
        ): Promise<void>;
      }
    | undefined;
  if (webServer !== undefined) {
    const entry = (ctx as unknown as { fiber?: { entry?: unknown } }).fiber?.entry;
    ctx.effect(
      () => registerSettingsBridge({ webServer, configEditor, entry, config }),
      'mnemon-source-link settings route',
    );
  }
}

export { createLinkMemorySource } from './source.js';
