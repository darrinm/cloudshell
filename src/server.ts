#!/usr/bin/env node
/**
 * CloudShell server — Express + WebSocket + CLI
 */
import { execSync } from 'child_process';
import { program } from 'commander';
// Password-mode JWT (only used when AUTH_MODE === 'password')
import crypto from 'crypto';
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';

import { clearSession, streamAgentSdk } from './agent-stream.js';
import {
  AUTH_ENABLED,
  AUTH_MODE,
  CLOUDSHELL_OAUTH_PROXY_URL,
  CLOUDSHELL_OAUTH_SECRET,
  CLOUDSHELL_PASSWORD,
  COOKIE_MAX_AGE,
  COOKIE_NAME,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  createOAuthState,
  createSession,
  decryptPayload,
  deleteSession,
  getSession,
  initSessionStore,
  isUserAllowed,
  parseCookie,
  validateOAuthState,
} from './auth.js';
import { BlockAccumulator } from './block-accumulator.js';
import {
  createConversation,
  createTab,
  deleteConversation,
  deleteMessages,
  deleteTab,
  getConversation,
  getMessages,
  getTabs,
  reorderTabs,
  saveMessage,
  updateConversation,
  updateTab,
} from './db.js';
import {
  detachWebSocket,
  handlePtyMessage,
  killAllSessions,
  killDetachedExcept,
  killSession,
} from './pty-server.js';
import type { ClientMessage } from './types.js';

// CLI args
program
  .option('-p, --port <number>', 'Port to listen on', '4444')
  .option('--cwd <path>', 'Working directory', process.cwd())
  .option('--open', 'Open browser on startup')
  .parse();

const opts = program.opts();
const PORT = parseInt(opts.port, 10);
const CWD = path.resolve(opts.cwd);
const AUTO_OPEN = opts.open === true;

initSessionStore(CWD);

const webDist = path.join(import.meta.dirname, '..', 'web', 'dist');

// Persist JWT secret so sessions survive server restarts
const jwtSecretPath = path.join(CWD, '.cloudshell', 'jwt-secret');
function loadOrCreateJwtSecret(): string {
  try {
    return fs.readFileSync(jwtSecretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(jwtSecretPath), { recursive: true });
    fs.writeFileSync(jwtSecretPath, secret, { mode: 0o600 });
    return secret;
  }
}
const JWT_SECRET = loadOrCreateJwtSecret();
const JWT_EXPIRY = '7d';

function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

/** Resolve GitHub token from session cookie, or undefined if not in GitHub mode */
function resolveGithubToken(cookieHeader: string | undefined): string | undefined {
  if (AUTH_MODE !== 'github' && AUTH_MODE !== 'github-proxy') return undefined;
  const sessionId = parseCookie(cookieHeader, COOKIE_NAME);
  if (!sessionId) return undefined;
  return getSession(sessionId)?.githubToken;
}

/** Verify that the request has a valid session (works for both auth modes) */
function isAuthenticated(cookieHeader: string | undefined): boolean {
  if (!AUTH_ENABLED) return true;
  const cookieValue = parseCookie(cookieHeader, COOKIE_NAME);
  if (!cookieValue) return false;
  if (AUTH_MODE === 'github' || AUTH_MODE === 'github-proxy') return !!getSession(cookieValue);
  return verifyToken(cookieValue); // password mode
}

/** Extract userId from the authenticated request (JWT username or GitHub session username) */
function resolveUserId(req: express.Request): string {
  if (!AUTH_ENABLED) return 'default';
  const cookieValue = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (!cookieValue) return 'default';
  if (AUTH_MODE === 'github' || AUTH_MODE === 'github-proxy') {
    const session = getSession(cookieValue);
    return session?.username || 'default';
  }
  // password mode — decode JWT
  try {
    const payload = jwt.verify(cookieValue, JWT_SECRET) as { username?: string };
    return payload.username || 'default';
  } catch {
    return 'default';
  }
}

