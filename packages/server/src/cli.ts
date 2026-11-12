// Runs the server without the launcher app, e.g. on a spare machine or in CI:
//   node packages/server/dist/cli.cjs [--data <folder>] [--port <n>] [--web <folder>] [--simulate]
import path from 'node:path';
import { ConfigError, startServer } from './index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const here = typeof __dirname === 'string' ? __dirname : path.dirname(new URL(import.meta.url).pathname);
const dataDir = path.resolve(arg('data') ?? path.join(process.cwd(), 'data'));
const webRoot = path.resolve(arg('web') ?? path.join(here, '../../web/dist'));
const port = arg('port') ? Number(arg('port')) : undefined;

startServer({ dataDir, webRoot, port, simulate: process.argv.includes('--simulate') })
  .then((running) => {
    console.log(`Settings: ${path.join(dataDir, 'config.json')}`);
    const stop = () => void running.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })
  .catch((err: unknown) => {
    if (err instanceof ConfigError) console.error(`Settings problem: ${err.message}`);
    else if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error(`Port ${port ?? 'from config.json'} is already in use.`);
    else console.error(err);
    process.exit(1);
  });
