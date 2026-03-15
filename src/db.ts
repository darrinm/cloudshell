/**
 * SQLite persistence layer for CloudShell chat conversations and tabs.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let db: Database.Database;

export function getDb(cwd: string): Database.Database {
  if (db) return db;

  const dataDir = path.join(cwd, '.cloudshell');
  fs.mkdirSync(dataDir, { recursive: true });

  db = new Database(path.join(dataDir, 'data.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      model TEXT,
      thinking_enabled INTEGER DEFAULT 0,
      thinking_budget INTEGER DEFAULT 10000,
      thinking_effort TEXT DEFAULT 'high',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      blocks TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON chat_messages(conversation_id, timestamp);

    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('terminal', 'code', 'agent')),
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tabs_user ON tabs(user_id, sort_order);

    CREATE TABLE IF NOT EXISTS tab_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migrate: rename 'work' tab type to 'agent'
  db.exec("UPDATE tabs SET type = 'agent' WHERE type = 'work'");

  // Migrate: add user_id column to conversations if missing
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'user_id')) {
    db.exec("ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'");
  }

  return db;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  model: string | null;
  thinking_enabled: number;
  thinking_budget: number;
  thinking_effort: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  blocks: string; // JSON
  timestamp: string;
}

export interface TabRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Tab CRUD
// ---------------------------------------------------------------------------

function getNextTabId(d: Database.Database): number {
  const row = d.prepare("SELECT value FROM tab_meta WHERE key = 'next_id'").get() as
    | { value: string }
    | undefined;
  if (row) return parseInt(row.value, 10);

  // Seed from highest existing tab-N conversation id
  const maxRow = d
    .prepare(
      "SELECT id FROM conversations WHERE id LIKE 'tab-%' ORDER BY CAST(SUBSTR(id, 5) AS INTEGER) DESC LIMIT 1",
    )
    .get() as { id: string } | undefined;
  let nextId = 1;
  if (maxRow) {
    const num = parseInt(maxRow.id.replace('tab-', ''), 10);
    if (!isNaN(num)) nextId = num + 1;
  }

  d.prepare("INSERT OR REPLACE INTO tab_meta (key, value) VALUES ('next_id', ?)").run(
    String(nextId),
  );
  return nextId;
}

function bumpNextTabId(d: Database.Database, current: number): void {
  d.prepare("INSERT OR REPLACE INTO tab_meta (key, value) VALUES ('next_id', ?)").run(
    String(current + 1),
  );
}

export function getTabs(cwd: string, userId: string): TabRow[] {
  return getDb(cwd)
    .prepare('SELECT * FROM tabs WHERE user_id = ? ORDER BY sort_order ASC')
    .all(userId) as TabRow[];
}

export function createTab(
  cwd: string,
  userId: string,
  opts: { type: string; title?: string },
): TabRow {
  const d = getDb(cwd);
  const nextId = getNextTabId(d);
  const id = `tab-${nextId}`;
  bumpNextTabId(d, nextId);

  const titles: Record<string, string> = { terminal: 'Shell', code: 'Claude', agent: 'Agent' };
  const prefix = titles[opts.type] || opts.type;
  let title = opts.title;
  if (!title) {
    const existing = (
      d.prepare('SELECT title FROM tabs WHERE user_id = ? AND type = ?').all(userId, opts.type) as {
        title: string;
      }[]
    ).map((r) => r.title);
    const usedNums = new Set(
      existing
        .map((t) => {
          const m = t.match(new RegExp(`^${prefix} (\\d+)$`));
          return m ? parseInt(m[1], 10) : 0;
        })
        .filter((n) => n > 0),
    );
    let n = 1;
    while (usedNums.has(n)) n++;
    title = `${prefix} ${n}`;
  }

  // sort_order = max + 1 for this user
  const maxOrder = d
    .prepare('SELECT MAX(sort_order) as m FROM tabs WHERE user_id = ?')
    .get(userId) as { m: number | null };
  const sortOrder = (maxOrder.m ?? -1) + 1;

  const now = new Date().toISOString();
  d.prepare(
    'INSERT INTO tabs (id, user_id, type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, opts.type, title, sortOrder, now, now);

  return {
    id,
    user_id: userId,
    type: opts.type,
    title,
    sort_order: sortOrder,
    created_at: now,
    updated_at: now,
  };
}

export function deleteTab(cwd: string, userId: string, id: string): void {
  getDb(cwd).prepare('DELETE FROM tabs WHERE id = ? AND user_id = ?').run(id, userId);
}

export function updateTab(
  cwd: string,
  userId: string,
  id: string,
  fields: { title?: string },
): void {
  if (!fields.title) return;
  const now = new Date().toISOString();
  getDb(cwd)
    .prepare('UPDATE tabs SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(fields.title, now, id, userId);
}

export function reorderTabs(cwd: string, userId: string, orderedIds: string[]): void {
  const d = getDb(cwd);
  const stmt = d.prepare(
    'UPDATE tabs SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  );
  const now = new Date().toISOString();
  const run = d.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      stmt.run(i, now, orderedIds[i], userId);
    }
  });
  run();
}

// ---------------------------------------------------------------------------
// Conversation CRUD (user-scoped)
// ---------------------------------------------------------------------------

export function createConversation(
  cwd: string,
  id: string,
  title: string,
  userId: string = 'default',
  settings?: {
    model?: string;
    thinkingEnabled?: boolean;
    thinkingBudget?: number;
    thinkingEffort?: string;
  },
): void {
  const d = getDb(cwd);
  const now = new Date().toISOString();
  d.prepare(
    `
    INSERT OR IGNORE INTO conversations (id, user_id, title, model, thinking_enabled, thinking_budget, thinking_effort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    userId,
    title,
    settings?.model ?? null,
    settings?.thinkingEnabled ? 1 : 0,
    settings?.thinkingBudget ?? 10000,
    settings?.thinkingEffort ?? 'high',
    now,
    now,
  );
}

export function deleteConversation(cwd: string, id: string, userId?: string): void {
  if (userId) {
    getDb(cwd).prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId);
  } else {
    getDb(cwd).prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }
}

export function getConversation(
  cwd: string,
  id: string,
  userId?: string,
): ConversationRow | undefined {
  if (userId) {
    return getDb(cwd)
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(id, userId) as ConversationRow | undefined;
  }
  return getDb(cwd).prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
    | ConversationRow
    | undefined;
}

export function updateConversation(
  cwd: string,
  id: string,
  fields: Partial<
    Pick<
      ConversationRow,
      'title' | 'model' | 'thinking_enabled' | 'thinking_budget' | 'thinking_effort'
    >
  >,
  userId?: string,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  if (userId) {
    values.push(userId);
    getDb(cwd)
      .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...values);
  } else {
    getDb(cwd)
      .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }
}

export function saveMessage(
  cwd: string,
  msg: { id: string; conversationId: string; role: string; blocks: string; timestamp: string },
): void {
  getDb(cwd)
    .prepare(
      `
    INSERT OR REPLACE INTO chat_messages (id, conversation_id, role, blocks, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(msg.id, msg.conversationId, msg.role, msg.blocks, msg.timestamp);
}

export function getMessages(cwd: string, conversationId: string): MessageRow[] {
  return getDb(cwd)
    .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY timestamp ASC')
    .all(conversationId) as MessageRow[];
}

export function deleteMessages(cwd: string, conversationId: string): void {
  getDb(cwd).prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(conversationId);
}
