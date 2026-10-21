'use strict';

// Plugin wiring with a fake Signal K app and a mocked fetch:
// test route → bus → queue → alarms/batch, restart, offline, heartbeat.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

function fakeApp(dir, tree = {}) {
  const subs = [];
  const status = [];
  const app = {
    tree,
    streambundle: {
      getSelfBus: (p) => ({
        onValue: (cb) => {
          const s = { p, cb };
          subs.push(s);
          return () => subs.splice(subs.indexOf(s), 1);
        },
      }),
    },
    getSelfPath: (p) => p.split('.').reduce((n, k) => (n ? n[k] : undefined), app.tree),
    getDataDirPath: () => dir,
    handleMessage: (id, delta) => {
      const timestamp = new Date().toISOString();
      for (const u of delta.updates) {
        for (const v of u.values) {
          subs.filter((s) => !s.p || s.p === v.path).forEach((s) => s.cb({ path: v.path, value: v.value, $source: id, timestamp }));
        }
      }
    },
    setPluginStatus: (m) => status.push(m),
    setPluginError: (m) => status.push('ERR ' + m),
    debug: () => {},
  };
  return { app, status };
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return handler(url, body);
  };
  return calls;
}

const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
const acceptAll = (url, body) =>
  url.endsWith('/heartbeat') ? reply(204, null) : reply(200, { accepted: body.events.map((e) => e.event_id), rejected: [] });

function setup(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bordops-'));
  const { app, status } = fakeApp(dir, tree);
  const plugin = require('..')(app);
  const routes = {};
  plugin.registerWithRouter({ post: (r, h) => (routes[r] = h), get: () => {} });
  const post = (r, body) => {
    let out;
    const res = { json: (b) => (out = { code: 200, body: b }), status: (code) => ({ json: (b) => (out = { code, body: b }) }) };
    routes[r]({ body }, res);
    return out;
  };
  const options = { serverUrl: 'https://test.bordops.eu/', boatCode: 'lana', token: 'secret' };
  return { dir, app, status, plugin, post, options };
}

let running = [];
afterEach(() => {
  running.forEach((p) => p.stop());
  running = [];
});

const batches = (calls) => calls.filter((c) => c.url.endsWith('/alarms/batch'));

test('Testalarm: Route → Batch; gleicher Zustand nichts; normal schließt', async () => {
  const calls = mockFetch(acceptAll);
  const s = setup();
  s.plugin.start(s.options);
  running.push(s.plugin);
  await settle();

  const hb = calls.find((c) => c.url === 'https://test.bordops.eu/api/v1/boats/lana/alarms/heartbeat');
  assert.ok(hb, 'Lebenszeichen gleich beim Start');
  assert.deepStrictEqual(hb.body.watches, []);
  assert.strictEqual(hb.body.plugin_version, require('../package.json').version);

  assert.strictEqual(s.post('/test-alarm', {}).body.state, 'alarm');
  await settle();
  s.post('/test-alarm', { state: 'alarm' });
  await settle();
  s.post('/test-alarm', { state: 'normal' });
  await settle();

  const sent = batches(calls).map((c) => c.body.events.map((e) => [e.path, e.state, e.kind]));
  assert.deepStrictEqual(sent, [
    [['notifications.bordops.test', 'alarm', 'change']],
    [['notifications.bordops.test', 'normal', 'change']],
  ]);
  assert.strictEqual(s.post('/test-alarm', { state: 'kaputt' }).code, 400);
  assert.match(s.status.at(-1), /alarms: 2 sent, last \d\d:\d\d:\d\dZ, queue 0$/);
});

