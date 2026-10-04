# Signal K an Bord — Lana

Stand: 21.09.2026. Hostname `signalk` (bis 20.09. `signalk-lana`), Raspberry Pi 4B (4 GB), Debian 13 arm64.

---

## 1. Kurzreferenz

| Was | Wert |
|---|---|
| Signal K Admin-UI | http://signalk.local:3000 (an Bord aktuell http://192.168.1.188:3000) |
| SSH | `ssh signalk` → `signalk.local` via mDNS; Hostname fest via `preserve_hostname: true` in `/etc/cloud/cloud.cfg.d/99-preserve-hostname.cfg` (User `admin`, Key `~/.ssh/raspi` auf dem Mac); Mac muss im selben WLAN sein |
| WLAN-Profile Pi | **`Lana-Stl` (5 GHz, Prio 30 — Pflicht wegen Bluetooth, s. Abschnitt 10)** · `LANA` (2,4 GHz, Prio 20) · `PRIVATE_AIRPORT` (zu Hause, Prio 10) — alle DHCP, an Bord 192.168.1.188 |
| Bord-WLAN | Starlink Mini: SSID `LANA` = 2,4 GHz (Kanal 11), `Lana-Stl` = 5 GHz (Kanal 128, DFS). Pi hängt auf `LANA`, Handys/Mac dürfen auf beiden — ein Netz, 192.168.1.0/24, Router 192.168.1.1 |
| sudo | `admin` ohne Passwort (`/etc/sudoers.d/010_admin-nopasswd`) |
| Schiff in Signal K | Name `Lana`, UUID `urn:mrn:signalk:uuid:7c59ab71-3cf0-4c64-982e-372c7ec51d8f`, kein MMSI |
| Security | **aus** (kein Login) — nur im Bootsnetz betreiben |
| NMEA-Eingang | **N2K nativ**: Verbindung `ydnr-n2k` = Yacht Devices RAW, TCP 192.168.1.20:1458, bidirektional (`createDevice: false`). Die alte 0183-UDP-Verbindung `ydwg-02` ist **deaktiviert** (Apps hören weiter auf YDNR-UDP 2000). Quelle: **YDNR-02** (NMEA 2000 Wi-Fi Router, FW 1.74, S/N 00651507) unter http://192.168.1.20 in LANA, Broadcast läuft (20.09.) |
| NMEA-Ausgang Signal K (TCP) | Port 10110 (Standard-TCP-Server, für Apps als Alternative zu UDP) |
| Config-Verzeichnis Pi | `/home/admin/.signalk/` |
| Service | `systemctl status signalk` — Autostart aktiv, Restart=always |
| Plugins | `signalk-bordops` 0.1.1 (aus `~/signalk-bordops`, npm-Publish ausstehend), `@signalk/charts-plugin`, `signalk-daly-bms-ble`, `signalk-victron-ble`, KIP, Instrumentpanel, Freeboard |
| Node / Signal K | Node 24.21 (NodeSource), signalk-server global via npm |
| Logs | `journalctl -u signalk -f` (journald volatile, 64 MB, weg nach Reboot) |

**Ein Port für alles: UDP 2000.** YDNR-02 sendet Broadcast auf 2000, Signal K, Navionics und iSailor hören alle auf 2000. Keine IP-Adressen nötig.

---

## 2. YDNR-02 (NMEA 2000 Wi-Fi Router) — Stand 20.09.2026, funktioniert

Web-UI: **http://192.168.1.20** (DHCP von Starlink, Client-Modus in `LANA`, Kanal 11). Login `admin` / `admin` (Passwort-Änderung steht noch aus, Menü *Administration*). Werkszustand wäre AP `YDNR`, http://192.168.4.1. Firmware 1.74 — **1.77 verfügbar** (Feb 2026, Web Gauges mit Motor-Alarmen): WUPDATE.BIN von yachtd.com/downloads über *Firmware Update* einspielen, Einstellungen bleiben.

