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
      created_at TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      attachment_filename TEXT,
      has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1))
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
    ['seq', 'ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0'],
    ['prompt_tokens', 'ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER'],
    ['completion_tokens', 'ALTER TABLE messages ADD COLUMN completion_tokens INTEGER'],
    ['total_tokens', 'ALTER TABLE messages ADD COLUMN total_tokens INTEGER'],
    ['attachment_filename', 'ALTER TABLE messages ADD COLUMN attachment_filename TEXT'],
    ['has_attachment', 'ALTER TABLE messages ADD COLUMN has_attachment INTEGER NOT NULL DEFAULT 0']
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

const MESSAGE_COLUMNS = `id, conversation_id, role, content, provider, sanitized, kind, status, created_at,
       prompt_tokens, completion_tokens, total_tokens, attachment_filename, has_attachment`;

// Token usage is only meaningful once a provider actually reports it — a row
// with all three counts NULL (e.g. a user turn, or a provider that didn't
// return usage) surfaces as usage: null rather than a block of zeros.
function formatMessageRow(row) {
  const hasUsage = row.prompt_tokens != null || row.completion_tokens != null || row.total_tokens != null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    provider: row.provider,
    sanitized: Boolean(row.sanitized),
    kind: row.kind,
    status: row.status,
    created_at: row.created_at,
    usage: hasUsage
      ? { promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, totalTokens: row.total_tokens }
      : null,
    hasAttachment: Boolean(row.has_attachment),
    attachmentFilename: row.attachment_filename
  };
}

export function getMessages(conversationId) {
  return db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? ORDER BY seq ASC`)
    .all(conversationId)
    .map(formatMessageRow);
}

export function getMessageById(id) {
  const row = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id);
  if (!row) return null;
  return formatMessageRow(row);
}

export function updateMessageStatus(id, status) {
  db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
}

// DatabaseSync is synchronous and single-writer, so computing the next `seq`
// and inserting within the same BEGIN/COMMIT is race-free even without a
// dedicated sequence table — there's no async gap another call could land in.
export function appendMessage(conversationId, role, content, options = {}) {
  const { provider = null, sanitized = false, kind = null, status = 'complete', usage = null, attachment = null } = options;
  const id = randomUUID();
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    const { seq } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?')
      .get(conversationId);

    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, provider, sanitized, kind, status, seq, created_at,
                              prompt_tokens, completion_tokens, total_tokens, attachment_filename, has_attachment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      conversationId,
      role,
      content,
      provider,
      sanitized ? 1 : 0,
      kind,
      status,
      seq,
      now,
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.totalTokens ?? null,
      attachment?.filename ?? null,
      attachment ? 1 : 0
    );

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
