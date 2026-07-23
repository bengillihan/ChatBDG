import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

let db;

export function initDatabase(path) {
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      user_email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      provider TEXT CHECK (provider IS NULL OR provider IN ('local', 'cloud')),
      sanitized INTEGER NOT NULL DEFAULT 0 CHECK (sanitized IN (0, 1)),
      kind TEXT CHECK (kind IS NULL OR kind IN ('cloud_feedback', 'incorporated')),
      status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('pending', 'complete', 'failed')),
      seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, seq);
  `);

  // Guarded migrations for databases created before a given column existed —
  // on a brand-new database these are no-ops since CREATE TABLE above already
  // defines every column (with CHECK constraints, which ALTER TABLE ADD
  // COLUMN can't retroactively add to a pre-existing column).
  for (const [name, ddl] of [
    ['provider', 'ALTER TABLE messages ADD COLUMN provider TEXT'],
    ['sanitized', 'ALTER TABLE messages ADD COLUMN sanitized INTEGER NOT NULL DEFAULT 0'],
    ['kind', 'ALTER TABLE messages ADD COLUMN kind TEXT'],
    ['status', "ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'"],
    ['seq', 'ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0']
  ]) {
    const hasColumn = db.prepare(`SELECT 1 FROM pragma_table_info('messages') WHERE name = ?`).get(name);
    if (!hasColumn) {
      db.exec(ddl);
    }
  }

  const hasUserEmailColumn = db
    .prepare("SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'user_email'")
    .get();
  if (!hasUserEmailColumn) {
    db.exec("ALTER TABLE conversations ADD COLUMN user_email TEXT NOT NULL DEFAULT ''");
  }

  // Conversations created before per-user scoping existed have no owner on
  // record — attribute them to the configured owner rather than leaving them
  // unreachable by anyone (idempotent: no-op once every row has an owner).
  if (process.env.OWNER_EMAIL) {
    db.prepare("UPDATE conversations SET user_email = ? WHERE user_email = ''").run(process.env.OWNER_EMAIL);
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_email ON conversations(user_email)');

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

export function createConversation(userEmail) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO conversations (id, title, user_email, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)').run(
    id,
    userEmail,
    now,
    now
  );
  return id;
}

// Returns the owning user's email, or null if the conversation doesn't
// exist — callers compare this against the requesting user rather than
// using a separate existence check, so "not found" and "not yours" collapse
// into the same response and never confirm another user's ID is real.
export function getConversationOwner(id) {
  const row = db.prepare('SELECT user_email FROM conversations WHERE id = ?').get(id);
  return row ? row.user_email : null;
}

export function userOwnsConversation(id, userEmail) {
  return getConversationOwner(id) === userEmail;
}

export function listConversations(userEmail) {
  return db
    .prepare(
      'SELECT id, title, created_at, updated_at FROM conversations WHERE user_email = ? ORDER BY updated_at DESC LIMIT 100'
    )
    .all(userEmail);
}

export function getMessages(conversationId) {
  return db
    .prepare(
      'SELECT id, role, content, provider, sanitized, kind, status, created_at FROM messages WHERE conversation_id = ? ORDER BY seq ASC'
    )
    .all(conversationId)
    .map((m) => ({ ...m, sanitized: Boolean(m.sanitized) }));
}

export function getMessageById(id) {
  const row = db
    .prepare('SELECT id, conversation_id, role, content, provider, sanitized, kind, status, created_at FROM messages WHERE id = ?')
    .get(id);
  if (!row) return null;
  return { ...row, sanitized: Boolean(row.sanitized) };
}

export function updateMessageStatus(id, status) {
  db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
}

// DatabaseSync is synchronous and single-writer, so computing the next `seq`
// and inserting within the same BEGIN/COMMIT is race-free even without a
// dedicated sequence table — there's no async gap another call could land in.
export function appendMessage(conversationId, role, content, provider = null, sanitized = false, kind = null, status = 'complete') {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    const { seq } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?')
      .get(conversationId);

    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, provider, sanitized, kind, status, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, conversationId, role, content, provider, sanitized ? 1 : 0, kind, status, seq, now);

    const conversation = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId);
    const title = conversation?.title || (role === 'user' ? content.slice(0, 60) : null);
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, conversationId);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { id, createdAt: now };
}