Aktuelle, geprüfte Konfiguration (*NMEA Server*):

| Server | Netz | Daten | Port | Richtung | Zweck |
|---|---|---|---|---|---|
| #1 | **UDP** | NMEA 0183 | **2000** | Transmit Only | Hauptkanal: Signal K, Navionics, iSailor (Broadcast) |
| #2 | TCP | NMEA 0183 | 1456 | Transmit Only | Fallback für Apps, die TCP wollen (max. 3 Clients) |
| #3 | TCP | **RAW** | 1458 | Both | Signal K ↔ N2K-Bus (lesen + schreiben). Nicht auf 0183 zurückstellen! |

„Enable the outgoing connection" ist **aus** (zeigte auf 192.168.1.21, existiert nicht). *NMEA Routing*: NMEA 2000 → Server 1, 2, 3 angehakt. *NMEA Filters*: alle leer (Black = alles durch).

**Stolperfalle (kostete eine Stunde):** Änderungen an den Servern greifen erst nach Klick auf **Update** ganz unten auf der Seite — und ein Portwechsel bei UDP wurde erst nach einem erneuten Update wirksam. Kontrolle immer vom Pi aus:

```bash
ssh signalk 'sudo timeout 5 tcpdump -ni wlan0 -c 4 "udp and src host 192.168.1.20"'   # muss :2000 zeigen
ssh signalk 'curl -s localhost:3000/signalk/v1/api/vessels/self/navigation/position/value'
```

Falls die IP mal wechselt: `arp -an` auf dem Mac nach MAC-Präfix `48:3f:da` suchen, oder `curl -si http://<ip>/ | grep YDNR`.

Werksreset (Büroklammer in Reset-Loch): 2–3 s halten bis grüne LED → loslassen = Settings zurück (AP-Modus). Länger als 10 s zusätzlich → Hardware-Reset inkl. Werks-Firmware.

---

## 3. Checkliste: Navionics Boating (iOS/Android)

Navionics ist beim UDP-Empfang wählerisch. Die drei typischen Fehler: falscher Host bei UDP, fehlende Local-Network-Berechtigung auf iOS, AP-Isolation im Router.

- [ ] Handy/Tablet in `LANA` oder `Lana-Stl` (beides Starlink, ein Netz) — nicht LTE.
- [ ] **iOS:** Einstellungen → *Boating* → **Lokales Netzwerk = AN**. Ohne das sieht die App keinen Broadcast. Wenn der Schalter fehlt: App einmal löschen und neu installieren, dann erscheint der Berechtigungsdialog erneut.
- [ ] **iOS:** Einstellungen → Datenschutz → *Lokales Netzwerk* → *Boating* = AN (gleicher Schalter, zweiter Ort).
- [ ] In Navionics: **Menü → Paired Devices** (je nach Version *Connected Devices* / *Gekoppelte Geräte*).
- [ ] Alte/fehlgeschlagene Einträge **löschen**.
- [ ] **+ / Add device:**
  - Name: `YDNR`
  - Host: **`0.0.0.0`** ← bei UDP zwingend, NICHT die Gateway-IP
  - Port: **`2000`**
  - Protocol: **UDP**
- [ ] Speichern. Status muss auf **Connected** wechseln (dauert bis 30 s). Darunter erscheint, was empfangen wird (*Position*, *Depth*, *AIS*).
- [ ] **Map Options → AIS Settings → Display AIS Targets = AN** (nur wenn AIS an Bord).
- [ ] App komplett beenden und neu starten, falls Status auf *Not connected* hängt.
- [ ] Fallback, wenn UDP partout nicht will: TCP-Eintrag mit Host = Gateway-IP, Port 1456 (Server 2 aus Abschnitt 2). TCP erlaubt beim YDNR max. 3 Clients gleichzeitig.

Navionics nutzt: Position (RMC/GGA), Tiefe (DPT/DBT), AIS (VDM), Kurs/Geschwindigkeit (VTG/HDG). Wind wird nicht angezeigt — das ist normal.

