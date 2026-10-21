# signalk-bordops

Send your vessel's position and alarms from [Signal K](https://signalk.org)
to [BordOps](https://bordops.eu) — the boat operations platform for owners,
skippers and crews (maintenance plans, logbook, journey diary, live map,
alarm centre).

Your boat tracks itself: as soon as the Signal K server has a GPS fix,
positions flow to your BordOps map, journey diary and logbook — no phone
on board required. Anchor, weather and other on-board alarms reach the
BordOps alarm centre and arrive as web push on the phones of skipper and
owners, even when nobody is on board.

## Features

- **Adaptive sampling** — sparse at anchor, dense while manoeuvring:
  a point is recorded when the maximum interval elapses, or earlier once
  the vessel has moved a configurable distance or changed course.
- **Offline first** — no connectivity, no data loss: points are buffered
  on disk and uploaded in batches once the boat is back online (the
  BordOps API accepts points up to 30 days old).
- **Idempotent uploads** — every point carries an idempotency key and the
  server stores exactly one point per vessel and timestamp, so retries
  and overlapping trackers (e.g. the BordOps iOS app running in
  parallel) never produce duplicates.
- **Alarms** — state changes of selected Signal K notifications are sent
  immediately, with their own offline queue; a heartbeat every 5 minutes
  lets BordOps raise "no data from the boat" while the anchor watch is on.
- **Zero dependencies** — plain Node (>= 18), nothing to compile.

## Requirements

- Signal K Server with a position source (`navigation.position`), e.g.
  GPS via NMEA 0183/2000 or Seatalk
- A BordOps account (free trial at [bordops.eu](https://bordops.eu)) with
  a boat, and internet access on board (LTE router, Starlink, marina WiFi)

## Installation

Install `signalk-bordops` from the Signal K Appstore, or manually:

```bash
cd ~/.signalk
npm install signalk-bordops
sudo systemctl restart signalk
```

## Configuration

1. In BordOps, open the **Tracker** page of your boat and create a token
   with **Token for Signal K** (owners and skippers only; abilities
   `boat:<code>:positions:write`, `alarms:write`, `alarms:read`). Copy the
   token and note your boat code. An older OwnTracks token
   (`positions:write` only) still sends positions, but alarms get HTTP 403.
2. In the Signal K admin UI open **Server → Plugin Config →
   BordOps Position & Alarm Reporter**:
   - **BordOps server URL**: `https://bordops.eu` (default)
   - **Boat code**: your boat's short code
   - **API token**: the token from step 1
3. Enable the plugin. The plugin status line shows queued/uploaded
   counters and the last error, if any.

The sampling defaults (10 s minimum, 5 min maximum, 50 m distance,
20° course change, upload every 60 s) match the BordOps iOS tracker and
are fine for most sailing yachts.

## Alarms

The alarm module must be active for the boat in BordOps (otherwise the
server answers 403 and the plugin keeps its queue). Settings under
**Alarms** in the plugin config:

| Setting | Default | Meaning |
|---|---|---|
| Forward alarms | on | |
| Notification paths | `notifications.navigation.anchor, notifications.environment.wetterwacht, notifications.alarm` | prefixes on whole path segments; `notifications.bordops.test` is always included |
| Minimum state | `alert` | lower states are only sent to close an alarm reported before |
| Text update interval | 120 s | in `alarm`/`emergency`, a changed text (e.g. growing distance to the anchor) is sent at most this often; 0 = off |
| Heartbeat interval | 300 s | |

- Only **state changes** per path are sent. If several plugins write the
  same path, the highest state wins.
- Each event carries the boat position; anchor alarms add anchor
  position, radius and depth, weather alarms (`signalk-wetterwacht`) add
  level, headline, detail, expected wind/gusts in knots, thunder
  probability and sources. Missing values are left out.
- The last state sent per path survives restarts
  (`bordops-alarm-state.json`), so cached values after a restart are not
  sent twice. Events are queued in `bordops-alarm-queue.json` (max. 500,
  dropped after 7 days) and retried after 5 s, 15 s, 30 s, then every
  minute; `event_id` is deterministic, so the server drops duplicates.
- Heartbeats are not buffered: BordOps counts them when they arrive.

The status line shows both parts, e.g.
`queued 0, uploaded 12, last 08:14:05Z · alarms: 3 sent, last 02:14:05Z, queue 0`.

### Test alarm

```bash
curl -X POST http://signalk.local:3000/plugins/signalk-bordops/test-alarm \
  -H 'Content-Type: application/json' -d '{"state":"alarm"}'
```

sets `notifications.bordops.test` (states `alert`, `warn`, `alarm`,
`emergency`; `normal` closes it; optional `message`). It travels the same
way as a real alarm, so sending the same state again sends nothing.

## Privacy

The plugin sends only: timestamp, latitude/longitude, speed over ground,
course over ground, and for alarms the notification path, state and
text with the values listed above, plus the heartbeat (what is being
watched, plugin version) — to the BordOps server you configure,
authenticated with your own token. Nothing else leaves the boat, and the
token can be revoked in BordOps at any time.

## Deutsch: Kurzanleitung

Plugin im Signal-K-Appstore installieren (oder `npm install
signalk-bordops` in `~/.signalk`). In BordOps auf der **Tracker**-Seite
des Schiffs **Token für Signal K** erzeugen (nur Verwalter/Skipper),
dann im Signal-K-Admin unter Plugin-Konfiguration Bootskennung und Token
eintragen und das Plugin aktivieren. Punkte werden bei Funkloch an Bord
gepuffert und nachgeliefert; parallel laufende Tracker (iOS-App) erzeugen
dank Server-Dedupe keine Duplikate.

Alarme: Zustandswechsel von Ankerwache, Wetterwacht und
`notifications.alarm.*` gehen sofort an die BordOps-Alarmzentrale (Web
Push), mit eigener Offline-Schlange; alle 5 min ein Lebenszeichen für den
Verbindungswächter. Das Modul „Bordalarme" muss für das Schiff aktiv sein.
Test ohne echten Alarm: `POST /plugins/signalk-bordops/test-alarm` mit
`{"state":"alarm"}`, Schließen mit `{"state":"normal"}`.

## License

MIT — © S4U GmbH, [bordops.eu](https://bordops.eu)
