# LED Monitor

Monitoring and control dashboard for the LED processors on one show network: Brompton Tessera SX40, NovaStar COEX
MX40 Pro and CX40 Pro, and NovaStar VX2000 Pro. A small server polls every processor, works out what is wrong, and
pushes it live to a web dashboard anyone on the network can open without logging in. A Mac menu bar app runs the
server, so nothing else needs installing.

Design: [LED Processor Monitor: Design](https://claude.ai/artifact/Tk6LkG374Yuy8QKAyFK9Bs).

## What works today (phases 1 to 5)

- Brompton Tessera processors over their HTTP IP control API (checked against Tessera 3.5.2): temperatures, fans,
  inputs and signal, genlock source, brightness, preset, blackout and freeze, failover role and partner, cable loops,
  tile counts and firmware.
- Health rules and alerts: unreachable, no signal on the active input, temperatures, fans, tiles offline or erroring,
  tile firmware mismatch, cable loop broken, partner missing, failover active.
- Overview page with live updates and an event log (kept in `events.jsonl` in the settings folder).
- Topology page laid out like the wall diagram: primary processor on top, backup at the bottom, distribution boxes
  as columns, tile chains between each pair of boxes. It shows which processor is driving, trunk state from each
  processor, and each chain's cable loop (a broken loop turns its redundant end red). Click anything for details.
  Brompton walls come from a layout in `config.json` (below), since Tessera does not report where tiles are.
- Events page: the whole log, filtered by processor, level, source, time and text, with a CSV download.
- NovaStar COEX processors (MX40 Pro, CX40 Pro) over the COEX Open API on port 8001: temperatures, fans, inputs,
  brightness, blackout and freeze, preset, backup, and every cabinet with its health. Their walls are drawn from the
  processor's own cabinet map, one chain per output port in connection order, with each port's load: the pixels of
  its cabinets against the port's capacity: 650,000 pixels per Gbit/s at 60 Hz, times the port speed the processor
  reports (a CX40 Pro's 5G ports: 3,250,000), scaled by its output frame rate. Set `"portCapacity"` on the processor
  to override it, for example at 10 or 12 bit. Alerts for ports at 90% and over 100%, output faults, cabinets that stop answering
  or report faults, and broken links between cabinets.
- Processor syslog: point Tessera's syslog at this machine (UDP 5514) and every line lands in the event log under
  the processor that sent it. This is how Tessera reports things its API does not, such as genlock loss.
- Settings page (`/settings`), behind one password: processors (with a network scan that only asks read-only
  identity questions), Brompton wall layouts, alert limits, email, and general options. Changes apply without a
  restart. Viewing and controls stay open to everyone on the network.
- A page per processor (click its name): controls, every input, output and redundancy detail, its events, and charts
  of each temperature, fan, port load, brightness and tile count over the last hour, 24 hours or 7 days.
- Controls: brightness, preset, input, blackout, freeze, request failover and reboot. Blackout, failover, input changes
  and reboot ask a second time, naming the processor. Every control action goes in the event log with the address it
  came from. COEX processors offer brightness, preset, input, blackout and freeze.
- Email alerts over SMTP: new problems are batched for a few seconds into one email, a recovery email follows, and the
  same problem is not repeated within the repeat time. A test button checks the settings.
- NovaStar VX Pro processors (VX2000 Pro and the rest of the series). The dashboard first asks the COEX Open API on
  port 8001 and, if the processor answers, treats it exactly like a COEX processor. Otherwise it uses NovaStar's VX Pro
  control protocol (TCP 15200), which only covers reading the device ID, setting brightness and loading presets 1 to
  10: the card then shows whether the processor is there, and the controls offer brightness and preset only.
- The Mac menu bar app, and the same app for Windows (it sits in the notification area).
- A simulator for two SX40s (a primary and its backup) with faults you can switch on.

Controls have only been tried against the simulators. To keep the dashboard read-only, turn off "Processor controls"
in Settings → General (or set `"controls": false` in `config.json`).

VX Pro caveats: the frames follow the examples in NovaStar's VX Pro Series Control Protocol V1.0.0 byte for byte, but
nothing has been sent to a real VX Pro, and whether VX firmware answers the COEX API on port 8001 is not known yet.

The settings password is set the first time Settings is opened, and only from the machine running the monitor. It is
stored as a scrypt hash in `auth.json` in the settings folder; delete that file to set a new one if it is forgotten.
An unlocked browser stays unlocked for 30 minutes after its last use. History is kept in `history.json` (raw readings
for an hour, one-minute averages for a day, ten-minute averages for a week).

COEX caveats: NovaStar documents the field names but not their units or what each status number means. The driver
assumes °C, volts, brightness from 0 to 1 and status 0 as normal; check these against a real processor. COEX refuses
API requests while NovaStar's VMP software has the processor open, and the dashboard says so.

## Run it

On a Mac, build and install the app in one step:

```sh
scripts/deploy.sh
```

It appears in the menu bar. **Open Dashboard** opens it here; **Copy Link for Others** copies the address other people
on the network can open. **Demo Mode** adds two simulated SX40s, a simulated COEX MX40 Pro and a simulated VX2000 Pro.

On Windows, download the installer from the "Windows app" workflow run (Actions tab) or
run `scripts/build.sh windows` from Git Bash; the app then sits in the notification area, and Windows asks once
whether to let it accept connections from the network (allow it on private networks so others can open the
dashboard). Neither the Mac app nor the Windows installer is signed, so macOS asks to confirm the first open
(right-click → Open) and Windows SmartScreen shows "More info → Run anyway".

Without the app (any machine with Node 22):

```sh
scripts/build.sh run            # demo mode on http://localhost:6060
scripts/deploy.sh headless      # build and keep it running under pm2 as "led-monitor"
```

## Add processors

Enable IP control on each processor first (Tessera: the IP Control application). Then add them on the Settings page
(**Open Settings** in the app menu), or scan the network for them there. The settings live in `config.json` in the
settings folder (**Open Settings Folder**, or `data/` when running headless); after editing that file by hand, choose
**Restart Server**:

```json
{
  "port": 6060,
  "processors": [
    { "name": "Stage Main", "kind": "brompton", "host": "10.10.20.11" },
    { "name": "Stage Backup", "kind": "brompton", "host": "10.10.20.12" }
  ]
}
```

`kind` is `brompton`, `coex` or `vxpro`. `name` is optional (the processor's own name is used). Alert limits can be
changed under `"thresholds"`: `tempWarnC`, `tempCritC`, `fanMinRpm`, `tilesOfflineCritPercent`, `unreachableAfterPolls`.
`"syslogPort"` (default 5514, 0 for off) is where processors send syslog. `portLoadWarnPercent` (default 90) sets the
COEX port load warning. Email settings are easiest to fill in on the Settings page.

### Describe a Brompton wall

Tessera does not report where its tiles are, so each Brompton wall is described once, on the Settings page under
Walls or in `config.json`. Give each processor an `id`,
then add a wall naming the primary and backup, and for each pair of XD boxes the number of tiles on each port's chain
(port 1 first, 0 for an empty port). A chain runs from port N on the left box to port N on the right box, as a
cable loop:

```json
"processors": [
  { "id": "main", "name": "Stage Main", "kind": "brompton", "host": "10.10.20.11" },
  { "id": "backup", "name": "Stage Backup", "kind": "brompton", "host": "10.10.20.12" }
],
"walls": [
  {
    "name": "Main stage wall",
    "primary": "main",
    "backup": "backup",
    "groups": [
      { "left": { "name": "XD A", "trunk": "A" }, "right": { "name": "XD B", "trunk": "B" }, "chains": [8, 8, 8, 8, 8, 8, 8, 8, 8, 8] },
      { "left": { "name": "XD C", "trunk": "C" }, "right": { "name": "XD D", "trunk": "D" }, "chains": [8, 8, 8, 8, 8, 8, 8, 8, 0, 0] }
    ]
  }
]
```

`trunk` is the processor output feeding the box. Ports are named from it (A1, B1...) and matched to Tessera's cable
loop reports, which read like `loop-found: A1->B1`. Add a box's `serial` to check that the processor can see it.
Leave out `right` for chains that are not looped. The wall is checked against the processor's tile count, and a note
appears if they differ.

Not yet checked on real hardware: the exact port names Tessera uses in loop reports for XD-fed walls, and which
syslog lines it sends. Both are read loosely, and the simulator follows the format above.

## Try faults with the simulator

In demo mode the log prints each simulated processor's port. Then, for example:

```sh
curl 'http://127.0.0.1:<port>/sim/scenario?set=signal-loss'
```

Scenarios: `normal`, `signal-loss`, `fan-failure`, `hot`, `tiles-offline`, `loop-broken`, `partner-lost`, `failover`.
COEX simulator scenarios: `normal`, `signal-loss`, `cabinet-offline`, `cabinet-hot`, `link-broken`, `fan-failure`,
`port-overload`, `port-down`, `vmp-busy`.

Demo mode also draws a simulated wall: two pairs of XD boxes with ten chains of eight tiles each. `loop-broken` breaks
the loop on A4 to B4.

To try syslog: `logger -n 127.0.0.1 -P 5514 -d "Genlock lost"` (macOS and Linux).

## Develop

```sh
npm install
npm run dev                     # server with the simulator on :6060, from source
npm run dev -w @ledmon/web      # dashboard with hot reload on :5173, talking to :6060
npm test
```

| Folder | What |
| --- | --- |
| `packages/shared` | Types shared by the server and the dashboard |
| `packages/server` | Drivers, health rules, monitor, web server, simulator |
| `packages/web` | The dashboard (React, Vite) |
| `packages/launcher` | The Mac menu bar and Windows notification area app (Electron) |
| `scripts/` | `build.sh`, `deploy.sh`, `app-version.sh` |

## Versions and releases

Every merge to main is released automatically: `.github/workflows/auto-release.yml` tags it `vX.Y.Z` and publishes a
GitHub release. PR titles decide the bump: `feat:` minor, `fix:` (or anything else) patch, `!:` or `BREAKING CHANGE`
major, `[skip release]` none. The tag is the version; `scripts/app-version.sh` reads it for the dashboard footer and
the app. The Mac app and the Windows installer are built on every pull request (Actions, "Mac app" and "Windows app")
and can be downloaded from the run.

The app is not signed. When it comes from a download rather than `scripts/deploy.sh`, open it the first time with
right-click, **Open**.