---

## 4. Checkliste: iSailor (iOS/Android)

- [ ] Gerät im Bootsnetz.
- [ ] **iOS:** Einstellungen → *iSailor* → **Lokales Netzwerk = AN**.
- [ ] iSailor: **Settings → Sensors → Connection Settings → Add Connection**
  - Name: `YDNR`
  - Protocol: **UDP**
  - Address: `0.0.0.0` (bei manchen Versionen wird die Gateway-IP verlangt — dann diese eintragen, sie wird bei UDP ignoriert)
  - Port: **2000**
- [ ] Verbindung aktivieren, zurück in **Sensors**: Datenquellen (GPS, Heading, Depth, Wind, AIS) auf die neue Verbindung setzen — sonst nutzt iSailor weiter das interne GPS.
- [ ] Prüfen: In *Sensors* laufen die Werte live (grün).

---

## 5. Checkliste: Signal K an Bord prüfen

- [ ] Pi bootet, LED an; nach ~60 s: http://signalk.local:3000 erreichbar.
- [ ] Admin-UI → **Dashboard**: Verbindung `ydwg-02` zeigt Deltas/s > 0, sobald das YDNR sendet.
- [ ] Admin-UI → **Data Browser**: `navigation.position` vorhanden.
- [ ] **Server → Plugin Config → BordOps Position Reporter**: Boat-Code + API-Token eintragen (Token in BordOps → Tracker-Seite des Boots erzeugen), *Enabled*, *Submit*. Statuszeile zeigt queued/uploaded.
- [ ] Freeboard (Webapps → Freeboard-SK) zeigt Schiff auf der Karte.

Wartungsbefehle (vom Mac):

```bash
ssh signalk                                    # einloggen
systemctl status signalk                       # Status
journalctl -u signalk -f                       # Live-Log
sudo systemctl restart signalk                 # Neustart
timeout 5 nc -lu 2000 | head                   # kommt UDP an?
```

Plugin aus dem Repo aktualisieren (Mac):

```bash
rsync -a --exclude node_modules --exclude .git ~/Programming/signalk-bordops/ signalk:~/signalk-bordops/ \
  && ssh signalk 'pkill -f "bin/signalk-server -c"'
```

---

## 5a. WLAN am Pi ändern (NetworkManager, kein sudo nötig)

Debian 13 nutzt **NetworkManager** — keine `wpa_supplicant.conf` mehr. `admin` ist in `netdev`, daher gehen alle `nmcli`-Befehle ohne sudo. Profile liegen in `/etc/NetworkManager/system-connections/*.nmconnection` (root-only), aber nie dort direkt editieren.

**Neues WLAN hinzufügen, während der Pi noch im alten Netz hängt (per SSH):**

```bash
nmcli dev wifi list                                          # sichtbare Netze
nmcli dev wifi connect "BOOTS-SSID" password "geheim" name boot
nmcli con modify boot connection.autoconnect-priority 10     # Bootsnetz bevorzugen
nmcli con show                                               # alle Profile
nmcli dev status                                             # was ist verbunden
```

Alte Netze bleiben gespeichert; bei mehreren sichtbaren gewinnt die höhere Priorität.

**Netz vorab anlegen, das gerade nicht sichtbar ist:**

```bash
nmcli con add type wifi ifname wlan0 con-name boot ssid "BOOTS-SSID" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "geheim" \
  connection.autoconnect yes connection.autoconnect-priority 10
```

**Pi kommt gar nicht ins Netz (SD-Karte am Mac):** Dieses Image (rpi-imager, Trixie) nutzt **cloud-init**. `custom.toml` wird NICHT ausgewertet. Erprobter Weg (20.09.2026):

