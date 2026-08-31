# signalk-bordops

Send your vessel's position from [Signal K](https://signalk.org) to
[BordOps](https://bordops.eu) — the boat operations platform for owners,
skippers and crews (maintenance plans, logbook, journey diary, live map).

Your boat tracks itself: as soon as the Signal K server has a GPS fix,
positions flow to your BordOps map, journey diary and logbook — no phone
on board required.

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

1. In BordOps, open the **Tracker** page of your boat and create an API
   token (the same one-click token used for OwnTracks — its ability is
   `boat:<code>:positions:write`). Copy the token and note your boat code.
2. In the Signal K admin UI open **Server → Plugin Config →
   BordOps Position Reporter**:
   - **BordOps server URL**: `https://bordops.eu` (default)
   - **Boat code**: your boat's short code
   - **API token**: the token from step 1
3. Enable the plugin. The plugin status line shows queued/uploaded
   counters and the last error, if any.

The sampling defaults (10 s minimum, 5 min maximum, 50 m distance,
20° course change, upload every 60 s) match the BordOps iOS tracker and
are fine for most sailing yachts.

## Privacy

The plugin sends only: timestamp, latitude/longitude, speed over ground,
course over ground — to the BordOps server you configure, authenticated
with your own token. Nothing else leaves the boat, and the token can be
revoked in BordOps at any time.

## Deutsch: Kurzanleitung

Plugin im Signal-K-Appstore installieren (oder `npm install
signalk-bordops` in `~/.signalk`). In BordOps auf der **Tracker**-Seite
des Schiffs ein API-Token erzeugen, dann im Signal-K-Admin unter
Plugin-Konfiguration Bootskennung und Token eintragen und das Plugin
aktivieren. Punkte werden bei Funkloch an Bord gepuffert und
nachgeliefert; parallel laufende Tracker (iOS-App) erzeugen dank
Server-Dedupe keine Duplikate.

## License

MIT — © S4U GmbH, [bordops.eu](https://bordops.eu)