const app = express();
const server = createServer(app);

// WebSocket server — resolve session context on upgrade for GitHub token injection
const wsGithubTokens = new WeakMap<WebSocket, string>();

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket, req) => {
  // Capture GitHub token from session at connection time
  const ghToken = resolveGithubToken(req.headers.cookie);
  if (ghToken) wsGithubTokens.set(ws, ghToken);

  ws.on('message', (raw: Buffer) => {
    try {
      const msg: ClientMessage = JSON.parse(raw.toString());
      handlePtyMessage(ws, msg, CWD, wsGithubTokens.get(ws));
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  });
  ws.on('close', () => {
    detachWebSocket(ws);
  });
});

// JSON body parsing
app.use(express.json({ limit: '10mb' }));

// Auth middleware — protect /api/* except auth endpoints
const AUTH_BYPASS_PATHS = new Set([
  '/auth/login',
  '/auth/check',
  '/auth/logout',
  '/auth/github',
  '/auth/github/callback',
  '/auth/github/complete',
]);

if (AUTH_ENABLED) {
  console.log(`[AUTH] ${AUTH_MODE === 'github' ? 'GitHub OAuth' : 'Password'} protection enabled`);
  app.use('/api', (req, res, next) => {
    if (AUTH_BYPASS_PATHS.has(req.path)) return next();
    if (!isAuthenticated(req.headers.cookie)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  });
}

// --- Auth endpoints ---

app.get('/api/auth/check', (req, res) => {
  if (!AUTH_ENABLED) {
    res.json({ authenticated: true, authEnabled: false, authMode: 'none' });
    return;
  }
  const authenticated = isAuthenticated(req.headers.cookie);
  const result: Record<string, unknown> = {
    authenticated,
    authEnabled: true,
    // Report 'github' to frontend for both direct and proxy modes (same UI behavior)
    authMode: AUTH_MODE === 'github-proxy' ? 'github' : AUTH_MODE,
  };
  if (authenticated) {
    if (AUTH_MODE === 'github' || AUTH_MODE === 'github-proxy') {
      const sessionId = parseCookie(req.headers.cookie, COOKIE_NAME);
      if (sessionId) {
        const session = getSession(sessionId);
        if (session) result.username = session.username;
      }
    } else if (AUTH_MODE === 'password') {
      const cookieValue = parseCookie(req.headers.cookie, COOKIE_NAME);
      if (cookieValue) {
        try {
          const payload = jwt.verify(cookieValue, JWT_SECRET) as { username?: string };
          if (payload.username) result.username = payload.username;
        } catch {
          // token invalid — ignore
        }
      }
    }
  }
  res.json(result);
});

// Password login (only active in password mode)
app.post('/api/auth/login', (req, res) => {
  if (AUTH_MODE !== 'password') {
    res.status(404).json({ error: 'Password login not available' });
    return;
  }
  const { password, username } = req.body;
  if (!username) {
    res.status(400).json({ error: 'Username required' });
    return;
  }
  if (password !== CLOUDSHELL_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  const token = jwt.sign({ ts: Date.now(), username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
  res.json({ authenticated: true });
});

app.post('/api/auth/logout', (req, res) => {
  if (AUTH_MODE === 'github' || AUTH_MODE === 'github-proxy') {
    const sessionId = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (sessionId) deleteSession(sessionId);
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ authenticated: false });
});

// --- GitHub OAuth endpoints (only active in github mode) ---

app.get('/api/auth/github', (_req, res) => {
  if (AUTH_MODE === 'github-proxy') {
    // Proxy mode: redirect to the backend OAuth proxy with our origin
    const origin = `${_req.protocol}://${_req.get('host')}`;
    const proxyUrl = `${CLOUDSHELL_OAUTH_PROXY_URL}?origin=${encodeURIComponent(origin)}`;
    res.redirect(proxyUrl);
    return;
  }
  if (AUTH_MODE !== 'github') {
    res.status(404).json({ error: 'GitHub auth not configured' });
    return;
  }
  const state = createOAuthState();
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${_req.protocol}://${_req.get('host')}/api/auth/github/callback`,
    scope: 'repo read:user',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/api/auth/github/callback', async (req, res) => {
  if (AUTH_MODE !== 'github') {
    res.status(404).json({ error: 'GitHub auth not configured' });
    return;
  }

  const { code, state, error: oauthError } = req.query;

  if (oauthError || !code || !state) {
    res.redirect(`/?error=${encodeURIComponent(String(oauthError || 'missing_code'))}`);
    return;
  }

  if (!validateOAuthState(String(state))) {
    res.redirect(`/?error=invalid_state`);
    return;
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code: String(code),
      }),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };

    if (!tokenData.access_token) {
      res.redirect(`/?error=${encodeURIComponent(tokenData.error || 'token_exchange_failed')}`);
      return;
    }

    // Fetch user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    const userData = (await userRes.json()) as { login?: string };

    if (!userData.login) {
      res.redirect(`/?error=user_fetch_failed`);
      return;
    }

    // Check allowlist
    if (!isUserAllowed(userData.login)) {
      res.redirect(`/?error=access_denied&user=${encodeURIComponent(userData.login)}`);
      return;
    }

    // Create session
    const sessionId = createSession({
      githubToken: tokenData.access_token,
      username: userData.login,
      createdAt: Date.now(),
    });

    res.cookie(COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });

    console.log(`[AUTH] GitHub user '${userData.login}' authenticated`);
    res.redirect(`/`);
  } catch (err) {
    console.error('[AUTH] GitHub OAuth error:', err);
    res.redirect(`/?error=oauth_failed`);
  }
});

