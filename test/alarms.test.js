'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const a = require('../lib/alarms');

const NOW = Date.parse('2026-10-21T10:00:00Z');
const opts = (o) => ({ minState: 'alert', updateSeconds: 120, ...o });
const n = (state, message = '', ts = '2026-10-21T09:59:00.000Z') => ({ state, message, ts });
const sent = (state, message = '', ago = 600) => ({ state, message, sentAt: NOW - ago * 1000 });
// fake app.getSelfPath over a flat { path: value } map
const getter = (values, timestamps = {}) => (p) =>
  p in values ? { value: values[p], timestamp: timestamps[p] || '2026-10-21T09:59:00.000Z' } : undefined;

test('Zustandswechsel: neu, gleich, Anstieg, Schließen', () => {
  assert.deepStrictEqual(a.decide(null, n('alert'), opts(), NOW), { kind: 'change' });
  assert.strictEqual(a.decide(sent('alert'), n('alert'), opts(), NOW), null);
  assert.deepStrictEqual(a.decide(sent('alert'), n('emergency'), opts(), NOW), { kind: 'change' });
  assert.deepStrictEqual(a.decide(sent('emergency'), n('normal'), opts(), NOW), { kind: 'change' });
  assert.strictEqual(a.decide(null, n('normal'), opts(), NOW), null, 'normal ohne offenen Alarm');
  assert.strictEqual(a.decide(sent('normal'), n('normal'), opts(), NOW), null);
  assert.strictEqual(a.normState('nominal'), 'normal');
  assert.strictEqual(a.normState('bogus'), null);
  assert.deepStrictEqual(a.toNotification(null, 't'), { state: 'normal', message: '', ts: 't' });
  assert.strictEqual(a.toNotification({ message: 'ohne state' }, 't'), null);
});

test('Abstieg unter minState wird gesendet, solange am Server ein Alarm offen ist', () => {
  const o = opts({ minState: 'warn' });
  assert.strictEqual(a.decide(null, n('alert'), o, NOW), null, 'Hinweis unter der Schwelle');
  assert.deepStrictEqual(a.decide(null, n('warn'), o, NOW), { kind: 'change' });
  assert.deepStrictEqual(a.decide(sent('warn'), n('alert'), o, NOW), { kind: 'change' });
  assert.deepStrictEqual(a.decide(sent('alert'), n('normal'), o, NOW), { kind: 'change' });
  assert.strictEqual(a.decide(sent('normal'), n('alert'), o, NOW), null);
});

test('Update-Drossel: nur ab Alarm, höchstens alle updateSeconds', () => {
  const o = opts();
  assert.deepStrictEqual(a.decide(sent('alarm', 'alt', 30), n('alarm', 'neu'), o, NOW), { waitMs: 90000 });
  assert.deepStrictEqual(a.decide(sent('alarm', 'alt', 120), n('alarm', 'neu'), o, NOW), { kind: 'update' });
  assert.deepStrictEqual(a.decide(sent('emergency', 'alt'), n('emergency', 'neu'), o, NOW), { kind: 'update' });
  assert.strictEqual(a.decide(sent('alarm', 'gleich'), n('alarm', 'gleich'), o, NOW), null);
  assert.strictEqual(a.decide(sent('warn', 'alt'), n('warn', 'neu'), o, NOW), null, 'Warnung: kein Update');
  assert.strictEqual(a.decide(sent('alarm', 'alt'), n('alarm', 'neu'), opts({ updateSeconds: 0 }), NOW), null);
  assert.strictEqual(
    a.decide(sent('alarm', 'alt'), n('alarm', 'neu'), opts({ minState: 'emergency' }), NOW),
    null,
    'unter minState: kein Update'
  );
});

test('Start mit Altwerten: Baum einlesen, gleicher Zustand → nichts', () => {
  const tree = {
    navigation: {
      anchor: {
        value: { state: 'emergency', message: 'Anker slippt' },
        $source: 'anchoralarm',
        timestamp: '2026-10-21T09:00:00.000Z',
        values: {
          anchoralarm: { value: { state: 'emergency', message: 'Anker slippt' }, timestamp: '2026-10-21T09:00:00.000Z' },
          'mareas-ihm': { value: { state: 'normal', message: 'Plugin restarted' }, timestamp: '2026-10-21T09:30:00.000Z' },
        },
      },
    },
    environment: {
      wetterwacht: { value: { state: 'warn', message: 'Gewitter' }, $source: 'signalk-wetterwacht', timestamp: 't1' },
    },
    alarm: { bilge: { value: null, $source: 'signalk-piface', timestamp: 't2' }, meta: { x: 1 } },
  };
  const list = a.collect(tree);
  assert.deepStrictEqual(
    list.map((x) => [x.path, x.source, x.state]),
    [
      ['notifications.navigation.anchor', 'anchoralarm', 'emergency'],
      ['notifications.navigation.anchor', 'mareas-ihm', 'normal'],
      ['notifications.environment.wetterwacht', 'signalk-wetterwacht', 'warn'],
      ['notifications.alarm.bilge', 'signalk-piface', 'normal'],
    ]
  );
  const anchor = a.effective({ anchoralarm: list[0], 'mareas-ihm': list[1] });
  assert.strictEqual(anchor.state, 'emergency', 'höchster Zustand über die Quellen');
  assert.strictEqual(a.decide(sent('emergency', 'Anker slippt'), anchor, opts(), NOW), null);
  assert.strictEqual(a.effective({}), null);
});

