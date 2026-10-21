'use strict';

/*
 * signalk-bordops — sends the vessel position from Signal K to BordOps.
 *
 * Design goals (mirrors the BordOps iOS tracker):
 *  - Adaptive sampling: sparse at anchor, dense while manoeuvring.
 *  - Offline-first: points are queued on disk and uploaded in batches;
 *    a netless passage loses nothing (server accepts up to 30 days back).
 *  - Zero dependencies: Node >= 18 ships fetch natively.
 *
 * BordOps API contract (POST {serverUrl}/api/v1/boats/{boatCode}/positions/batch):
 *  - Authorization: Bearer <token>   (boat API token with write ability)
 *  - Body: { positions: [ { idempotency_key, recorded_at, latitude,
 *            longitude, speed_knots?, heading_deg?, accuracy_m?, source } ] }
 *  - Response: { accepted: [keys], rejected: [{idempotency_key, reason}] }
 *  - Per boat+timestamp exactly one point is stored server-side, so
 *    retries with the same recorded_at are always safe.
 *
 * Alarms (since 0.2.0): state changes of selected notifications.* paths go
 * to …/alarms/batch right away (own disk queue, backoff), plus a heartbeat
 * every 5 min for the server's connection watch. Logic in lib/alarms.js.
 */

const fs = require('fs');
const path = require('path');
const alarms = require('./lib/alarms');

const VERSION = require('./package.json').version;
const MS_TO_KNOTS = 1.9438444924;
const RAD_TO_DEG = 180 / Math.PI;
const BATCH_LIMIT = 500; // server-side maximum per request
const REQUEST_TIMEOUT_MS = 20000; // alarm requests only