// --- GitHub OAuth proxy completion endpoint (only active in github-proxy mode) ---

app.get('/api/auth/github/complete', (req, res) => {
  if (AUTH_MODE !== 'github-proxy') {
    res.status(404).json({ error: 'OAuth proxy not configured' });
    return;
  }

  const { payload: encodedPayload } = req.query;
  if (!encodedPayload || typeof encodedPayload !== 'string') {
    res.redirect(`/?error=missing_payload`);
    return;
  }

  try {
    const payload = decryptPayload(CLOUDSHELL_OAUTH_SECRET, encodedPayload);

    // Validate timestamp (5 min TTL)
    if (Date.now() - payload.ts * 1000 > 5 * 60 * 1000) {
      res.redirect(`/?error=payload_expired`);
      return;
    }

    // Check allowlist
    if (!isUserAllowed(payload.username)) {
      res.redirect(`/?error=access_denied&user=${encodeURIComponent(payload.username)}`);
      return;
    }

    // Create session
    const sessionId = createSession({
      githubToken: payload.token,
      username: payload.username,
      createdAt: Date.now(),
    });

    res.cookie(COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });

    console.log(`[AUTH] GitHub proxy user '${payload.username}' authenticated`);
    res.redirect(`/`);
  } catch (err) {
    console.error('[AUTH] GitHub proxy payload decryption failed:', err);
    res.redirect(`/?error=invalid_payload`);
  }
});

// Upload directory
const uploadDir = path.join(CWD, '.cloudshell', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });

// API routes
app.get('/api/config', (_req, res) => {
  res.json({ cwd: CWD, port: PORT });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }
  const ext = path.extname(req.file.originalname);
  const newPath = path.join(uploadDir, req.file.filename + ext);
  fs.renameSync(req.file.path, newPath);
  res.json({
    filename: req.file.filename + ext,
    originalName: req.file.originalname,
    size: req.file.size,
    url: `/api/files/${req.file.filename}${ext}`,
  });
});

