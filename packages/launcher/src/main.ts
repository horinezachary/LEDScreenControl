// LED Monitor's menu bar app. It runs the monitoring server inside itself, so there is nothing else to install, and
// gives a menu to open the dashboard, copy the link for others, open the settings folder and turn demo mode on or off.
import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { APP_VERSION, ConfigError, configPath, startServer, type RunningServer } from '../../server/src/index.js';

interface LauncherPrefs {
  demo: boolean;
  openedOnce: boolean;
}

let tray: Tray | undefined;
let running: RunningServer | undefined;
let problem: string | undefined;
let refresh: NodeJS.Timeout | undefined;

const dataDir = () => app.getPath('userData');
const prefsFile = () => path.join(dataDir(), 'launcher.json');
const webRoot = path.join(__dirname, 'web');

function readPrefs(): LauncherPrefs {
  try {
    return { demo: false, openedOnce: false, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch {
    return { demo: false, openedOnce: false };
  }
}

function writePrefs(p: LauncherPrefs): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2));
}

async function start(): Promise<void> {
  problem = undefined;
  const prefs = readPrefs();
  try {
    running = await startServer({ dataDir: dataDir(), webRoot, simulate: prefs.demo, log: (l) => console.log(l) });
  } catch (err) {
    running = undefined;
    if (err instanceof ConfigError) problem = `Settings problem: ${err.message}`;
    else if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') problem = 'The dashboard port is already in use. Change "port" in config.json.';
    else problem = `Could not start: ${(err as Error).message}`;
  }
  buildMenu();
  if (running && !prefs.openedOnce) {
    void shell.openExternal(dashboardUrl());
    writePrefs({ ...prefs, openedOnce: true });
  }
}

async function restart(): Promise<void> {
  await running?.close();
  running = undefined;
  await start();
}

function dashboardUrl(): string {
  return running ? `http://localhost:${running.port}` : '';
}

function shareUrl(): string {
  return running?.urls[0] ?? '';
}

function statusLine(): string {
  if (problem) return problem;
  if (!running) return 'Starting…';
  const s = running.monitor.state();
  const alerts = s.processors.reduce((n, p) => n + p.alerts.length, 0);
  const count = `${s.processors.length} processor${s.processors.length === 1 ? '' : 's'}`;
  if (s.processors.length === 0) return 'No processors set up yet';
  return alerts === 0 ? `All OK · ${count}` : `${alerts} alert${alerts === 1 ? '' : 's'} · ${count}`;
}

function buildMenu(): void {
  if (!tray) return;
  const prefs = readPrefs();
  const login = app.getLoginItemSettings().openAtLogin;
  const items: MenuItemConstructorOptions[] = [
    { label: `LED Monitor ${APP_VERSION}`, enabled: false },
    { label: statusLine(), enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', enabled: !!running, click: () => void shell.openExternal(dashboardUrl()) },
    {
      label: running ? `Copy Link for Others (${shareUrl().replace('http://', '')})` : 'Copy Link for Others',
      enabled: !!running,
      click: () => clipboard.writeText(shareUrl()),
    },
    { label: 'Open Settings', enabled: !!running, click: () => void shell.openExternal(`${dashboardUrl()}/settings`) },
    { type: 'separator' },
    {
      label: 'Demo Mode (simulated processors)',
      type: 'checkbox',
      checked: prefs.demo,
      click: (item) => {
        writePrefs({ ...readPrefs(), demo: item.checked });
        void restart();
      },
    },
    { label: 'Open Settings Folder', click: () => void shell.openPath(dataDir()) },
    { label: 'Restart Server (after editing the settings file)', click: () => void restart() },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: login,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit LED Monitor', role: 'quit' },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`LED Monitor: ${statusLine()}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (running) void shell.openExternal(dashboardUrl());
  });

  app.whenReady().then(async () => {
    app.dock?.hide();
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    buildMenu();
    await start();
    // Keep the status line in the menu current.
    refresh = setInterval(buildMenu, 5000);
    if (problem && !fs.existsSync(configPath(dataDir()))) {
      dialog.showErrorBox('LED Monitor', problem);
    }
  });

  // A menu bar app keeps running with no windows open.
  app.on('window-all-closed', () => {});

  app.on('before-quit', (e) => {
    if (!running) return;
    e.preventDefault();
    clearInterval(refresh);
    const r = running;
    running = undefined;
    void r.close().finally(() => app.exit(0));
  });
}