module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let uploadTimer = null;
  let queue = [];
  let queueFile = null;
  let dirtySinceSave = 0;
  let lastSent = null; // { time: ms, lat, lon, heading }
  let stats = { queued: 0, uploaded: 0, rejected: 0, lastError: null, lastUpload: null, lastReject: null };
  let al = null; // alarm forwarding state, null while not running

  plugin.id = 'signalk-bordops';
  plugin.name = 'BordOps Position & Alarm Reporter';
  plugin.description =
    'Sends the vessel position (adaptive sampling, offline buffering) and alarms (Signal K notifications) to BordOps (bordops.eu).';

  plugin.schema = {
    type: 'object',
    required: ['boatCode', 'token'],
    properties: {
      serverUrl: {
        type: 'string',
        title: 'BordOps server URL',
        default: 'https://bordops.eu',
      },
      boatCode: {
        type: 'string',
        title: 'Boat code',
        description:
          'The short code of your boat in BordOps (shown on the tracker page).',
      },
      token: {
        type: 'string',
        title: 'API token',
        description:
          'A boat API token with write access. Create one on the BordOps tracker page.',
      },
      minIntervalSeconds: {
        type: 'number',
        title: 'Minimum interval (s)',
        description: 'Never record more often than this.',
        default: 10,
      },
      maxIntervalSeconds: {
        type: 'number',
        title: 'Maximum interval (s)',
        description: 'Record at least this often while a fix is available.',
        default: 300,
      },
      minDistanceMeters: {
        type: 'number',
        title: 'Minimum distance (m)',
        description:
          'Between the min and max interval, record only after moving this far…',
        default: 50,
      },
      minHeadingChangeDeg: {
        type: 'number',
        title: 'Minimum heading change (°)',
        description: '…or after the course changed by this many degrees.',
        default: 20,
      },
      uploadIntervalSeconds: {
        type: 'number',
        title: 'Upload interval (s)',
        description: 'How often queued points are sent to BordOps.',
        default: 60,
      },
      maxQueue: {
        type: 'number',
        title: 'Maximum offline queue length',
        description:
          'Oldest points are dropped beyond this limit (~3 weeks at max interval).',
        default: 20000,
      },
      alarms: {
        type: 'object',
        title: 'Alarms',
        description:
          'Forward Signal K notifications to the BordOps alarm centre (web push). The token needs boat:<code>:alarms:write.',
        properties: {
          enabled: { type: 'boolean', title: 'Forward alarms', default: true },
          paths: {
            type: 'string',
            title: 'Notification paths (prefixes, comma-separated)',
            description: 'notifications.bordops.test is always forwarded.',
            default: alarms.DEFAULT_PATHS,
          },
          minState: {
            type: 'string',
            title: 'Minimum state',
            description: 'Lower states are only sent to close an alarm reported before.',
            enum: ['alert', 'warn', 'alarm', 'emergency'],
            default: 'alert',
          },
          updateSeconds: {
            type: 'number',
            title: 'Text update interval (s)',
            description: 'In alarm/emergency, send a changed text at most this often (0 = off).',
            default: 120,
          },
          heartbeatSeconds: {
            type: 'number',
            title: 'Heartbeat interval (s)',
            description: 'BordOps raises "no data from the boat" when heartbeats stop while the anchor watch is on.',
            default: 300,
          },
        },
      },
    },
  };

  // ---------------------------------------------------------------- helpers

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function headingDelta(a, b) {
    if (a == null || b == null) return null;
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function loadQueue() {
    try {
      if (queueFile && fs.existsSync(queueFile)) {
        queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        app.debug(`Loaded ${queue.length} buffered points from disk`);
      }
    } catch (e) {
      app.debug(`Could not load queue file: ${e.message}`);
      queue = [];
    }
  }

  function saveQueue(force) {
    dirtySinceSave++;
    if (!force && dirtySinceSave < 10) return; // throttle SD-card writes
    dirtySinceSave = 0;
    try {
      if (queueFile) fs.writeFileSync(queueFile, JSON.stringify(queue));
    } catch (e) {
      app.debug(`Could not persist queue: ${e.message}`);
    }
  }

  function currentValue(pathName) {
    const v = app.getSelfPath(pathName);
    return v && typeof v.value === 'number' ? v.value : null;
  }

  function status() {
    const parts = [`queued ${queue.length}`, `uploaded ${stats.uploaded}`];
    if (stats.lastUpload) parts.push(`last ${stats.lastUpload.slice(11, 19)}Z`);
    if (stats.rejected) {
      parts.push(`rejected ${stats.rejected}` + (stats.lastReject ? ` (${stats.lastReject})` : ''));
    }
    if (stats.lastError) parts.push(`error: ${stats.lastError}`);
    const msg = `${parts.join(', ')} · ${alarmStatus()}`;
    // setPluginError paints the dashboard entry red; keep it for real errors only
    const failed = stats.lastError || (al && (al.stats.error || al.stats.hbError));
    failed ? app.setPluginError(msg) : app.setPluginStatus(msg);
  }

  function alarmStatus() {
    if (!al) return 'alarms off';
    const s = al.stats;
    const parts = [`alarms: ${s.sent} sent`];
    if (s.lastSent) parts.push(`last ${s.lastSent.slice(11, 19)}Z`);
    parts.push(`queue ${al.queue.length}`);
    if (s.rejected) parts.push(`rejected ${s.rejected}` + (s.lastReject ? ` (${s.lastReject})` : ''));
    if (s.error) parts.push(`error: ${s.error}`);
    if (s.hbError && s.hbError !== s.error) parts.push(`heartbeat: ${s.hbError}`);
    return parts.join(', ');
  }

  function readJson(file, fallback) {
    try {
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
    } catch (e) {
      app.debug(`Could not read ${path.basename(file)}: ${e.message}`);
      return fallback;
    }
  }

  function writeJson(file, data) {
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file); // never leave a torn file after a power cut
    } catch (e) {
      app.debug(`Could not write ${path.basename(file)}: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------- sampling

  function onPosition(options, value, timestampMs) {
    if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') {
      return;
    }

    const now = timestampMs || Date.now();
    const sogMs = currentValue('navigation.speedOverGround'); // m/s
    const cogRad = currentValue('navigation.courseOverGroundTrue'); // radians
    const headingDeg = cogRad != null ? ((cogRad * RAD_TO_DEG) % 360 + 360) % 360 : null;

    if (lastSent !== null) {
      const dtSec = (now - lastSent.time) / 1000;
      if (dtSec < options.minIntervalSeconds) return;
      if (dtSec < options.maxIntervalSeconds) {
        const dist = haversineMeters(
          lastSent.lat, lastSent.lon, value.latitude, value.longitude
        );
        const dHead = headingDelta(lastSent.heading, headingDeg);
        const moved = dist >= options.minDistanceMeters;
        const turned = dHead !== null && dHead >= options.minHeadingChangeDeg;
        if (!moved && !turned) return;
      }
    }

    const recordedAt = new Date(now).toISOString();
    queue.push({
      idempotency_key: `sk-${recordedAt}`,
      recorded_at: recordedAt,
      latitude: Number(value.latitude.toFixed(6)),
      longitude: Number(value.longitude.toFixed(6)),
      speed_knots: sogMs != null ? Number((sogMs * MS_TO_KNOTS).toFixed(1)) : null,
      heading_deg: headingDeg != null ? Number(headingDeg.toFixed(0)) : null,
      source: 'gps_device',
    });
    lastSent = { time: now, lat: value.latitude, lon: value.longitude, heading: headingDeg };
    stats.queued++;

    if (queue.length > options.maxQueue) {
      queue.splice(0, queue.length - options.maxQueue);
    }
    saveQueue(false);
    status();
  }

  // ---------------------------------------------------------------- upload

  async function uploadBatch(options) {
    if (queue.length === 0) return;

    const batch = queue.slice(0, BATCH_LIMIT);
    const url =
      options.serverUrl.replace(/\/+$/, '') +
      `/api/v1/boats/${encodeURIComponent(options.boatCode)}/positions/batch`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({ positions: batch }),
      });

      if (res.status === 401 || res.status === 403) {
        stats.lastError = `auth failed (HTTP ${res.status}) — check token`;
        app.setPluginError(stats.lastError);
        return; // keep the queue; the token may get fixed
      }

      if (res.status === 404) {
        stats.lastError = `boat '${options.boatCode}' not found (HTTP 404) — check boat code`;
        app.setPluginError(stats.lastError);
        return; // keep the queue; the code may get fixed
      }

      if (!res.ok && res.status !== 422) {
        stats.lastError = `HTTP ${res.status}`;
        status();
        return; // server hiccup — retry next cycle
      }

      const body = await res.json().catch(() => ({}));

      if (!Array.isArray(body.accepted) && !Array.isArray(body.rejected)) {
        // Whole-batch validation error (422 without per-point verdicts).
        // Keep the queue but drop the oldest point so a single malformed
        // entry can never jam the pipeline forever.
        queue.shift();
        stats.rejected++;
        stats.lastError = `batch rejected (HTTP ${res.status})`;
        saveQueue(true);
        status();
        return;
      }

      const accepted = new Set(body.accepted || []);
      const rejectedList = body.rejected || [];
      const rejected = new Set(rejectedList.map((r) => r.idempotency_key));
      if (rejectedList.length) {
        stats.lastReject = String(rejectedList[0].reason || 'no reason').slice(0, 60);
        app.debug('rejected %d: %j', rejectedList.length, rejectedList.slice(0, 3));
      }

      // Drop everything the server decided on (accepted or rejected) —
      // a rejected point (implausible/out of range) will not get better
      // by retrying. Points outside this batch stay queued.
      const inBatch = new Set(batch.map((p) => p.idempotency_key));
      queue = queue.filter((p) => !inBatch.has(p.idempotency_key));

      stats.uploaded += accepted.size;
      stats.rejected += rejected.size;
      if (accepted.size) stats.lastUpload = new Date().toISOString();
      stats.lastError = null;
      saveQueue(true);
      status();

      // More waiting? Drain immediately instead of next tick.
      if (queue.length >= BATCH_LIMIT) {
        setImmediate(() => uploadBatch(options));
      }
    } catch (e) {
      stats.lastError = `offline (${e.message})`;
      status(); // no network — points stay queued
    }
  }

  // ---------------------------------------------------------------- alarms

  const getSelf = (p) => app.getSelfPath(p);

  function startAlarms(options) {
    const o = Object.assign(
      { enabled: true, paths: alarms.DEFAULT_PATHS, minState: 'alert', updateSeconds: 120, heartbeatSeconds: 300 },
      options.alarms || {}
    );
    if (!o.enabled) return;
    const minState = alarms.normState(o.minState);
    o.minState = minState && minState !== 'normal' ? minState : 'alert';
    o.updateSeconds = Math.max(0, Number(o.updateSeconds) || 0);
    o.heartbeatSeconds = Math.max(60, Number(o.heartbeatSeconds) || 300);

    const dir = app.getDataDirPath();
    al = {
      opts: o,
      base:
        options.serverUrl.replace(/\/+$/, '') +
        `/api/v1/boats/${encodeURIComponent(options.boatCode)}/alarms/`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${options.token}`,
      },
      boatCode: options.boatCode,
      prefixes: alarms.parsePaths(o.paths),
      queueFile: path.join(dir, 'bordops-alarm-queue.json'),
      stateFile: path.join(dir, 'bordops-alarm-state.json'),
      sources: {}, // path -> { sourceRef -> { state, message, ts } }
      deferred: {}, // path -> throttled text-update timer
      retryTimer: null,
      attempt: 0,
      busy: false,
      stats: { sent: 0, rejected: 0, lastSent: null, lastReject: null, error: null, hbError: null },
    };
    const q = readJson(al.queueFile, []);
    const sent = readJson(al.stateFile, {});
    al.queue = alarms.prune(Array.isArray(q) ? q : [], Date.now());
    al.sent = sent && typeof sent === 'object' ? sent : {}; // path -> last queued { state, message, ts, sentAt }

    // Values Signal K already holds: wetterwacht publishes a level only on change,
    // so an alarm raised before this start would otherwise never reach BordOps.
    for (const n of alarms.collect(app.getSelfPath('notifications'))) onNotification(n.path, n.source, n);
    unsubscribes.push(
      app.streambundle.getSelfBus().onValue((v) => {
        if (!v || v.isMeta || typeof v.path !== 'string' || !v.path.startsWith('notifications.')) return;
        const n = alarms.toNotification(v.value, v.timestamp);
        if (n) onNotification(v.path, v.$source, n);
      })
    );

    al.heartbeatTimer = setInterval(sendHeartbeat, o.heartbeatSeconds * 1000);
    sendHeartbeat();
    flushAlarms(true);
  }

  function stopAlarms() {
    if (!al) return;
    clearInterval(al.heartbeatTimer);
    clearTimeout(al.retryTimer);
    Object.values(al.deferred).forEach(clearTimeout);
    writeJson(al.queueFile, al.queue);
    al = null;
  }

  function onNotification(p, source, n) {
    if (!alarms.matches(p, al.prefixes)) return;
    (al.sources[p] = al.sources[p] || {})[source || 'unknown'] = n;
    evaluateAlarm(p);
  }

  function evaluateAlarm(p) {
    const cur = alarms.effective(al.sources[p]);
    clearTimeout(al.deferred[p]);
    delete al.deferred[p];
    const d = cur && alarms.decide(al.sent[p], cur, al.opts, Date.now());
    if (!d) return;
    if (d.waitMs) al.deferred[p] = setTimeout(() => al && evaluateAlarm(p), d.waitMs);
    else queueAlarm(p, cur, d.kind);
  }

  function queueAlarm(p, n, kind) {
    const now = Date.now();
    al.queue = alarms.prune(al.queue.concat(alarms.buildEvent(p, n, kind, getSelf, now)), now);
    al.sent[p] = { state: n.state, message: n.message, ts: n.ts, sentAt: now };
    writeJson(al.queueFile, al.queue);
    writeJson(al.stateFile, al.sent);
    app.debug('alarm %s %s → %s', kind, p, n.state);
    flushAlarms(true);
  }

  // Sends right away; on failure retries after 5 s, 15 s, 30 s, then every minute.
  // A new event cuts a pending wait short.
  async function flushAlarms(immediate) {
    const run = al;
    if (!run) return;
    if (immediate && run.retryTimer) {
      clearTimeout(run.retryTimer);
      run.retryTimer = null;
    }
    if (run.busy || run.retryTimer || run.queue.length === 0) return;

    run.busy = true;
    const batch = run.queue.slice(0, alarms.BATCH_MAX);
    let r;
    try {
      const res = await fetch(run.base + 'batch', {
        method: 'POST',
        headers: run.headers,
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      r = alarms.batchResult(batch, res.status, await res.json().catch(() => null), run.boatCode);
    } catch (e) {
      r = { retry: true, error: `offline (${e.message})` };
    }
    run.busy = false;
    if (al !== run) return; // stopped meanwhile; the server dedupes a resend by event_id

    const s = run.stats;
    s.error = r.error;
    if (r.retry) {
      run.retryTimer = setTimeout(() => {
        run.retryTimer = null;
        flushAlarms();
      }, alarms.backoffMs(run.attempt++));
    } else {
      const done = new Set(r.remove);
      run.queue = run.queue.filter((e) => !done.has(e.event_id));
      run.attempt = 0;
      s.sent += r.accepted;
      if (r.accepted) s.lastSent = new Date().toISOString();
      if (r.rejected.length) {
        s.rejected += r.rejected.length;
        s.lastReject = String(r.rejected[0].reason || 'no reason').slice(0, 60);
        app.debug('alarm events rejected: %j', r.rejected.slice(0, 3));
      }
      writeJson(run.queueFile, run.queue);
      if (run.queue.length) setImmediate(flushAlarms);
    }
    status();
  }

  // Live only, never buffered: BordOps counts heartbeats by their arrival time.
  async function sendHeartbeat() {
    const run = al;
    if (!run) return;
    const body = {
      at: new Date().toISOString(),
      watches: alarms.watches(getSelf, Date.now()),
      plugin_version: VERSION,
    };
    try {
      const res = await fetch(run.base + 'heartbeat', {
        method: 'POST',
        headers: run.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      run.stats.hbError = res.ok
        ? null
        : alarms.httpError(res.status, await res.json().catch(() => null), run.boatCode);
    } catch (e) {
      run.stats.hbError = `offline (${e.message})`;
    }
    if (al === run) status();
  }

  plugin.registerWithRouter = function (router) {
    // Test without a real alarm: sets notifications.bordops.test, which then
    // travels the same way as any other notification.
    router.post('/test-alarm', (req, res) => {
      const body = req.body || {};
      const state = alarms.normState(body.state || 'alarm');
      if (!state) return res.status(400).json({ error: 'state: normal, alert, warn, alarm or emergency' });
      if (!al) return res.status(503).json({ error: 'alarm forwarding is not running (plugin or alarms disabled)' });
      const message =
        typeof body.message === 'string' && body.message
          ? body.message.slice(0, 200)
          : state === 'normal'
            ? 'Testalarm beendet'
            : `Testalarm (${state}) von signalk-bordops`;
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: [
              {
                path: alarms.TEST_PATH,
                value: { state, method: state === 'normal' ? [] : ['visual'], message },
              },
            ],
          },
        ],
      });
      res.json({ path: alarms.TEST_PATH, state, message });
    });
  };

  // ---------------------------------------------------------------- lifecycle

  plugin.start = function (options) {
    options = Object.assign(
      {
        serverUrl: 'https://bordops.eu',
        minIntervalSeconds: 10,
        maxIntervalSeconds: 300,
        minDistanceMeters: 50,
        minHeadingChangeDeg: 20,
        uploadIntervalSeconds: 60,
        maxQueue: 20000,
      },
      options || {}
    );

    // tolerate copy-paste whitespace around code / token / URL
    options.boatCode = String(options.boatCode || '').trim();
    options.token = String(options.token || '').trim();
    options.serverUrl = String(options.serverUrl || '').trim();

    if (!options.boatCode || !options.token) {
      app.setPluginError('Boat code and API token are required — see plugin settings.');
      return;
    }

    queueFile = path.join(app.getDataDirPath(), 'bordops-queue.json');
    loadQueue();

    const stream = app.streambundle.getSelfBus('navigation.position');
    unsubscribes.push(
      stream.onValue((normalized) => {
        const ts = normalized && normalized.timestamp
          ? new Date(normalized.timestamp).getTime()
          : Date.now();
        onPosition(options, normalized && normalized.value, ts);
      })
    );

    uploadTimer = setInterval(
      () => uploadBatch(options),
      Math.max(10, options.uploadIntervalSeconds) * 1000
    );

    startAlarms(options);
    status();
    app.debug('signalk-bordops started');
  };

  plugin.stop = function () {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    if (uploadTimer) {
      clearInterval(uploadTimer);
      uploadTimer = null;
    }
    stopAlarms();
    saveQueue(true);
    lastSent = null;
    app.debug('signalk-bordops stopped');
  };

  return plugin;
};