app.get('/api/files/:filename', (req, res) => {
  const filePath = path.resolve(uploadDir, req.params.filename);
  if (!filePath.startsWith(uploadDir + path.sep)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  res.sendFile(filePath);
});

// --- Tab CRUD endpoints ---

app.get('/api/tabs', (req, res) => {
  const userId = resolveUserId(req);
  const tabs = getTabs(CWD, userId);
  res.json({ tabs });
});

app.post('/api/tabs', (req, res) => {
  const userId = resolveUserId(req);
  const { type, title } = req.body;
  if (!type || !['terminal', 'code', 'agent'].includes(type)) {
    res.status(400).json({ error: 'type required (terminal, code, agent)' });
    return;
  }
  const tab = createTab(CWD, userId, { type, title });

  // For agent tabs, also create a conversation
  if (type === 'agent') {
    createConversation(CWD, tab.id, tab.title, userId);
  }

  res.json(tab);
});

// Reorder must come before :id routes to avoid matching "reorder" as an id
app.put('/api/tabs/reorder', (req, res) => {
  const userId = resolveUserId(req);
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    res.status(400).json({ error: 'orderedIds array required' });
    return;
  }
  reorderTabs(CWD, userId, orderedIds);
  res.json({ ok: true });
});

app.put('/api/tabs/:id', (req, res) => {
  const userId = resolveUserId(req);
  const { title } = req.body;
  updateTab(CWD, userId, req.params.id, { title });
  res.json({ ok: true });
});

app.delete('/api/tabs/:id', (req, res) => {
  const userId = resolveUserId(req);
  const tabId = req.params.id;

  // Kill PTY and clear agent session
  killSession(tabId);
  clearSession(tabId);

  // Delete conversation if it exists
  deleteConversation(CWD, tabId, userId);

  // Delete the tab
  deleteTab(CWD, userId, tabId);
  res.json({ ok: true });
});

// Conversation CRUD endpoints
app.post('/api/conversations', (req, res) => {
  const userId = resolveUserId(req);
  const { id, title, model, thinkingEnabled, thinkingBudget, thinkingEffort } = req.body;
  if (!id || !title) {
    res.status(400).json({ error: 'id and title required' });
    return;
  }
  createConversation(CWD, id, title, userId, {
    model,
    thinkingEnabled,
    thinkingBudget,
    thinkingEffort,
  });
  res.json({ ok: true });
});

app.get('/api/conversations/:id', (req, res) => {
  const userId = resolveUserId(req);
  const conv = getConversation(CWD, req.params.id, userId);
  if (!conv) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(conv);
});

