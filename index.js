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
 */

const fs = require('fs');
const path = require('path');

const MS_TO_KNOTS = 1.9438444924;
const RAD_TO_DEG = 180 / Math.PI;
const BATCH_LIMIT = 500; // server-side maximum per request

module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let uploadTimer = null;
  let queue = [];
  let queueFile = null;
  let dirtySinceSave = 0;
  let lastSent = null; // { time: ms, lat, lon, heading }
  let stats = { queued: 0, uploaded: 0, rejected: 0, lastError: null };

  plugin.id = 'signalk-bordops';
  plugin.name = 'BordOps Position Reporter';
  plugin.description =
    'Sends the vessel position to BordOps (bordops.eu) with adaptive sampling and offline buffering.';

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
    const err = stats.lastError ? ` — last error: ${stats.lastError}` : '';
    app.setPluginStatus(
      `queued ${queue.length}, uploaded ${stats.uploaded}, rejected ${stats.rejected}${err}`
    );
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
      const rejected = new Set(
        (body.rejected || []).map((r) => r.idempotency_key)
      );

      // Drop everything the server decided on (accepted or rejected) —
      // a rejected point (implausible/out of range) will not get better
      // by retrying. Points outside this batch stay queued.
      const inBatch = new Set(batch.map((p) => p.idempotency_key));
      queue = queue.filter((p) => !inBatch.has(p.idempotency_key));

      stats.uploaded += accepted.size;
      stats.rejected += rejected.size;
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
    saveQueue(true);
    lastSent = null;
    app.debug('signalk-bordops stopped');
  };

  return plugin;
};
