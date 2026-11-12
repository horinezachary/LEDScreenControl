# LED Monitor

Monitoring and control dashboard for the LED processors on one show network: Brompton Tessera SX40, NovaStar COEX
MX40 Pro and CX40 Pro, and NovaStar VX2000 Pro. A small server polls every processor, works out what is wrong, and
pushes it live to a web dashboard anyone on the network can open without logging in. A Mac menu bar app runs the
server, so nothing else needs installing.

Design: [LED Processor Monitor: Design](https://claude.ai/artifact/Tk6LkG374Yuy8QKAyFK9Bs).

## What works today (phases 1 to 3)

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
  its cabinets against the port's capacity (650,000 by default, a 1G port at 8 bit and 60 Hz; set `"portCapacity"`
  on the processor to change it). Alerts for ports at 90% and over 100%, output faults, cabinets that stop answering
  or report faults, and broken links between cabinets.
- Processor syslog: point Tessera's syslog at this machine (UDP 5514) and every line lands in the event log under
  the processor that sent it. This is how Tessera reports things its API does not, such as genlock loss.
- The Mac menu bar app.
- A simulator for two SX40s (a primary and its backup) with faults you can switch on.

Read-only: nothing sends a control command to a processor yet. VX2000 Pro processors show as "not supported yet".

COEX caveats: NovaStar documents the field names but not their units or what each status number means. The driver
assumes °C, volts, brightness from 0 to 1 and status 0 as normal; check these against a real processor. COEX refuses
API requests while NovaStar's VMP software has the processor open, and the dashboard says so.

## Run it

On a Mac, build and install the app in one step:

```sh
scripts/deploy.sh
```

It appears in the menu bar. **Open Dashboard** opens it here; **Copy Link for Others** copies the address other people
on the network can open. **Demo Mode** adds two simulated SX40s and a simulated COEX MX40 Pro.

Without the app (any machine with Node 22):

```sh
scripts/build.sh run            # demo mode on http://localhost:8080
scripts/deploy.sh headless      # build and keep it running under pm2 as "led-monitor"
```

## Add processors

Enable IP control on each processor first (Tessera: the IP Control application). Then use **Open Settings Folder** in
the app (or `data/` when running headless), edit `config.json`, and choose **Restart Server**:

```json
{
  "port": 8080,
  "processors": [
    { "name": "Stage Main", "kind": "brompton", "host": "10.10.20.11" },
    { "name": "Stage Backup", "kind": "brompton", "host": "10.10.20.12" }
  ]
}
```

`kind` is `brompton`, `coex` or `vxpro`. `name` is optional (the processor's own name is used). Alert limits can be
changed under `"thresholds"`: `tempWarnC`, `tempCritC`, `fanMinRpm`, `tilesOfflineCritPercent`, `unreachableAfterPolls`.
`"syslogPort"` (default 5514, 0 for off) is where processors send syslog.

### Describe a Brompton wall

Tessera does not report where its tiles are, so each Brompton wall is described once. Give each processor an `id`,
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
npm run dev                     # server with the simulator on :8080, from source
npm run dev -w @ledmon/web      # dashboard with hot reload on :5173, talking to :8080
npm test
```

| Folder | What |
| --- | --- |
| `packages/shared` | Types shared by the server and the dashboard |
| `packages/server` | Drivers, health rules, monitor, web server, simulator |
| `packages/web` | The dashboard (React, Vite) |
| `packages/launcher` | The Mac menu bar app (Electron) |
| `scripts/` | `build.sh`, `deploy.sh`, `app-version.sh` |

## Versions and releases

Every merge to main is released automatically: `.github/workflows/auto-release.yml` tags it `vX.Y.Z` and publishes a
GitHub release. PR titles decide the bump: `feat:` minor, `fix:` (or anything else) patch, `!:` or `BREAKING CHANGE`
major, `[skip release]` none. The tag is the version; `scripts/app-version.sh` reads it for the dashboard footer and
the app. The Mac app is built on every pull request (Actions, "Mac app") and can be downloaded from the run.

The app is not signed. When it comes from a download rather than `scripts/deploy.sh`, open it the first time with
right-click, **Open**.