app.put('/api/conversations/:id', (req, res) => {
  const userId = resolveUserId(req);
  const { title, model, thinking_enabled, thinking_budget, thinking_effort } = req.body;
  const fields: Record<string, unknown> = {};
  if (title !== undefined) fields.title = title;
  if (model !== undefined) fields.model = model;
  if (thinking_enabled !== undefined) fields.thinking_enabled = thinking_enabled;
  if (thinking_budget !== undefined) fields.thinking_budget = thinking_budget;
  if (thinking_effort !== undefined) fields.thinking_effort = thinking_effort;
  updateConversation(CWD, req.params.id, fields, userId);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  const userId = resolveUserId(req);
  deleteConversation(CWD, req.params.id, userId);
  res.json({ ok: true });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const userId = resolveUserId(req);
  if (!getConversation(CWD, req.params.id, userId)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const messages = getMessages(CWD, req.params.id);
  res.json(messages);
});

app.post('/api/conversations/:id/messages', (req, res) => {
  const userId = resolveUserId(req);
  const { id: msgId, role, blocks, timestamp } = req.body;
  if (!msgId || !role || !blocks) {
    res.status(400).json({ error: 'id, role, blocks required' });
    return;
  }
  // Auto-create conversation if it doesn't exist (race: message arrives before POST /api/conversations)
  createConversation(CWD, req.params.id, 'Chat', userId);
  saveMessage(CWD, {
    id: msgId,
    conversationId: req.params.id,
    role,
    blocks: typeof blocks === 'string' ? blocks : JSON.stringify(blocks),
    timestamp: timestamp || new Date().toISOString(),
  });
  res.json({ ok: true });
});

app.delete('/api/conversations/:id/messages', (req, res) => {
  const userId = resolveUserId(req);
  if (!getConversation(CWD, req.params.id, userId)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  deleteMessages(CWD, req.params.id);
  res.json({ ok: true });
});

// Tab cleanup — kill PTY and clear agent session
app.post('/api/tabs/:id/cleanup', (req, res) => {
  const tabId = req.params.id;
  killSession(tabId);
  clearSession(tabId);
  res.json({ ok: true });
});

// Reconcile server state with client — kill orphaned (detached) PTY processes.
// Only kills PTYs with no WebSocket attached AND not in client's tab list,
// so another browser's active sessions are safe.
app.post('/api/reconcile', (req, res) => {
  const { tabIds } = req.body;
  if (!Array.isArray(tabIds)) {
    res.status(400).json({ error: 'tabIds array required' });
    return;
  }
  const keepSet = new Set<string>(tabIds);
  const killedPty = killDetachedExcept(keepSet);
  if (killedPty.length > 0) {
    console.log(
      `[RECONCILE] Killed ${killedPty.length} orphaned PTY sessions: ${killedPty.join(', ')}`,
    );
  }
  res.json({ ok: true, killedPty: killedPty.length });
});

// File listing for @-mention autocomplete
let fileListCache: { files: string[]; ts: number } | null = null;
const FILE_CACHE_TTL = 5000;

function getFileList(): string[] {
  if (fileListCache && Date.now() - fileListCache.ts < FILE_CACHE_TTL) return fileListCache.files;
  let files: string[];
  try {
    const out = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: CWD,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    files = out.split('\n').filter(Boolean);
  } catch {
    // Not a git repo — fallback to recursive readdir
    files = [];
    const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.cloudshell']);
    function walk(dir: string, prefix: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else files.push(rel);
      }
    }
    walk(CWD, '');
  }
  fileListCache = { files, ts: Date.now() };
  return files;
}

app.get('/api/project/files', (_req, res) => {
  const q = (typeof _req.query.q === 'string' ? _req.query.q : '').toLowerCase();
  const files = getFileList();
  const filtered = (q ? files.filter((f) => f.toLowerCase().includes(q)) : files).filter(
    (f) => f !== '-' && !f.split('/').some((seg) => seg.startsWith('.')),
  );
  const results = filtered.slice(0, 20).map((f) => ({ path: f, type: 'file' as const }));
  res.json(results);
});

app.get('/api/project/file', (_req, res) => {
  const relPath = typeof _req.query.path === 'string' ? _req.query.path : '';
  if (!relPath) {
    res.status(400).json({ error: 'path required' });
    return;
  }
  const resolved = path.resolve(CWD, relPath);
  if (!resolved.startsWith(CWD + path.sep) && resolved !== CWD) {
    res.status(403).json({ error: 'Path traversal not allowed' });
    return;
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs
        .readdirSync(resolved, { withFileTypes: true })
        .map((e) => e.name + (e.isDirectory() ? '/' : ''));
      res.json({ path: relPath, type: 'dir', entries });
      return;
    }
    // Binary detection
    const fd = fs.openSync(resolved, 'r');
    const probe = Buffer.alloc(1024);
    const bytesRead = fs.readSync(fd, probe, 0, 1024, 0);
    fs.closeSync(fd);
    if (probe.subarray(0, bytesRead).includes(0)) {
      res.status(400).json({ error: 'Binary file' });
      return;
    }
    const MAX_SIZE = 100 * 1024;
    let content = fs.readFileSync(resolved, 'utf8');
    let truncated = false;
    if (content.length > MAX_SIZE) {
      content = content.slice(0, MAX_SIZE);
      truncated = true;
    }
    res.json({
      path: relPath,
      type: 'file',
      content: truncated ? content + '\n\n[Truncated at 100KB]' : content,
    });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// Chat endpoint — SSE streaming
// Resolve local image URLs to base64 for the API
function resolveLocalImages(messages: any[]): any[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const content = msg.content.map((part: any) => {
      if (
        part.type === 'image' &&
        part.source?.type === 'url' &&
        part.source.url?.startsWith('/api/files/')
      ) {
        const filename = part.source.url.replace('/api/files/', '');
        const filePath = path.resolve(uploadDir, filename);
        if (!filePath.startsWith(uploadDir + path.sep)) return part;
        try {
          const data = fs.readFileSync(filePath);
          const ext = path.extname(filename).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
          };
          const mediaType = mimeMap[ext] || 'image/png';
          return {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
          };
        } catch {
          return part; // fall through if file missing
        }
      }
      return part;
    });
    return { ...msg, content };
  });
}

