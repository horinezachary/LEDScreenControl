// Set by build.mjs from scripts/app-version.sh. Running from source with tsx, it is "dev".
declare const __APP_VERSION__: string | undefined;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
