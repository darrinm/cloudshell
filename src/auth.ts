/**
 * Authentication module for CloudShell.
 *
 * Supports four modes based on environment variables (checked in priority order):
 * - GitHub OAuth Proxy: CLOUDSHELL_OAUTH_PROXY_URL + CLOUDSHELL_OAUTH_SECRET
 * - GitHub OAuth (direct): GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET
 * - Password: CLOUDSHELL_PASSWORD
 * - None: open access
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// --- Auth mode detection ---

export type AuthMode = 'github-proxy' | 'github' | 'password' | 'none';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const CLOUDSHELL_PASSWORD = process.env.CLOUDSHELL_PASSWORD || '';
const GITHUB_ALLOWED_USERS = process.env.GITHUB_ALLOWED_USERS || '';
const CLOUDSHELL_OAUTH_PROXY_URL = process.env.CLOUDSHELL_OAUTH_PROXY_URL || '';
const CLOUDSHELL_OAUTH_SECRET = process.env.CLOUDSHELL_OAUTH_SECRET || '';

export const AUTH_MODE: AuthMode =
  CLOUDSHELL_OAUTH_PROXY_URL && CLOUDSHELL_OAUTH_SECRET
    ? 'github-proxy'
    : GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET
      ? 'github'
      : CLOUDSHELL_PASSWORD
        ? 'password'
        : 'none';

export const AUTH_ENABLED = AUTH_MODE !== 'none';

export {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  CLOUDSHELL_PASSWORD,
  CLOUDSHELL_OAUTH_PROXY_URL,
  CLOUDSHELL_OAUTH_SECRET,
};

// --- Username allowlist ---

const allowedUsers: Set<string> | null = GITHUB_ALLOWED_USERS
  ? new Set(GITHUB_ALLOWED_USERS.split(',').map((u) => u.trim().toLowerCase()))
  : null;

export function isUserAllowed(username: string): boolean {
  if (!allowedUsers) return true;
  return allowedUsers.has(username.toLowerCase());
}

// --- Server-side session store (persisted to disk) ---

export interface SessionData {
  githubToken: string;
  username: string;
  createdAt: number;
}

let sessionsDir: string | null = null;

/** Initialize session persistence directory. Must be called before any session ops. */
export function initSessionStore(cwd: string): void {
  sessionsDir = path.join(cwd, '.cloudshell', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
}

function sessionPath(sessionId: string): string {
  // Sanitize sessionId to prevent path traversal (should be hex, but be safe)
  const safe = sessionId.replace(/[^a-f0-9]/gi, '');
  if (!sessionsDir) throw new Error('Session store not initialized — call initSessionStore first');
  return path.join(sessionsDir, `${safe}.json`);
}

export function createSession(data: SessionData): string {
  const sessionId = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(sessionPath(sessionId), JSON.stringify(data), { mode: 0o600 });
  return sessionId;
}

export function getSession(sessionId: string): SessionData | undefined {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(sessionId), 'utf8'));
  } catch {
    return undefined;
  }
}

export function deleteSession(sessionId: string): boolean {
  try {
    fs.unlinkSync(sessionPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

// --- OAuth state store (CSRF protection) ---

const pendingStates = new Map<string, number>(); // state → timestamp
const STATE_TTL = 10 * 60 * 1000; // 10 minutes

export function createOAuthState(): string {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  // Clean up expired states
  for (const [s, ts] of pendingStates) {
    if (Date.now() - ts > STATE_TTL) pendingStates.delete(s);
  }
  return state;
}

export function validateOAuthState(state: string): boolean {
  const ts = pendingStates.get(state);
  if (!ts) return false;
  pendingStates.delete(state);
  return Date.now() - ts < STATE_TTL;
}

// --- Cookie helpers ---

export const COOKIE_NAME = 'cloudshell_session';
export const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : undefined;
}

// --- AES-256-GCM decrypt (for OAuth proxy payloads) ---

export interface OAuthProxyPayload {
  token: string;
  username: string;
  ts: number;
}

/**
 * Decrypt a base64url-encoded AES-256-GCM payload from the OAuth proxy.
 * Format: base64url(nonce(12) || ciphertext || tag(16))
 */
export function decryptPayload(secretHex: string, encoded: string): OAuthProxyPayload {
  const key = Buffer.from(secretHex, 'hex');
  if (key.length !== 32) throw new Error('Invalid secret length');

  const data = Buffer.from(encoded, 'base64url');
  if (data.length < 28) throw new Error('Payload too short'); // 12 nonce + 16 tag minimum

  const nonce = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(12, data.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}
