'use strict';

/*
 * Pure helpers for forwarding Signal K notifications to BordOps.
 * No I/O and no timers — index.js owns the bus, the files and fetch.
 *
 * BordOps alarm API (contract: bordops docs/auftrag-alarme.md §2):
 *  - POST …/alarms/batch      { events: [ { event_id, path, state, kind,
 *        message?, occurred_at, latitude?, longitude?, data? } ] }  (1–100)
 *    → 200 { accepted: [ids], rejected: [{ event_id, reason }] }
 *  - POST …/alarms/heartbeat  { at, watches, plugin_version } → 204
 *  - 403 also means "alarm module not active for this boat".
 */

const crypto = require('crypto');

const MS_TO_KNOTS = 1.9438444924;
const RANK = { normal: 0, alert: 1, warn: 2, alarm: 3, emergency: 4 };
const TEST_PATH = 'notifications.bordops.test';
const SERVER_PATH = 'notifications.bordops.connection'; // set by the server only
const ANCHOR_PATH = 'notifications.navigation.anchor';
const WEATHER_PATH = 'notifications.environment.wetterwacht';
const DEFAULT_PATHS = `${ANCHOR_PATH}, ${WEATHER_PATH}, notifications.alarm`;
const BATCH_MAX = 100; // server limit per request
const QUEUE_MAX = 500;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // server rejects older events
const BACKOFF_S = [5, 15, 30, 60]; // then every minute
const WEATHER_FRESH_MS = 10 * 60 * 1000;
const WEATHER_LEVELS = ['Ruhig', 'Hinweis', 'Warnung', 'Sturm', 'Akut']; // as signalk-wetterwacht

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d) => Number(v.toFixed(d));
const valueOf = (get, p) => {
  const n = get(p);
  return n ? n.value : undefined;
};

function normState(s) {
  if (s === 'nominal') return 'normal';
  return Object.prototype.hasOwnProperty.call(RANK, s) ? s : null;
}

/** Signal K notification value → { state, message, ts } or null; a cleared (null) value counts as normal. */
function toNotification(value, ts) {
  if (value === null) return { state: 'normal', message: '', ts };
  const state = value && typeof value === 'object' ? normState(value.state) : null;
  if (!state) return null;
  return { state, message: typeof value.message === 'string' ? value.message : '', ts };
}

/** "a, b" → prefix list; the test path is always forwarded. */
function parsePaths(list) {
  const prefixes = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
  return prefixes.includes(TEST_PATH) ? prefixes : prefixes.concat(TEST_PATH);
}

/** Prefix match on whole path segments: "…anchor" matches "…anchor.x", not "…anchorDrag". */
function matches(path, prefixes) {
  if (path === SERVER_PATH) return false;
  return prefixes.some((p) => path === p || path.startsWith(p.endsWith('.') ? p : p + '.'));
}

/**
 * Several plugins may write the same path (anchoralarm and mareas-ihm both use
 * notifications.navigation.anchor). Without a source priority Signal K passes
 * all of them through, so the highest state across sources wins; on a tie the newest.
 * @param sources { [sourceRef]: { state, message, ts } }
 */
function effective(sources) {
  let best = null;
  for (const n of Object.values(sources || {})) {
    const d = best ? RANK[n.state] - RANK[best.state] : 1;
    if (d > 0 || (d === 0 && Date.parse(n.ts) > Date.parse(best.ts))) best = n;
  }
  return best;
}

/**
 * What to send for a path whose effective notification is `cur`, given the
 * last event queued for it (`prev`, persisted across restarts).
 * Returns { kind: 'change'|'update' }, { waitMs } (text update throttled) or null.
 */
function decide(prev, cur, opts, nowMs) {
  const last = prev ? prev.state : 'normal';
  if (cur.state !== last) {
    if (RANK[cur.state] >= RANK[opts.minState]) return { kind: 'change' };
    // below the threshold, but the server still holds an open alarm for it
    return last !== 'normal' ? { kind: 'change' } : null;
  }
  if (!prev || !opts.updateSeconds || cur.message === prev.message) return null;
  if (RANK[cur.state] < Math.max(RANK.alarm, RANK[opts.minState])) return null;
  const waitMs = prev.sentAt + opts.updateSeconds * 1000 - nowMs;
  return waitMs > 0 ? { waitMs } : { kind: 'update' };
}

/** Deterministic, so a value replayed after a restart maps onto the same event. */
function eventId(path, state, kind, ts) {
  const h = crypto.createHash('sha256').update([path, state, kind, ts || ''].join('|'));
  return 'sk-' + h.digest('hex').slice(0, 20);
}

function putNum(data, key, v, digits, factor = 1) {
  if (isNum(v)) data[key] = round(v * factor, digits);
}

function putText(data, key, v) {
  if (typeof v === 'string' && v) data[key] = v.slice(0, 300);
  else if (Array.isArray(v) && v.length) data[key] = v.filter((x) => typeof x === 'string').slice(0, 10);
}