app.post('/api/chat', async (req, res) => {
  const { messages, model, tab_id, thinking } = req.body;
  const conversationId = tab_id || 'default';

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set. Start CloudShell with ANTHROPIC_API_KEY=sk-... in your environment.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const abortController = new AbortController();
  res.on('close', () => abortController.abort());

  const accumulator = new BlockAccumulator();
  const messageId = `assistant-${Date.now()}`;

  function saveAssistantMessage() {
    if (accumulator.blocks.length === 0) return;
    try {
      const conv = getConversation(CWD, conversationId);
      if (!conv) return;
      saveMessage(CWD, {
        id: messageId,
        conversationId,
        role: 'assistant',
        blocks: JSON.stringify(accumulator.blocks),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[CHAT] Failed to save assistant message:', err);
    }
  }

  try {
    const resolvedMessages = resolveLocalImages(messages);
    const githubToken = resolveGithubToken(req.headers.cookie);
    for await (const event of streamAgentSdk(
      conversationId,
      resolvedMessages,
      model || 'claude-sonnet-4-20250514',
      CWD,
      abortController.signal,
      thinking,
      githubToken,
    )) {
      if (abortController.signal.aborted) break;

      // Feed content events to accumulator
      if (
        event.type !== 'context' &&
        event.type !== 'compacted' &&
        event.type !== 'slash_commands' &&
        event.type !== 'done'
      ) {
        accumulator.process(event);
      }

      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error('[CHAT] Stream error:', err);
      const errorEvent = {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
      accumulator.process(errorEvent as any);
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    }
  }

  // Save assistant message (works for normal completion AND client disconnect)
  saveAssistantMessage();

  // Notify client of the server-assigned message ID
  if (!abortController.signal.aborted && accumulator.blocks.length > 0) {
    res.write(`data: ${JSON.stringify({ type: 'saved', messageId })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// Vite dev middleware or static serving (production)
const isDev = !fs.existsSync(webDist);
let vite: { middlewares: any; close: () => Promise<void> } | null = null;

async function startServer() {
  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      root: path.join(import.meta.dirname, '..', 'web'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(webDist));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  // WebSocket upgrade routing — noServer mode
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws/pty') {
      if (AUTH_ENABLED && !isAuthenticated(req.headers.cookie)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    // Other upgrade requests (e.g. Vite HMR) — don't handle, let them pass through
  });

  server.listen(PORT, () => {
    console.log(`CloudShell running at http://localhost:${PORT}`);
    if (AUTO_OPEN) {
      import('open').then(({ default: open }) => open(`http://localhost:${PORT}`)).catch(() => {});
    }
  });
}

// Graceful shutdown
async function shutdown() {
  console.log('\nShutting down...');
  killAllSessions();
  await vite?.close();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startServer();
