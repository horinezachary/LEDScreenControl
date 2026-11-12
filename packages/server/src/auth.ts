// The one admin password that guards the settings. Viewing and controls need no password, as designed.
//
// The password is kept as a scrypt hash in auth.json in the data folder (never in config.json, which people edit by
// hand). Unlocking gives the browser a random session cookie that lasts 30 minutes from its last use. Wrong guesses
// are limited per address. Until a password is set, only a browser on the machine running the monitor can set one,
// so nobody else on the show network can claim the settings first.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_MS = 30 * 60_000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60_000;
export const MIN_PASSWORD = 8;
export const COOKIE = 'ledmon_admin';

interface Stored {
  salt: string;
  hash: string;
  /** scrypt cost, kept so it can be raised later without breaking old hashes. */
  N: number;
}

export class Auth {
  private stored?: Stored;
  private sessions = new Map<string, number>();
  private fails = new Map<string, number[]>();
  private readonly file?: string;

  constructor(dataDir?: string) {
    if (dataDir) {
      this.file = path.join(dataDir, 'auth.json');
      try {
        this.stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Stored;
      } catch {
        this.stored = undefined;
      }
    }
  }

  get passwordSet(): boolean {
    return !!this.stored;
  }

  /** Sets or changes the password. Ends every other session. */
  setPassword(password: string): void {
    if (password.length < MIN_PASSWORD) throw new AuthError(`Use at least ${MIN_PASSWORD} characters.`, 400);
    const salt = crypto.randomBytes(16).toString('hex');
    const N = 16384;
    const hash = crypto.scryptSync(password, salt, 32, { N }).toString('hex');
    this.stored = { salt, hash, N };
    this.sessions.clear();
    if (this.file) {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.stored), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    }
  }

  check(password: string): boolean {
    if (!this.stored) return false;
    const want = Buffer.from(this.stored.hash, 'hex');
    const got = crypto.scryptSync(password, this.stored.salt, want.length, { N: this.stored.N });
    return crypto.timingSafeEqual(want, got);
  }

  /** Checks the password for a sign-in from one address and starts a session. Throws AuthError on refusal. */
  login(password: string, address: string, now = Date.now()): string {
    const recent = (this.fails.get(address) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILS) throw new AuthError('Too many wrong passwords. Wait a minute and try again.', 429);
    if (!this.stored) throw new AuthError('No settings password has been set yet.', 400);
    if (!this.check(password)) {
      this.fails.set(address, [...recent, now]);
      throw new AuthError('Wrong password.', 401);
    }
    this.fails.delete(address);
    return this.startSession(now);
  }

  startSession(now = Date.now()): string {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, now + SESSION_MS);
    return token;
  }

  /** True while the token is live; each use pushes the end back by 30 minutes. */
  touch(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false;
    const until = this.sessions.get(token);
    if (until === undefined || until < now) {
      this.sessions.delete(token ?? '');
      return false;
    }
    this.sessions.set(token, now + SESSION_MS);
    return true;
  }

  minutesLeft(token: string | undefined, now = Date.now()): number | undefined {
    const until = token ? this.sessions.get(token) : undefined;
    return until && until > now ? Math.ceil((until - now) / 60_000) : undefined;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function isLocal(address: string | undefined): boolean {
  return !!address && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