/** Boat position and path-specific data at the time of the event; missing values are left out. */
function enrich(path, get) {
  const out = {};
  const pos = valueOf(get, 'navigation.position');
  if (pos && isNum(pos.latitude) && isNum(pos.longitude)) {
    out.latitude = round(pos.latitude, 6);
    out.longitude = round(pos.longitude, 6);
  }

  const data = {};
  if (matches(path, [ANCHOR_PATH])) {
    const a = valueOf(get, 'navigation.anchor.position');
    if (a && isNum(a.latitude) && isNum(a.longitude)) {
      data.anchor_latitude = round(a.latitude, 6);
      data.anchor_longitude = round(a.longitude, 6);
    }
    putNum(data, 'max_radius_m', valueOf(get, 'navigation.anchor.maxRadius'), 1);
    putNum(data, 'current_radius_m', valueOf(get, 'navigation.anchor.currentRadius'), 1);
    putNum(data, 'depth_m', valueOf(get, 'environment.depth.belowSurface'), 1);
  } else if (matches(path, [WEATHER_PATH])) {
    const w = (k) => valueOf(get, `environment.wetterwacht.${k}`);
    const level = w('level');
    if (Number.isInteger(level)) {
      data.level = level;
      if (WEATHER_LEVELS[level]) data.level_text = WEATHER_LEVELS[level];
    }
    putText(data, 'headline', w('headline'));
    putText(data, 'detail', w('detail'));
    putNum(data, 'wind_expected_kn', w('windExpected'), 1, MS_TO_KNOTS);
    putNum(data, 'gust_expected_kn', w('gustExpected'), 1, MS_TO_KNOTS);
    putNum(data, 'thunder_probability', w('thunderProbability'), 2);
    putText(data, 'sources', w('sources'));
  }
  if (Object.keys(data).length) out.data = data;
  return out;
}

/** One event for the batch; occurred_at falls back to now when the Signal K time is unusable. */
function buildEvent(path, n, kind, get, nowMs) {
  const ts = Date.parse(n.ts);
  const usable = ts > nowMs - MAX_AGE_MS + 3600 * 1000 && ts < nowMs + 4 * 60 * 1000;
  const event = {
    event_id: eventId(path, n.state, kind, n.ts),
    path,
    state: n.state,
    kind,
    occurred_at: new Date(usable ? ts : nowMs).toISOString(),
    ...enrich(path, get),
  };
  if (n.message) event.message = n.message.slice(0, 500);
  return event;
}

/** Drops events the server would reject as too old, then the oldest beyond QUEUE_MAX. */
function prune(queue, nowMs) {
  const fresh = queue.filter((e) => Date.parse(e.occurred_at) > nowMs - MAX_AGE_MS);
  return fresh.length > QUEUE_MAX ? fresh.slice(fresh.length - QUEUE_MAX) : fresh;
}

function backoffMs(attempt) {
  return BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)] * 1000;
}

function httpError(status, body, boatCode) {
  const hint = body && typeof body.message === 'string' ? `: ${body.message.slice(0, 80)}` : '';
  if (status === 401) return 'auth failed (HTTP 401) — check token';
  if (status === 403) return `forbidden (HTTP 403)${hint}`;
  if (status === 404) return `boat '${boatCode}' not found (HTTP 404) — check boat code`;
  return `HTTP ${status}${hint}`;
}

/**
 * Interprets the answer to alarms/batch.
 * → { remove: [event_id], accepted, rejected: [{ event_id, reason }], error } or { retry: true, error }
 * Accepted and rejected events leave the queue (a rejected one never gets better);
 * 401/403/404 and server errors keep it and retry.
 */
function batchResult(batch, status, body, boatCode) {
  const verdict = body && (Array.isArray(body.accepted) || Array.isArray(body.rejected));
  if (verdict && (status < 300 || status === 422)) {
    return {
      remove: batch.map((e) => e.event_id),
      accepted: (body.accepted || []).length,
      rejected: body.rejected || [],
      error: null,
    };
  }
  if (status === 422) {
    // whole batch refused (cannot happen with valid batches) — drop the oldest so it can't jam the queue
    const reason = `batch rejected (HTTP 422)${body && body.message ? ': ' + String(body.message).slice(0, 60) : ''}`;
    return { remove: [batch[0].event_id], accepted: 0, rejected: [{ event_id: batch[0].event_id, reason }], error: reason };
  }
  return { retry: true, error: httpError(status, body, boatCode) };
}

/** What is being watched on board right now (heartbeat). */
function watches(get, nowMs) {
  const list = [];
  const a = valueOf(get, 'navigation.anchor.position');
  if (a && isNum(a.latitude) && isNum(a.longitude)) list.push('anchor');
  const level = get('environment.wetterwacht.level');
  if (level && level.value != null && nowMs - Date.parse(level.timestamp) < WEATHER_FRESH_MS) list.push('weather');
  return list;
}

/** Flattens app.getSelfPath('notifications') into [{ path, source, state, message, ts }]. */
function collect(tree, prefix = 'notifications') {
  const out = [];
  (function walk(node, p) {
    if (!node || typeof node !== 'object') return;
    if ('value' in node && (node.value === null || (typeof node.value === 'object' && 'state' in node.value))) {
      const values = node.values && Object.keys(node.values).length ? node.values : { [node.$source]: node };
      for (const [source, v] of Object.entries(values)) {
        const n = v && toNotification(v.value, v.timestamp);
        if (n) out.push({ path: p, source, ...n });
      }
      return;
    }
    for (const [k, child] of Object.entries(node)) {
      if (k !== 'meta' && k[0] !== '$') walk(child, `${p}.${k}`);
    }
  })(tree, prefix);
  return out;
}

module.exports = {
  RANK,
  TEST_PATH,
  DEFAULT_PATHS,
  BATCH_MAX,
  QUEUE_MAX,
  normState,
  toNotification,
  parsePaths,
  matches,
  effective,
  decide,
  eventId,
  enrich,
  buildEvent,
  prune,
  backoffMs,
  httpError,
  batchResult,
  watches,
  collect,
};
