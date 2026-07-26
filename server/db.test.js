import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendMessage, getMessages, initDatabase } from './db.js';

let dbPath;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // Fine if SQLite did not create this sidecar.
    }
  }
});

describe('feedback variant schema migration', () => {
  it('preserves existing rows while adding new kinds and incorporation provenance', () => {
    dbPath = path.join(os.tmpdir(), `chatbdg-db-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        user_email TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        provider TEXT CHECK (provider IS NULL OR provider IN ('local', 'cloud')),
        sanitized INTEGER NOT NULL DEFAULT 0 CHECK (sanitized IN (0, 1)),
        kind TEXT CHECK (kind IS NULL OR kind IN ('cloud_feedback', 'objections', 'incorporated')),
        status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('pending', 'complete', 'failed')),
        seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        attachment_filename TEXT,
        has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1))
      );
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, seq);
      INSERT INTO conversations VALUES ('conversation-1', 'Legacy', 'owner@example.com', '2026-01-01', '2026-01-01');
      INSERT INTO messages VALUES (
        'legacy-message', 'conversation-1', 'assistant', 'existing objection', 'cloud', 1, 'objections',
        'complete', 1, '2026-01-01', NULL, NULL, NULL, NULL, 0
      );
    `);
    legacy.close();

    process.env.OWNER_EMAIL = 'owner@example.com';
    initDatabase(dbPath);
    expect(getMessages('conversation-1')[0]).toMatchObject({
      id: 'legacy-message',
      kind: 'objections',
      content: 'existing objection'
    });

    appendMessage('conversation-1', 'assistant', 'new incorporated result', {
      provider: 'local',
      kind: 'incorporated',
      feedbackMessageId: 'pros-cons-message',
      feedbackKind: 'pros_cons',
      incorporationMode: 'incorporate'
    });
    expect(getMessages('conversation-1')[1]).toMatchObject({
      feedbackMessageId: 'pros-cons-message',
      feedbackKind: 'pros_cons',
      incorporationMode: 'incorporate'
    });
  });
});