1. Auf `bootfs` in **`network-config`** die gewünschte SSID als **erste** unter `access-points` eintragen (cloud-init/netplan rendert nur die erste SSID!):
   ```yaml
   wifis:
     wlan0:
       dhcp4: true
       access-points:
         "LANA":
           password: "<klartext oder 64-hex-psk>"
       optional: true
   ```
2. **Zwingend** die instance-id an **zwei** Stellen hochzählen, sonst passiert nichts — die Kernel-Cmdline gewinnt gegen `meta-data`:
   - `cmdline.txt`: `ds=nocloud;i=rpi-imager-1789112197398-3` → `-4`
   - `meta-data`: `instance-id: rpi-imager-1789112197398-3` → `-4`
3. Auswerfen, booten, 3 Minuten warten. Nach jedem Boot schreibt `/var/lib/cloud/scripts/per-boot/99-pi-diag.sh` eine Diagnose nach `bootfs/pi-diag.txt` (WLAN-Scan, Profile, Logs) — am Mac lesbar, wenn der Pi nicht auftaucht.

Danach die weiteren Netze wie oben per `nmcli` nachlegen (die stehen dann als normale Profile in `/etc/NetworkManager/system-connections/` und überleben alles). Achtung: `nmcli`-Änderungen über SSH ohne TTY brauchen `sudo` (polkit).

**Feste IP statt DHCP** (nur wenn der Router keine feste Zuweisung kann):

```bash
nmcli con modify boot ipv4.method manual ipv4.addresses 192.168.2.240/24 \
  ipv4.gateway 192.168.2.1 ipv4.dns 192.168.2.1
nmcli con up boot
```

Profil löschen: `nmcli con delete boot`. Passwort ändern: `nmcli con modify boot wifi-sec.psk "neu"`.

---

## 6. Offene Punkte / Nachträge

- [x] sudo ohne Passwort (20.09. via cloud-init write_files erledigt)
- [x] WLAN LANA + PRIVATE_AIRPORT als NM-Profile (20.09.)
- [ ] **Feste IP** für Pi und YDNR im Starlink-Router: Starlink-App bietet keine DHCP-Reservierung → mDNS (`signalk.local`) nutzen; YDNR-IP nach Bedarf in der App unter Geräte ablesen.
- [x] YDNR-02 konfiguriert, UDP 2000 läuft, Signal K empfängt Position/Kurs/Speed/Log (20.09.)
- [ ] YDNR-Admin-Passwort ändern
- [ ] **BordOps-Token** in Plugin Config eintragen.
- [ ] **CAN-Hat** (wenn gekauft, Modell nennen): `dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25` in `/boot/firmware/config.txt` (PiCAN-M) + Signal K Verbindung *NMEA 2000 / canbus can0*. Braucht sudo.
- [ ] **NMEA 0183 USB-Seriell**: bei Bedarf udev-Regel für stabilen Gerätenamen (Vendor/Product-ID nötig).
- [ ] **Karten** für charts-plugin (MBTiles nach `~/.signalk/charts/` oder Online-Quelle in Plugin Config).
- [ ] Optional: Signal K → Apps per UDP (`udp-nmea-sender`) — erst sinnvoll, wenn Daten aus anderen Quellen als dem YDNR (z. B. CAN-Hat) an die Apps sollen.

---

## 7. Fehlersuche "keine Daten per UDP"

1. Kommt der Broadcast überhaupt im Netz an? → am Pi `timeout 5 nc -lu 2000 | head`. Nichts? → Router-Isolation, YDNR nicht im Client-Modus, Server 1 nicht auf UDP/2000/Transmit.
2. Pi empfängt, App nicht? → iOS Lokales Netzwerk, Host `0.0.0.0`, App neu starten, Gerät im richtigen WLAN (nicht LTE).
3. Nur eine App empfängt? → bei UDP unmöglich (alle hören gleichzeitig); dann ist die andere App auf TCP konfiguriert und die 3 TCP-Slots des YDNR sind belegt.
4. Werte veraltet/springend? → doppelte Quellen (internes GPS + YDNR) in der App; in iSailor *Sensors* explizit auf YDNR setzen.

