/**
 * Authentication.
 *
 * Two ways in, both ending at the same long-lived device credential:
 *
 *   password login   for desktops, with "remember this device"
 *   pairing link     `ptyhub link [--qr]`, for phones and tablets where typing
 *                    a password is miserable
 *
 * The credential is `<deviceId>.<secret>` in an HttpOnly cookie. Only a hash of
 * the secret is stored, and the secret is rotated periodically; presenting a
 * superseded secret after the grace window means the cookie was copied, so the
 * whole device chain is revoked rather than silently accepted.
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../shared/config.ts';
import { paths, readJson, writeJson } from '../shared/config.ts';
import type { AuthContext } from './http-util.ts';

export const COOKIE_NAME = 'ptyhub_dev';

const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
/** In-flight requests may still carry the previous secret for this long. */
const ROTATION_GRACE_MS = 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const SCRYPT_KEYLEN = 32;

const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

interface UserRecord {
  name: string;
  salt: string;
  hash: string;
}

interface AuthFile {
  users: UserRecord[];
}

interface DeviceRecord {
  id: string;
  user: string;
  hash: string;
  prevHash: string | null;
  prevExpiresAt: number;
  label: string;
  userAgent: string;
  ip: string;
  createdAt: number;
  lastUsedAt: number;
  rotatedAt: number;
  expiresAt: number;
}

interface DevicesFile {
  devices: DeviceRecord[];
}

