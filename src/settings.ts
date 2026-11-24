// Settings bridge for dsh-mnemon-source-link.
//
// The Client settings form cannot touch the Loader configuration directly, so
// this Host half exposes one small JSON route:
//
//   GET  /dsh-mnemon-source-link/config  -> current effective configuration
//   PUT  /dsh-mnemon-source-link/config  -> validate, then persist through the
//                                          `configEditor` service, which writes
//                                          the profile patch and reconciles the
//                                          Loader entry (normal lifecycle).
//
// Reads only; the read-only IRON RULE applies to the vaults, not to this
// plugin's own configuration.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { normalizeLinkConfig } from './registry.js';

export const SETTINGS_ROUTE_BASE = '/dsh-mnemon-source-link';
const MAX_BYTES = 64 * 1024;

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

interface ConfigEditorLike {
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
}

export interface SettingsBridgeDeps {
  webServer: WebServerLike;
  configEditor: ConfigEditorLike | undefined;
  entry: unknown;
  config: unknown;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function registerSettingsBridge(deps: SettingsBridgeDeps): () => void {
  return deps.webServer.register({
    kind: 'prefix',
    path: `${SETTINGS_ROUTE_BASE}/config`,
    handler: (req, res) => {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        send(res, 200, { ok: true, config: deps.config ?? {} });
        return;
      }
      if (method !== 'PUT') {
        res.statusCode = 405;
        res.end('method not allowed');
        return;
      }

      let body = '';
      let settled = false;
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        body += chunk.toString('utf8');
        if (body.length > MAX_BYTES) {
          settled = true;
          send(res, 413, { ok: false, error: 'payload too large' });
          req.destroy();
        }
      });
      req.on('end', () => {
        if (settled) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(body === '' ? '{}' : body);
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          send(res, 400, { ok: false, error: 'config must be a JSON object' });
          return;
        }
        try {
          normalizeLinkConfig(parsed);
        } catch (error) {
          send(res, 400, { ok: false, error: (error as Error).message });
          return;
        }
        if (deps.configEditor === undefined || deps.entry === undefined) {
          send(res, 503, { ok: false, error: 'configuration cannot be saved in this profile' });
          return;
        }
        deps.configEditor
          .edit(deps.entry, () => parsed as Record<string, unknown>)
          .then(
            () => send(res, 200, { ok: true, config: parsed }),
            (error: unknown) =>
              send(res, 500, { ok: false, error: String((error as Error)?.message ?? error) }),
          );
      });
      req.on('error', () => {
        if (settled) return;
        settled = true;
        send(res, 400, { ok: false, error: 'request error' });
      });
    },
  });
}
