import { EventEmitter } from 'node:events';
import { test, expect } from 'vitest';
import { registerSettingsBridge } from '../src/settings';

interface Route {
  handler: (req: unknown, res: unknown) => void | Promise<void>;
}

function captureRoute(): { route: Route; dispose: () => void } {
  let route: Route | undefined;
  const dispose = registerSettingsBridge({
    webServer: {
      register: (value: Route) => {
        route = value;
        return () => undefined;
      },
    } as never,
    configEditor: undefined,
    entry: { id: 'mnemon-source-link' },
    config: {},
  });
  if (route === undefined) throw new Error('route not registered');
  return { route, dispose };
}

function request(method: string, body?: string): EventEmitter & { method: string } {
  const req = new EventEmitter() as EventEmitter & { method: string };
  req.method = method;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req;
}

function response(): { statusCode: number; headers: Record<string, string>; body: string; setHeader: (k: string, v: string) => void; end: (v: string) => void } {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    end(value: string) {
      this.body = value;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('GET returns the current configuration', async () => {
  let route: Route | undefined;
  registerSettingsBridge({
    webServer: { register: (value: Route) => { route = value; return () => undefined; } } as never,
    configEditor: undefined,
    entry: { id: 'mnemon-source-link' },
    config: { obsidian: { enabled: true, root: 'C:/vault' } },
  });
  const res = response();
  await route!.handler(request('GET'), res);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).config.obsidian.enabled).toBe(true);
});

test('PUT persists a valid configuration through configEditor.edit', async () => {
  let route: Route | undefined;
  let edited: Record<string, unknown> | undefined;
  registerSettingsBridge({
    webServer: { register: (value: Route) => { route = value; return () => undefined; } } as never,
    configEditor: {
      edit: (_entry: unknown, change: (c: Record<string, unknown>, i: Record<string, unknown>) => Record<string, unknown>) => {
        edited = change({}, {});
        return Promise.resolve();
      },
    },
    entry: { id: 'mnemon-source-link' },
    config: {},
  });
  const cfg = {
    obsidian: { enabled: true, root: 'C:/vault' },
    loginote: { enabled: false, root: '' },
    ledger: { enabled: false, root: '' },
    maxFiles: 5000,
    maxFileBytes: 1048576,
  };
  const res = response();
  await route!.handler(request('PUT', JSON.stringify(cfg)), res);
  await tick();
  expect(res.statusCode).toBe(200);
  expect((edited as { obsidian: { root: string } }).obsidian.root).toBe('C:/vault');
});

test('PUT rejects an enabled source whose root is not absolute', async () => {
  const { route } = captureRoute();
  const res = response();
  await route.handler(request('PUT', JSON.stringify({ obsidian: { enabled: true, root: 'rel/x' } })), res);
  await tick();
  expect(res.statusCode).toBe(400);
});

test('PUT returns 503 when no config editor is available', async () => {
  const { route } = captureRoute();
  const res = response();
  await route.handler(
    request('PUT', JSON.stringify({ obsidian: { enabled: false, root: '' } })),
    res,
  );
  await tick();
  expect(res.statusCode).toBe(503);
});
