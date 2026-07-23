import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { ollamaMock, geminiMock, verifyAccessJwtMock } = vi.hoisted(() => ({
  ollamaMock: vi.fn(),
  geminiMock: vi.fn(),
  verifyAccessJwtMock: vi.fn()
}));

vi.mock('./ollamaClient.js', () => ({
  sendChat: (...args) => ollamaMock(...args),
  checkOllamaHealth: async () => 'healthy'
}));

vi.mock('./geminiClient.js', () => ({
  sendChat: (...args) => geminiMock(...args),
  checkGeminiHealth: async () => 'healthy'
}));

// Stands in for real JWKS/signature verification — tests exercise the
// app's own logic (trust the verified claims, reject on failure), not
// jsonwebtoken/jwks-rsa themselves.
vi.mock('./cfAccessAuth.js', () => ({
  verifyAccessJwt: (...args) => verifyAccessJwtMock(...args)
}));

let createApp;
let createConversation;
let dbPath;

beforeEach(async () => {
  vi.resetModules();
  ollamaMock.mockReset();
  geminiMock.mockReset();

  dbPath = path.join(os.tmpdir(), `chatbdg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DATABASE_PATH = dbPath;
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434/v1';
  process.env.OLLAMA_MODEL = 'test-model';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'test-gemini-model';
  process.env.OWNER_EMAIL = 'owner@example.com';
  process.env.CF_ACCESS_TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
  process.env.CF_ACCESS_AUD = 'test-aud-tag';
  delete process.env.DEFAULT_LOCAL_USER_EMAIL;
  // Most tests below aren't exercising auth itself — they send plain requests
  // with no Cf-Access-Jwt-Assertion header and expect to be treated as the
  // owner, mirroring real local development. The fail-closed-by-default
  // describe block further down explicitly deletes this to verify the
  // opposite (and correct-for-production) behavior.
  process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';

  verifyAccessJwtMock.mockReset();
  verifyAccessJwtMock.mockImplementation(async (token) => {
    if (token === 'owner-token') return { email: OWNER };
    if (token === 'titus-token') return { email: OTHER_USER };
    throw new Error('signature verification failed');
  });

  ({ createApp } = await import('./app.js'));
  ({ createConversation } = await import('./db.js'));
});

const OWNER = 'owner@example.com';
const OTHER_USER = 'titusgillihan@gmail.com';

// Simulates a verified Access JWT for the given user — see the
// verifyAccessJwt mock above, which maps these fixed tokens to claims the
// same way real signature verification would map a real signed JWT.
function asUser(req, email) {
  const token = email === OWNER ? 'owner-token' : email === OTHER_USER ? 'titus-token' : 'unrecognized-token';
  return req.set('Cf-Access-Jwt-Assertion', token);
}

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // fine if it never existed
    }
  }
});

describe('/api/sanitize', () => {
  it('only calls the local (Ollama) client, never Gemini', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a local reply');
    const chatRes = await request(app).post('/api/chat').send({ prompt: 'hello there' });
    expect(chatRes.status).toBe(200);

    ollamaMock.mockResolvedValueOnce(
      'Note: names have been replaced with numbered placeholders (Person 1, Person 2, etc.) to protect identities. This is a sanitized version of a real conversation.\n\nPerson 1 asked a generic question.'
    );
    const res = await request(app).post('/api/sanitize').send({ conversationId: chatRes.body.conversationId });

    expect(res.status).toBe(200);
    expect(ollamaMock).toHaveBeenCalledTimes(2);
    expect(geminiMock).not.toHaveBeenCalled();
  });

  it('fails cleanly against a conversation with no messages', async () => {
    const app = createApp();
    const conversationId = createConversation(OWNER);

    const res = await request(app).post('/api/sanitize').send({ conversationId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no messages/);
  });

  it('rejects text over the length limit', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sanitize')
      .send({ text: 'x'.repeat(8001) });
    expect(res.status).toBe(400);
  });
});

describe('/api/chat sanitized cloud sends', () => {
  it('sends Gemini no prior conversation content and not the personal system prompt', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a local reply mentioning SECRET_TOKEN_123');
    const first = await request(app).post('/api/chat').send({ prompt: 'tell me about SECRET_TOKEN_123' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce('a cloud reply');
    const res = await request(app)
      .post('/api/chat')
      .send({ conversationId, prompt: 'a generic sanitized question', provider: 'cloud', sanitized: true });

    expect(res.status).toBe(200);
    expect(geminiMock).toHaveBeenCalledTimes(1);
    const sentMessages = geminiMock.mock.calls[0][0];
    const sentText = JSON.stringify(sentMessages);
    expect(sentText).not.toContain('SECRET_TOKEN_123');
    expect(sentText).not.toContain('Ben Gillihan');
    expect(sentMessages).toHaveLength(2); // system prompt + this one user turn only
  });

  it('treats a string "false" sanitized flag as false, not true', async () => {
    const app = createApp();
    geminiMock.mockResolvedValueOnce('a cloud reply');
    const res = await request(app)
      .post('/api/chat')
      .send({ prompt: 'hello', provider: 'cloud', sanitized: 'false' });

    expect(res.status).toBe(200);
    expect(res.body.sanitized).toBe(false);
  });
});

describe('/api/cloud-feedback', () => {
  it('sends only the given text to Gemini, not conversation history', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a local reply mentioning SECRET_TOKEN_456');
    const first = await request(app).post('/api/chat').send({ prompt: 'about SECRET_TOKEN_456' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce('feedback text');
    const res = await request(app)
      .post('/api/cloud-feedback')
      .send({ conversationId, text: 'Person 1 asked a sanitized question' });

    expect(res.status).toBe(200);
    expect(geminiMock).toHaveBeenCalledTimes(1);
    const sentMessages = geminiMock.mock.calls[0][0];
    const sentText = JSON.stringify(sentMessages);
    expect(sentText).not.toContain('SECRET_TOKEN_456');
    expect(sentText).toContain('Person 1');
  });
});

describe('/api/incorporate', () => {
  it('only calls the local (Ollama) client, never Gemini', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a local reply about REAL_NAME');
    const first = await request(app).post('/api/chat').send({ prompt: 'about REAL_NAME' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce('feedback text');
    const feedbackRes = await request(app)
      .post('/api/cloud-feedback')
      .send({ conversationId, text: 'Person 1 sanitized text' });
    const feedbackMessageId = feedbackRes.body.feedbackMessageId;

    geminiMock.mockClear();
    ollamaMock.mockClear();
    ollamaMock.mockResolvedValueOnce('final answer with REAL_NAME');
    const res = await request(app).post('/api/incorporate').send({ conversationId, feedbackMessageId });

    expect(res.status).toBe(200);
    expect(geminiMock).not.toHaveBeenCalled();
    expect(ollamaMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a feedbackMessageId that does not belong to the conversation', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a reply');
    const first = await request(app).post('/api/chat').send({ prompt: 'hi' });
    const conversationId = first.body.conversationId;

    const res = await request(app).post('/api/incorporate').send({ conversationId, feedbackMessageId: 'not-a-real-id' });
    expect(res.status).toBe(404);
  });
});

describe('provider failure handling', () => {
  it('marks the failed user turn so it is excluded from later context', async () => {
    const app = createApp();
    ollamaMock.mockRejectedValueOnce(new Error('boom'));
    const failRes = await request(app).post('/api/chat').send({ prompt: 'first attempt that fails' });

    expect(failRes.status).toBe(502);
    const conversationId = failRes.body.conversationId;
    expect(conversationId).toBeTruthy();

    ollamaMock.mockResolvedValueOnce('second attempt reply');
    const okRes = await request(app).post('/api/chat').send({ conversationId, prompt: 'second attempt' });

    expect(okRes.status).toBe(200);
    const sentMessages = ollamaMock.mock.calls[1][0];
    expect(JSON.stringify(sentMessages)).not.toContain('first attempt that fails');
  });
});

describe('centralized error handling', () => {
  it('returns a JSON 404 for an unknown /api route instead of the SPA fallback', async () => {
    const app = createApp();
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('multi-user conversation isolation', () => {
  it('GET /api/conversations only returns the requesting user’s own conversations', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValue('a reply');

    await asUser(request(app).post('/api/chat'), OWNER).send({ prompt: 'owner conversation' });
    await asUser(request(app).post('/api/chat'), OTHER_USER).send({ prompt: 'titus conversation' });

    const ownerList = await asUser(request(app).get('/api/conversations'), OWNER);
    expect(ownerList.body).toHaveLength(1);
    expect(ownerList.body[0].title).toMatch(/owner conversation/);

    const otherList = await asUser(request(app).get('/api/conversations'), OTHER_USER);
    expect(otherList.body).toHaveLength(1);
    expect(otherList.body[0].title).toMatch(/titus conversation/);
  });

  it('GET /api/conversations/:id 404s when a different user requests it', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a reply');
    const ownerChat = await asUser(request(app).post('/api/chat'), OWNER).send({ prompt: 'owner-only content' });
    const conversationId = ownerChat.body.conversationId;

    const asOwner = await asUser(request(app).get(`/api/conversations/${conversationId}`), OWNER);
    expect(asOwner.status).toBe(200);

    const asOther = await asUser(request(app).get(`/api/conversations/${conversationId}`), OTHER_USER);
    expect(asOther.status).toBe(404);
  });

  it('/api/chat rejects a conversationId belonging to another user', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a reply');
    const ownerChat = await asUser(request(app).post('/api/chat'), OWNER).send({ prompt: 'owner-only content' });
    const conversationId = ownerChat.body.conversationId;

    const res = await asUser(request(app).post('/api/chat'), OTHER_USER).send({
      conversationId,
      prompt: 'trying to read the owner’s conversation'
    });
    expect(res.status).toBe(404);
  });

  it('gives the owner the personal system prompt and everyone else the shared one', async () => {
    const app = createApp();

    ollamaMock.mockResolvedValueOnce('reply 1');
    await asUser(request(app).post('/api/chat'), OWNER).send({ prompt: 'hello' });
    const ownerMessages = ollamaMock.mock.calls[0][0];
    expect(ownerMessages[0].content).toContain('Ben Gillihan');

    ollamaMock.mockResolvedValueOnce('reply 2');
    await asUser(request(app).post('/api/chat'), OTHER_USER).send({ prompt: 'hello' });
    const otherMessages = ollamaMock.mock.calls[1][0];
    expect(otherMessages[0].content).not.toContain('Ben Gillihan');
    expect(otherMessages[0].content).not.toContain('Elizabeth');
    expect(otherMessages[0].content).not.toContain('American Power Systems');
  });

  it('falls back to OWNER_EMAIL as the local-dev identity when the Access header is absent and ALLOW_INSECURE_LOCAL_AUTH=true', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a reply');
    const res = await request(app).post('/api/chat').send({ prompt: 'no header sent' });
    expect(res.status).toBe(200);

    const list = await request(app).get('/api/conversations');
    expect(list.body).toHaveLength(1);
  });
});

describe('Access token verification', () => {
  it('rejects a request whose Access token fails verification, instead of falling back to a default identity', async () => {
    const app = createApp();
    const res = await request(app).get('/api/conversations').set('Cf-Access-Jwt-Assertion', 'forged-or-expired-token');
    expect(res.status).toBe(401);
    expect(verifyAccessJwtMock).toHaveBeenCalledWith('forged-or-expired-token');
  });

  it('a client cannot impersonate the owner by setting the plaintext email header directly', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce('a reply');

    // Spoof attempt: claim to be the owner via the old plaintext header,
    // with a real verified token proving the requester is actually Titus.
    const res = await request(app)
      .post('/api/chat')
      .set('Cf-Access-Jwt-Assertion', 'titus-token')
      .set('Cf-Access-Authenticated-User-Email', OWNER)
      .send({ prompt: 'hello' });

    expect(res.status).toBe(200);
    const sentMessages = ollamaMock.mock.calls[0][0];
    expect(sentMessages[0].content).not.toContain('Ben Gillihan');
  });

  it('fails closed (401) on a missing Access header when ALLOW_INSECURE_LOCAL_AUTH is not set', async () => {
    delete process.env.ALLOW_INSECURE_LOCAL_AUTH;
    const app = createApp();
    const res = await request(app).get('/api/conversations');
    expect(res.status).toBe(401);
  });

  it('fails closed (401) on a missing Access header when ALLOW_INSECURE_LOCAL_AUTH is set to anything other than "true"', async () => {
    process.env.ALLOW_INSECURE_LOCAL_AUTH = 'false';
    const app = createApp();
    const res = await request(app).get('/api/conversations');
    expect(res.status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('keys the limiter by verified user identity, not IP, so one user hitting the limit does not block another', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValue('a reply');

    // Exhaust OWNER's 60-request window (all requests in this test share the
    // same client IP, since supertest talks to an in-process app — this is
    // exactly the scenario a shared Cloudflare tunnel connection produces in
    // production, which is what an IP-based key would get wrong).
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => asUser(request(app).post('/api/chat'), OWNER).send({ prompt: `msg ${i}` }))
    );

    const blocked = await asUser(request(app).post('/api/chat'), OWNER).send({ prompt: 'one too many' });
    expect(blocked.status).toBe(429);

    const otherUserRes = await asUser(request(app).post('/api/chat'), OTHER_USER).send({ prompt: 'hello from titus' });
    expect(otherUserRes.status).toBe(200);
  }, 20000);
});
