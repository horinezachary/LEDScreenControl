// Bundles the launcher (and the server inside it) into app/main.cjs and copies the dashboard and icons next to it.
// electron-builder then packages app/ (see "build" in package.json). Run scripts/build.sh rather than this directly.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'app');
let version = process.env.APP_VERSION;
if (!version) {
  try {
    version = execFileSync(path.join(here, '../../scripts/app-version.sh'), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    version = 'dev';
  }
}

const web = path.join(here, '../web/dist');
if (!fs.existsSync(path.join(web, 'index.html'))) {
  console.error('The dashboard is not built. Run: npm run build -w @ledmon/web');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  define: { __APP_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
fs.cpSync(web, path.join(out, 'web'), { recursive: true });
fs.cpSync(path.join(here, 'assets'), path.join(out, 'assets'), { recursive: true });
console.log(`Built the launcher (${version}).`);