test('Pfadfilter: ganze Segmente, Testpfad immer, Serverpfad nie', () => {
  const p = a.parsePaths(' notifications.navigation.anchor , notifications.alarm,');
  assert.deepStrictEqual(p, ['notifications.navigation.anchor', 'notifications.alarm', a.TEST_PATH]);
  assert.ok(a.matches('notifications.navigation.anchor', p));
  assert.ok(a.matches('notifications.alarm.bilge', p));
  assert.ok(a.matches(a.TEST_PATH, p));
  assert.ok(!a.matches('notifications.navigation.anchorDrag', p));
  assert.ok(!a.matches('notifications.server.newVersion', p));
  assert.ok(!a.matches('notifications.bordops.connection', ['notifications.bordops']));
  assert.ok(a.matches('notifications.x.y', ['notifications.']));
});

test('event_id: deterministisch, ≤ 64 Zeichen, je Zustand/Zeit verschieden', () => {
  const id = a.eventId('notifications.navigation.anchor', 'alarm', 'change', '2026-10-21T09:59:00.000Z');
  assert.match(id, /^sk-[0-9a-f]{20}$/);
  assert.strictEqual(id, a.eventId('notifications.navigation.anchor', 'alarm', 'change', '2026-10-21T09:59:00.000Z'));
  assert.notStrictEqual(id, a.eventId('notifications.navigation.anchor', 'warn', 'change', '2026-10-21T09:59:00.000Z'));
  assert.notStrictEqual(id, a.eventId('notifications.navigation.anchor', 'alarm', 'change', '2026-10-21T09:59:01.000Z'));
  assert.notStrictEqual(id, a.eventId('notifications.navigation.anchor', 'alarm', 'update', '2026-10-21T09:59:00.000Z'));
});

test('Anreicherung Anker: Position, Anker, Radius, Tiefe; fehlende Werte weg', () => {
  const get = getter({
    'navigation.position': { latitude: 43.73512345, longitude: 15.89121111 },
    'navigation.anchor.position': { latitude: 43.7349, longitude: 15.8905, altitude: -7 },
    'navigation.anchor.maxRadius': 45,
    'navigation.anchor.currentRadius': 62.04,
    'environment.depth.belowSurface': null,
  });
  const e = a.buildEvent('notifications.navigation.anchor', n('emergency', 'Anker slippt'), 'change', get, NOW);
  assert.deepStrictEqual(e, {
    event_id: a.eventId('notifications.navigation.anchor', 'emergency', 'change', '2026-10-21T09:59:00.000Z'),
    path: 'notifications.navigation.anchor',
    state: 'emergency',
    kind: 'change',
    occurred_at: '2026-10-21T09:59:00.000Z',
    latitude: 43.735123,
    longitude: 15.891211,
    data: { anchor_latitude: 43.7349, anchor_longitude: 15.8905, max_radius_m: 45, current_radius_m: 62 },
    message: 'Anker slippt',
  });
  const bare = a.buildEvent(a.TEST_PATH, n('alarm'), 'change', getter({}), NOW);
  assert.deepStrictEqual(Object.keys(bare), ['event_id', 'path', 'state', 'kind', 'occurred_at']);
});

test('Anreicherung Wetter: m/s → kn, Stufentext, nur vorhandene Werte', () => {
  const get = getter({
    'environment.wetterwacht.level': 4,
    'environment.wetterwacht.headline': 'Gewitterfront',
    'environment.wetterwacht.detail': 'Böen 45 kn',
    'environment.wetterwacht.windExpected': 9,
    'environment.wetterwacht.gustExpected': 18,
    'environment.wetterwacht.thunderProbability': 0.456,
    'environment.wetterwacht.sources': 'Lokal · Modell',
    'environment.wetterwacht.eta': null,
  });
  assert.deepStrictEqual(a.enrich('notifications.environment.wetterwacht', get).data, {
    level: 4,
    level_text: 'Akut',
    headline: 'Gewitterfront',
    detail: 'Böen 45 kn',
    wind_expected_kn: 17.5,
    gust_expected_kn: 35,
    thunder_probability: 0.46,
    sources: 'Lokal · Modell',
  });
  assert.deepStrictEqual(a.enrich('notifications.alarm.bilge', get), {});
});