---

## 8. Was bei der Installation gemacht wurde (17./18.09.2026)

Node 24 (NodeSource) + `npm install -g signalk-server`; Konfiguration in `~/.signalk` von Hand angelegt (kein `signalk-server-setup`, da nicht scriptbar); systemd-Unit `signalk.service` (User admin, Port 3000, ohne Socket-Aktivierung); Security-Block aus `settings.json` entfernt; journald volatile 64 MB; `can-utils`, `libnss-mdns`, `avahi-utils`, `libavahi-compat-libdnssd-dev` installiert; Plugins `signalk-bordops` (file:../signalk-bordops) und `@signalk/charts-plugin` installiert und aktiviert; Verbindung `ydwg-02` NMEA0183/UDP Port 2000 aktiv; Reboot-Test bestanden.

Stolperfalle: `signalk-server --version` startet einen kompletten Server und belegt Port 3000 — nicht auf dem laufenden System ausführen.

---

## 9. Ray55E bekommt keine Position — Lösung

**Diagnose:** Ray55E kann nur NMEA 0183 (Grau = IN+, Lila = IN−; Blau/Braun = OUT). Quelle war der alte Plotter über den 3er-0183-Verteiler. Der neue Plotter (**Raymarine Axiom 2 Pro 12**, Anschlüsse: Transducer, PWR/Video/Audio, HDMI Out, 2× Network, Accessory, GA150, NMEA 2000) hat **kein** NMEA 0183 — Raymarine verweist selbst auf einen Konverter. Der Verteiler ist passiv; ein größerer Verteiler ändert nichts, es fehlt der **Sender** am Verteiler-Eingang. Router sitzt in der Achterkabine, Funk am Skippertisch — kein 0183-Kabel dazwischen.

**Voraussetzung für beide Wege:** ein N2K-T-Stück/Backbone in Reichweite des Skippertischs (hinter der Verkleidung am Kartentisch nachsehen).

**Option A — YDNR-02 an den Skippertisch umziehen (0 €):** Router an ein T-Stück beim Kartentisch. Port 0183 #1 `TX+` → Verteiler-Eingang + (oder direkt Ray55E Grau), `TX−` → Verteiler-Eingang − (Ray55E Lila). Dann im YDNR:
- *NMEA Settings*: Port #1 = 4800 Baud (Default)
- *NMEA Routing*: Zeile „NMEA 2000" → Spalte „Port 0183 #1" anhaken → Update
- *NMEA Filters*: Port 0183 #1 / NMEA 0183 / Transmit → WHITE `RMC GGA GLL ZDA` → Update (4800 Baud schafft nur ~15 Sätze/s; ohne Filter gehen Positionssätze unter)

**Option B — Konverter am Skippertisch:** Actisense NGW-1 (Raymarine-Nr. A80721, ~200 €) oder Raymarine STng-0183-Konverter E70196 (~150 €) an ein T-Stück; 0183 OUT+/OUT− → Verteiler-Eingang. 4800 Baud, Sätze RMC/GGA/GLL. YDNR bleibt in der Achterkabine.

**Erfolgskontrolle:** GPS-Symbol im Ray55E-Display leuchtet **dauerhaft** (blinkend = keine Daten); im DSC-Menü steht die Position.

---

## 10. Bluetooth: Daly-BMS und Victron in Signal K

**Regel Nr. 1: Pi muss auf 5 GHz (`Lana-Stl`).** WLAN und Bluetooth teilen sich beim Pi 4 Chip und Antenne. Auf 2,4 GHz brauchte ein BLE-Connect 34 s (Plugin-Timeout), auf 5 GHz 1,3 s. Prüfen: `nmcli -t -f GENERAL.CONNECTION dev show wlan0` → muss `Lana-Stl` zeigen.

**Daly-BMS** (`signalk-daly-bms-ble`, exklusive GATT-Verbindung, Poll alle 5 s):