interface PairingRecord {
  hash: string;
  user: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

interface PairingFile {
  pairings: PairingRecord[];
}

export interface DeviceSummary {
  id: string;
  label: string;
  userAgent: string;
  ip: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function verifyPassword(password: string, record: UserRecord): boolean {
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(
      password,
      Buffer.from(record.salt, 'base64'),
      SCRYPT_KEYLEN,
      SCRYPT,
    );
  } catch {
    return false;
  }
  const stored = Buffer.from(record.hash, 'base64');
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return typeof first === 'string' && first.split(',')[0]!.trim() === 'https';
}

function setCookie(
  req: IncomingMessage,
  res: ServerResponse,
  value: string,
  maxAgeMs: number | null,
): void {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  // Marking a cookie Secure over plain http makes the browser drop it, and
  // ptyhub is normally reached over http on loopback or through a tunnel.
  if (isSecureRequest(req)) bits.push('Secure');
  if (maxAgeMs !== null) bits.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  appendSetCookie(res, bits.join('; '));
}

function clearCookie(req: IncomingMessage, res: ServerResponse): void {
  const bits = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) bits.push('Secure');
  appendSetCookie(res, bits.join('; '));
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie]);
  else if (typeof existing === 'string') res.setHeader('Set-Cookie', [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}

// ---------------------------------------------------------------------------

export type LoginFailure =
  | { ok: false; reason: 'locked'; retryAfterMs: number }
  | { ok: false; reason: 'bad_credentials' };

export type LoginResult = { ok: true; user: string } | LoginFailure;

export class Auth {
  private devices: DevicesFile;
  private failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly cfg: Config,
    private readonly log: (msg: string) => void,
  ) {
    this.devices = readJson<DevicesFile>(paths.devices, { devices: [] });
    this.pruneDevices();
  }

  // --- Configuration state -------------------------------------------------

  private users(): UserRecord[] {
    return readJson<AuthFile>(paths.auth, { users: [] }).users ?? [];
  }

  get passwordConfigured(): boolean {
    return this.users().length > 0;
  }

  /**
   * True only when the operator has explicitly declared the network already
   * authenticated.
   *
   * Binding to loopback is deliberately NOT treated as safe. On a shared
   * machine — a cluster login node, a lab box, anything with other accounts —
   * 127.0.0.1 is reachable by every local user, and this service hands out a
   * shell. Without a password we fall back to an access token, not to nothing.
   */
  get openAccess(): boolean {
    return this.cfg.trustedNetwork;
  }

  /**
   * Persistent access token used when no password has been set.
   *
   * Same idea as a Jupyter token: zero configuration, still not open to
   * everyone else on the machine. Setting a password retires it.
   */
  serverToken(): string | null {
    if (this.passwordConfigured || this.cfg.trustedNetwork) return null;
    const stored = readJson<{ token?: string }>(paths.token, {});
    if (typeof stored.token === 'string' && stored.token.length >= 32) {
      return stored.token;
    }
    const token = crypto.randomBytes(24).toString('base64url');
    writeJson(paths.token, { token, createdAt: Date.now() }, 0o600);
    return token;
  }

  /** The URL that gets a new device in, or null when a password is in use. */
  accessUrl(host: string, port: number): string | null {
    const token = this.serverToken();
    return token ? `http://${host}:${port}/#k=${token}` : null;
  }

  startupError(): string | null {
    return null;
  }

  // --- Request authentication ----------------------------------------------

  authenticate(req: IncomingMessage): AuthContext | null {
    if (this.openAccess) {
      return { user: this.cfg.trustedNetwork ? 'trusted' : 'local', deviceId: null };
    }

    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!raw) return null;

    const dot = raw.indexOf('.');
    if (dot <= 0) return null;
    const id = raw.slice(0, dot);
    const secret = raw.slice(dot + 1);

    const device = this.devices.devices.find((d) => d.id === id);
    if (!device) return null;

    const now = Date.now();
    if (device.expiresAt < now) {
      this.removeDevice(id);
      return null;
    }

    const presented = sha256(secret);
    if (constantTimeEquals(device.hash, presented)) {
      device.lastUsedAt = now;
      this.saveDevicesSoon();
      return { user: device.user, deviceId: device.id };
    }

    if (device.prevHash && constantTimeEquals(device.prevHash, presented)) {
      if (device.prevExpiresAt >= now) {
        // A request that was already in flight when we rotated. Allow it.
        return { user: device.user, deviceId: device.id };
      }
      // A secret we retired a while ago just came back. The only way that
      // happens is a copied cookie, so burn the whole device.
      this.log(`revoking device ${id}: stale credential replayed`);
      this.removeDevice(id);
      return null;
    }

    return null;
  }

  /**
   * Called on authenticated HTTP responses. Rotates the device secret on a slow
   * schedule so a leaked cookie has a bounded useful life, and so replay of an
   * old one becomes detectable.
   */
  maybeRotate(req: IncomingMessage, res: ServerResponse, auth: AuthContext): void {
    if (!auth.deviceId) return;
    const device = this.devices.devices.find((d) => d.id === auth.deviceId);
    if (!device) return;

    const now = Date.now();
    if (now - device.rotatedAt < ROTATE_AFTER_MS) return;

    const secret = crypto.randomBytes(32).toString('base64url');
    device.prevHash = device.hash;
    device.prevExpiresAt = now + ROTATION_GRACE_MS;
    device.hash = sha256(secret);
    device.rotatedAt = now;
    device.expiresAt = now + DEVICE_TTL_MS;
    this.saveDevices();
    setCookie(req, res, `${device.id}.${secret}`, DEVICE_TTL_MS);
  }

  // --- Login ---------------------------------------------------------------

  login(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    password: string,
    remember: boolean,
  ): LoginResult {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const lock = this.failures.get(ip);
    const now = Date.now();
    if (lock && lock.lockedUntil > now) {
      return { ok: false, reason: 'locked', retryAfterMs: lock.lockedUntil - now };
    }

    const user = this.users().find((u) => u.name === name);
    // Hash even when the user does not exist so the response time does not
    // reveal which usernames are real.
    const dummy: UserRecord = {
      name,
      salt: Buffer.alloc(16).toString('base64'),
      hash: Buffer.alloc(SCRYPT_KEYLEN).toString('base64'),
    };
    const ok = verifyPassword(password, user ?? dummy) && user !== undefined;

    if (!ok) {
      this.recordFailure(ip);
      return { ok: false, reason: 'bad_credentials' };
    }

    this.failures.delete(ip);
    this.issueDevice(req, res, user.name, remember);
    return { ok: true, user: user.name };
  }

  private recordFailure(ip: string): void {
    const entry = this.failures.get(ip) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= LOCKOUT_THRESHOLD) {
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
      entry.count = 0;
      this.log(`locking out ${ip} after repeated failed logins`);
    }
    this.failures.set(ip, entry);
  }

  // --- Pairing links -------------------------------------------------------

  /** Called by the CLI: mint a one-shot key and return it for display. */
  static createPairing(user: string): { key: string; expiresAt: number } {
    const key = crypto.randomBytes(24).toString('base64url');
    const file = readJson<PairingFile>(paths.pairings, { pairings: [] });
    const now = Date.now();
    const record: PairingRecord = {
      hash: sha256(key),
      user,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      usedAt: null,
    };
    const kept = (file.pairings ?? []).filter(
      (p) => p.expiresAt > now && p.usedAt === null,
    );
    writeJson(paths.pairings, { pairings: [...kept, record] });
    return { key, expiresAt: record.expiresAt };
  }

  /**
   * Redeem a pairing key for a device credential.
   *
   * One-shot pairing links die on use. The standing access token, which only
   * exists while no password is configured, can be used repeatedly — it is the
   * only way in at that point.
   */
  pair(req: IncomingMessage, res: ServerResponse, key: string): string | null {
    const token = this.serverToken();
    if (token && constantTimeEquals(token, key)) {
      this.issueDevice(req, res, 'local', true);
      return 'local';
    }

    const file = readJson<PairingFile>(paths.pairings, { pairings: [] });
    const now = Date.now();
    const hash = sha256(key);
    const match = (file.pairings ?? []).find(
      (p) => p.usedAt === null && p.expiresAt > now && constantTimeEquals(p.hash, hash),
    );
    if (!match) {
      this.recordFailure(req.socket.remoteAddress ?? 'unknown');
      return null;
    }
    match.usedAt = now;
    writeJson(paths.pairings, {
      pairings: (file.pairings ?? []).filter((p) => p.expiresAt > now),
    });
    this.issueDevice(req, res, match.user, true);
    return match.user;
  }

  // --- Device management ---------------------------------------------------

  private issueDevice(
    req: IncomingMessage,
    res: ServerResponse,
    user: string,
    remember: boolean,
  ): void {
    const now = Date.now();
    const id = crypto.randomBytes(9).toString('base64url');
    const secret = crypto.randomBytes(32).toString('base64url');
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 200);

    this.devices.devices.push({
      id,
      user,
      hash: sha256(secret),
      prevHash: null,
      prevExpiresAt: 0,
      label: describeUserAgent(userAgent),
      userAgent,
      ip: req.socket.remoteAddress ?? 'unknown',
      createdAt: now,
      lastUsedAt: now,
      rotatedAt: now,
      expiresAt: now + DEVICE_TTL_MS,
    });
    this.saveDevices();
    // Without "remember", the cookie dies with the browser session.
    setCookie(req, res, `${id}.${secret}`, remember ? DEVICE_TTL_MS : null);
  }

  logout(req: IncomingMessage, res: ServerResponse, auth: AuthContext): void {
    if (auth.deviceId) this.removeDevice(auth.deviceId);
    clearCookie(req, res);
  }

  listDevices(current: string | null): DeviceSummary[] {
    this.pruneDevices();
    return this.devices.devices
      .map((d) => ({
        id: d.id,
        label: d.label,
        userAgent: d.userAgent,
        ip: d.ip,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
        expiresAt: d.expiresAt,
        current: d.id === current,
      }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  removeDevice(id: string): boolean {
    const before = this.devices.devices.length;
    this.devices.devices = this.devices.devices.filter((d) => d.id !== id);
    if (this.devices.devices.length === before) return false;
    this.saveDevices();
    return true;
  }

  revokeAll(): void {
    this.devices.devices = [];
    this.saveDevices();
  }

  private pruneDevices(): void {
    const now = Date.now();
    const kept = this.devices.devices.filter((d) => d.expiresAt > now);
    if (kept.length !== this.devices.devices.length) {
      this.devices.devices = kept;
      this.saveDevices();
    }
  }

  private saveTimer: NodeJS.Timeout | null = null;

  private saveDevicesSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveDevices();
    }, 5000);
    this.saveTimer.unref?.();
  }

  private saveDevices(): void {
    writeJson(paths.devices, this.devices, 0o600);
  }
}

/** A short human label so the device list is readable at a glance. */
function describeUserAgent(ua: string): string {
  const platform =
    /iPhone/i.test(ua) ? 'iPhone'
    : /iPad/i.test(ua) ? 'iPad'
    : /Android/i.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/i.test(ua) ? 'Mac'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Device';

  const browser =
    /Edg\//i.test(ua) ? 'Edge'
    : /OPR\//i.test(ua) ? 'Opera'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Safari\//i.test(ua) ? 'Safari'
    : 'browser';

  return `${platform} · ${browser}`;
}