test('occurred_at: Signal-K-Zeit, sonst jetzt (fehlend, > 7 Tage, Zukunft)', () => {
  const at = (ts) => a.buildEvent(a.TEST_PATH, { state: 'alarm', message: '', ts }, 'change', getter({}), NOW).occurred_at;
  assert.strictEqual(at('2026-10-21T08:00:00.000Z'), '2026-10-21T08:00:00.000Z');
  assert.strictEqual(at(undefined), '2026-10-21T10:00:00.000Z');
  assert.strictEqual(at('2026-10-10T08:00:00.000Z'), '2026-10-21T10:00:00.000Z');
  assert.strictEqual(at('2026-10-21T10:30:00.000Z'), '2026-10-21T10:00:00.000Z');
});

test('Schlange: älter als 7 Tage weg, höchstens 500', () => {
  const ev = (i, ageMs) => ({ event_id: `e${i}`, occurred_at: new Date(NOW - ageMs).toISOString() });
  assert.deepStrictEqual(a.prune([ev(1, 8 * 86400e3), ev(2, 86400e3)], NOW).map((e) => e.event_id), ['e2']);
  const many = Array.from({ length: 510 }, (_, i) => ev(i, 1000));
  const kept = a.prune(many, NOW);
  assert.strictEqual(kept.length, a.QUEUE_MAX);
  assert.strictEqual(kept[0].event_id, 'e10', 'die ältesten fallen zuerst');
});

test('Batch-Antworten: Urteil leert, Fehler behalten', () => {
  const batch = [{ event_id: 'e1' }, { event_id: 'e2' }];
  assert.deepStrictEqual(
    a.batchResult(batch, 200, { accepted: ['e1'], rejected: [{ event_id: 'e2', reason: 'occurred_at too old' }] }, 'lana'),
    { remove: ['e1', 'e2'], accepted: 1, rejected: [{ event_id: 'e2', reason: 'occurred_at too old' }], error: null }
  );
  assert.deepStrictEqual(a.batchResult(batch, 401, {}, 'lana'), { retry: true, error: 'auth failed (HTTP 401) — check token' });
  assert.deepStrictEqual(
    a.batchResult(batch, 403, { message: 'Modul Bordalarme ist fuer dieses Schiff nicht aktiv.' }, 'lana'),
    { retry: true, error: 'forbidden (HTTP 403): Modul Bordalarme ist fuer dieses Schiff nicht aktiv.' }
  );
  assert.deepStrictEqual(a.batchResult(batch, 404, null, 'lana'), {
    retry: true,
    error: "boat 'lana' not found (HTTP 404) — check boat code",
  });
  assert.deepStrictEqual(a.batchResult(batch, 503, null, 'lana'), { retry: true, error: 'HTTP 503' });
  assert.deepStrictEqual(a.batchResult(batch, 429, { message: 'Too Many Attempts.' }, 'lana'), {
    retry: true,
    error: 'HTTP 429: Too Many Attempts.',
  });
  const whole = a.batchResult(batch, 422, { message: 'The events field is required.' }, 'lana');
  assert.deepStrictEqual(whole.remove, ['e1'], '422 ohne Einzelurteil: nur das älteste fällt');
});

test('Backoff: 5 s, 15 s, 30 s, dann jede Minute', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 20].map(a.backoffMs), [5000, 15000, 30000, 60000, 60000, 60000]);
});

test('Lebenszeichen: anchor bei gesetztem Anker, weather bei frischer Stufe', () => {
  const fresh = new Date(NOW - 5 * 60e3).toISOString();
  const stale = new Date(NOW - 11 * 60e3).toISOString();
  const pos = { latitude: 43.7, longitude: 15.8 };
  assert.deepStrictEqual(
    a.watches(getter({ 'navigation.anchor.position': pos, 'environment.wetterwacht.level': 1 }, { 'environment.wetterwacht.level': fresh }), NOW),
    ['anchor', 'weather']
  );
  assert.deepStrictEqual(
    a.watches(getter({ 'navigation.anchor.position': null, 'environment.wetterwacht.level': 1 }, { 'environment.wetterwacht.level': stale }), NOW),
    []
  );
});