| Signal-K-Pfad | Gerät | MAC |
|---|---|---|
| `electrical.batteries.service24` | Daly 24 V (DL-17710603086E) | `17:71:06:03:08:6E` |
| `electrical.batteries.service12` | Daly 12 V (DL-188103020C0C) | `18:81:03:02:0C:0C` |

Solange Signal K verbunden ist, findet die **Daly-App das BMS nicht** (ein Master pro BMS). Für die App: Plugin in *Server → Plugin Config* kurz deaktivieren oder `bluetoothctl disconnect <MAC>`. Redundanz für die 24-V-Bank liefert der SmartShunt (Broadcast, parallel lesbar).

**Hängende Verbindung lösen** (Symptom: Plugin-Timeouts, Gerät fehlt im Scan): `bluetoothctl devices Connected` → `bluetoothctl disconnect <MAC>` → Plugin/Server neu starten.

**Victron** (`signalk-victron-ble`, liest Broadcasts, kein Connect — VictronConnect-App bleibt parallel nutzbar). Pro Gerät: Device-ID (nur Kleinbuchstaben/Ziffern!), MAC, **Advertisement Key** (32 Hex). Key holen: VictronConnect → Gerät → ⚙ → ⋮ → *Produktinfo* → *Sofortige Anzeige über Bluetooth* → *Verschlüsselungsdaten anzeigen*.

| ID | Gerät | MAC | Key |
|---|---|---|---|
| `shunt` | Lana SmartShunt | `EB:EB:64:10:C3:41` | eingetragen |
| `mppt1` | Lana SmartSolar | `DB:14:2F:80:5C:7A` | eingetragen |
| `orion` | Charger 24V>12V | `E9:6F:C7:40:BC:85` | eingetragen |
| `mppt2` | SmartSolar -10T2 | `E9:64:32:CF:EE:72` | fehlt |
| `mppt3` | SmartSolar -10T1 | `CE:74:10:5F:29:E9` | fehlt |
| `lynxbms` | Lynx Smart BMS | `E0:2D:57:C5:F4:5F` | fehlt |
| `lithium1-3` | SmartLithium -5G1/-5G2/-5G3 | `E5:51:BC:A3:7B:48` / `F8:E9:BA:EA:73:0C` / `D8:A5:49:B6:BE:A4` | fehlt |

