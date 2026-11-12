// Bundles the server into two CommonJS files: dist/cli.cjs (run with plain Node) and dist/index.cjs (loaded by the
// launcher app). The version comes from APP_VERSION, else scripts/app-version.sh, else "dev".
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
let version = process.env.APP_VERSION;
if (!version) {
  try {
    version = execFileSync(path.join(here, '../../scripts/app-version.sh'), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    version = 'dev';
  }
}

for (const entry of ['cli', 'index']) {
  await build({
    entryPoints: [path.join(here, `src/${entry}.ts`)],
    outfile: path.join(here, `dist/${entry}.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // ws tries these optional native helpers; it works without them.
    external: ['bufferutil', 'utf-8-validate'],
    define: { __APP_VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
  });
}
console.log(`Built the server (${version}).`);