test('Neustart mit Altwerten: keine doppelten Ereignisse, neuer Zustand schon', async () => {
  const calls = mockFetch(acceptAll);
  const s = setup();
  s.plugin.start(s.options);
  s.post('/test-alarm', { state: 'emergency' });
  await settle();
  s.plugin.stop();
  assert.strictEqual(batches(calls).length, 1);

  // Signal K still holds the value (plugin restart) → same state, nothing sent
  s.app.tree = {
    notifications: {
      bordops: { test: { value: { state: 'emergency', message: 'x' }, $source: 'signalk-bordops', timestamp: new Date().toISOString() } },
    },
  };
  s.plugin.start(s.options);
  running.push(s.plugin);
  await settle();
  assert.strictEqual(batches(calls).length, 1);

  s.post('/test-alarm', { state: 'normal' });
  await settle();
  assert.deepStrictEqual(batches(calls)[1].body.events.map((e) => e.state), ['normal']);
});

test('Alarm vor dem Start (Wetterwacht meldet nur Wechsel) wird beim Start nachgereicht', async () => {
  const calls = mockFetch(acceptAll);
  const now = new Date().toISOString();
  const s = setup({
    navigation: { position: { value: { latitude: 48.1, longitude: 11.5 }, timestamp: now } },
    environment: { wetterwacht: { level: { value: 4, timestamp: now }, gustExpected: { value: 20, timestamp: now } } },
    notifications: {
      environment: { wetterwacht: { value: { state: 'emergency', message: 'Gewitter' }, $source: 'signalk-wetterwacht', timestamp: now } },
      server: { newVersion: { value: { state: 'alert', message: 'update' }, $source: 'signalk-server', timestamp: now } },
    },
  });
  s.plugin.start(s.options);
  running.push(s.plugin);
  await settle();
  const [batch] = batches(calls);
  assert.strictEqual(batch.body.events.length, 1, 'nur konfigurierte Pfade');
  const e = batch.body.events[0];
  assert.deepStrictEqual([e.path, e.state, e.latitude, e.data.level_text, e.data.gust_expected_kn], [
    'notifications.environment.wetterwacht', 'emergency', 48.1, 'Akut', 38.9,
  ]);
  assert.deepStrictEqual(calls.find((c) => c.url.endsWith('/heartbeat')).body.watches, ['weather']);
});

test('Offline: Schlange bleibt auf der Platte, neues Ereignis schickt beides in einem Batch', async () => {
  let online = false;
  const calls = mockFetch((url, body) => {
    if (!online) throw new Error('getaddrinfo ENOTFOUND');
    return acceptAll(url, body);
  });
  const s = setup();
  s.plugin.start(s.options);
  running.push(s.plugin);
  s.post('/test-alarm', { state: 'alarm' });
  await settle();
  assert.match(s.status.at(-1), /^ERR .*queue 1, error: offline \(getaddrinfo ENOTFOUND\)/);
  const file = JSON.parse(fs.readFileSync(path.join(s.dir, 'bordops-alarm-queue.json'), 'utf8'));
  assert.deepStrictEqual(file.map((e) => e.state), ['alarm']);

  online = true;
  s.post('/test-alarm', { state: 'normal' });
  await settle();
  const last = batches(calls).at(-1);
  assert.deepStrictEqual(last.body.events.map((e) => e.state), ['alarm', 'normal']);
  // the heartbeat failed at start and is only retried with the next one
  assert.match(s.status.at(-1), /alarms: 2 sent, last .*queue 0, heartbeat: offline/);
});

test('403 (Modul aus): Schlange bleibt, Fehler im Status', async () => {
  mockFetch(() => reply(403, { message: 'Modul Bordalarme ist fuer dieses Schiff nicht aktiv.' }));
  const s = setup();
  s.plugin.start(s.options);
  running.push(s.plugin);
  s.post('/test-alarm', { state: 'alarm' });
  await settle();
  assert.match(s.status.at(-1), /queue 1, error: forbidden \(HTTP 403\): Modul Bordalarme/);
});

test('Alarme aus: kein Abo, kein Lebenszeichen, Route 503', async () => {
  const calls = mockFetch(acceptAll);
  const s = setup();
  s.plugin.start({ ...s.options, alarms: { enabled: false } });
  running.push(s.plugin);
  await settle();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(s.post('/test-alarm', {}).code, 503);
  assert.match(s.status.at(-1), /alarms off$/);
});