Pfade: `electrical.batteries.shunt`, `electrical.solar.mppt1`, `electrical.chargers.orion`. Geräte ohne Key **nicht** mit Platzhalter eintragen (Log-Spam „Incorrect advertisement key").

**Scanner:** `python3 ~/scan.py` (Optionen `-n victron`, `-t 20`, `--json`, `-w`). Pi-Bluetooth-Adresse: `DC:A6:32:34:76:11`.

---

## 11. Instrumentpanel / KIP: Layouts sichern und retten

Layouts liegen **nur im Browser** (LocalStorage), nicht auf dem Server. Deshalb:

- Instrumentpanel → 🔧 → *Settings* → **Backup settings** → JSON in Downloads. Nach jeder größeren Änderung. Zurück mit *Restore*.
- KIP: ☰ → *Settings* → *Configuration* → **Download**.
- Letztes gerettetes Layout: `~/instrumentpanelLayouts.json` auf dem Pi, `docs/instrumentpanelLayouts-2026-09-21.json` im Repo (1 Seite, 171 Widgets).

**Apps „gehen plötzlich nicht mehr", Server läuft:** Fast immer Browser-Zustand. Test im privaten Fenster mit `http://192.168.1.188:3000/…`. Geht es dort: in der Firefox-Konsole (⌘⌥K) `localStorage.removeItem('instrumentpanelToken')` und neu laden. **Nicht** die Website-Daten löschen, sonst ist das Layout weg. Firefox *Nur-HTTPS-Modus* muss für `signalk.local` aus sein.

**Notfall — Layout aus Firefox' Datenbank ziehen** (wenn die App es nicht mehr zeigt): Datei `~/Library/Application Support/Firefox/Profiles/<profil>/storage/default/http+++signalk.local+3000/ls/data.sqlite`, Tabelle `data`, Key `instrumentpanelLayouts`, Wert ist Snappy-komprimiert (`compression_type=1`). Entpacken mit `python-snappy`, dann per Konsole `localStorage.setItem('instrumentpanelLayouts', <json>)`.

---

## 11a. Batterien auf der Axiom (Signal K → NMEA 2000)

Plugin `sk-to-nmea2000` (Plugin Config → „Signal K to NMEA 2000“) sendet über den YDNR (Server 3, RAW, Both) PGN 127508/127506 in den Bus:

| N2K-Instanz | Signal-K-Pfad | Gerät |
|---|---|---|
| Batterie 0 | `electrical.batteries.service24` | Daly 24 V |
| Batterie 1 | `electrical.batteries.service12` | Daly 12 V |

Axiom: Datenfeld → Kategorie *Batterie* → „Batterie 0/1“; Quelle unter *Einstellungen → Netzwerk → Datenquellen → Batterie* (YDNR-02). Prüfen vom Pi: `timeout 10 nc 192.168.1.20 1458 | grep -E "F214|F212"` → Zeilen mit `T 01F2144A` = wird gesendet.

**Stolperfalle:** In `settings.json` muss die N2K-Verbindung `"createDevice": false` (oder true) enthalten — fehlt der Schlüssel, sendet Signal K still nichts. Weitere Werte (Shunt, Solar) in derselben Plugin-Config als Instanz 2+ bzw. unter „Solar“ ergänzen.

## 11b. GNSS-Sensoren nach der N2K-Umstellung

Seit Signal K direkt am N2K-Bus hängt (`ydnr-n2k`), heißen die Quellen anders als bei der 0183-UDP-Verbindung (`ydwg-02.AI/YD`). Die alten Einträge stehen deshalb "offline" – kein Fehler.

| Sensor | Gerät | Quelle (kanonisch, adressunabhängig) | Bug | Mitte |
|---|---|---|---|---|
| gnss1 | Axiom 2 Pro (Raymarine E70310, Bus-Adresse 150) | `ydnr-n2k.c078915de764e2f8` | 12 m | 1 m |
| gnss2 | Digital Yacht N2NET AIS (Bus-Adresse 43) | `ydnr-n2k.c078c30036b7c818` | 12 m | 1 m |

Eingetragen in `~/.signalk/settings.json` → `gnssSensors` (Backup: `settings.json.bak-gnss`). Beide liefern `navigation.position`; ohne Quellen-Priorität nimmt Signal K die zuerst gesehene. Falls die Axiom bevorzugt werden soll: Server → Settings → Source Priorities → `navigation.position`: `ydnr-n2k.c078915de764e2f8` zuerst, `…c818` mit Timeout als Fallback.

## 12. Offene Punkte (Stand 21.09.2026)

- [ ] `npm publish --access public` für `signalk-bordops` 0.1.1 — npm-2FA per Authenticator-App einrichten, dann OTP (6 Ziffern) eingeben
- [ ] Victron-Keys für mppt2, mppt3, lynxbms, lithium1-3 nachtragen (Abschnitt 10)
- [ ] Ray55E-Position: YDNR an den Skippertisch oder Konverter (Abschnitt 9)
- [ ] Autopilot ST6002 über YDNR-SeaTalk-Port + `@signalk/signalk-autopilot` (Seatalk-1-Modus)
- [ ] YDNR-02 Firmware 1.77 einspielen, Admin-Passwort ändern
- [ ] Navionics/iSailor auf UDP 2000 umstellen (Abschnitte 3/4)
- [ ] Optional: Ankerwache (`signalk-anchoralarm-plugin`), `signalk-backup`, InfluxDB-Historie
