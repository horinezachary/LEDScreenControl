# LED Monitor

Monitoring and control dashboard for the LED processors on one show network: Brompton Tessera SX40, NovaStar COEX
MX40 Pro and CX40 Pro, and NovaStar VX2000 Pro. A small server polls every processor, works out what is wrong, and
pushes it live to a web dashboard anyone on the network can open without logging in. A Mac menu bar app runs the
server, so nothing else needs installing.

Design: [LED Processor Monitor: Design](https://claude.ai/artifact/Tk6LkG374Yuy8QKAyFK9Bs).

## What works today (phase 1)

- Brompton Tessera processors over their HTTP IP control API (checked against Tessera 3.5.2): temperatures, fans,
  inputs and signal, genlock source, brightness, preset, blackout and freeze, failover role and partner, cable loops,
  tile counts and firmware.
- Health rules and alerts: unreachable, no signal on the active input, temperatures, fans, tiles offline or erroring,
  tile firmware mismatch, cable loop broken, partner missing, failover active.
- Overview page with live updates and an event log (kept in `events.jsonl` in the settings folder).
- The Mac menu bar app.
- A simulator for two SX40s (a primary and its backup) with faults you can switch on.

Read-only: nothing sends a control command to a processor yet. NovaStar processors show as "not supported yet".

## Run it

On a Mac, build and install the app in one step:

```sh
scripts/deploy.sh
```

It appears in the menu bar. **Open Dashboard** opens it here; **Copy Link for Others** copies the address other people
on the network can open. **Demo Mode** adds two simulated SX40s.

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

## Try faults with the simulator

In demo mode the log prints each simulated processor's port. Then, for example:

```sh
curl 'http://127.0.0.1:<port>/sim/scenario?set=signal-loss'
```

Scenarios: `normal`, `signal-loss`, `fan-failure`, `hot`, `tiles-offline`, `loop-broken`, `partner-lost`, `failover`.

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
