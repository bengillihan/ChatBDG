import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

let db;

export function initDatabase(path) {
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  `);

  return db;
}

export function checkDatabaseHealth() {
  try {
    db.prepare('SELECT 1').get();
    return 'healthy';
  } catch {
    return 'unhealthy';
  }
}

export function createConversation() {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)').run(id, now, now);
  return id;
}

export function conversationExists(id) {
  return Boolean(db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id));
}

export function listConversations() {
  return db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100')
    .all();
}

export function getMessages(conversationId) {
  return db
    .prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId);
}

export function appendMessage(conversationId, role, content) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    conversationId,
    role,
    content,
    now
  );

  const conversation = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId);
  const title = conversation?.title || (role === 'user' ? content.slice(0, 60) : null);
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, conversationId);

  return { id, createdAt: now };
}
