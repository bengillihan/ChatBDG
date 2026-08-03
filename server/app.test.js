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
    ollamaMock.mockResolvedValueOnce({ text: 'a local reply', usage: null });
    const chatRes = await request(app).post('/api/chat').send({ prompt: 'hello there' });
    expect(chatRes.status).toBe(200);

    ollamaMock.mockResolvedValueOnce({
      text: 'Note: names have been replaced with numbered placeholders (Person 1, Person 2, etc.) to protect identities. This is a sanitized version of a real conversation.\n\nPerson 1 asked a generic question.',
      usage: null
    });
    const res = await request(app).post('/api/sanitize').send({ conversationId: chatRes.body.conversationId });

    expect(res.status).toBe(200);
    expect(ollamaMock).toHaveBeenCalledTimes(2);
    expect(geminiMock).not.toHaveBeenCalled();
  });

  it('locally removes names and email addresses missed by the model before returning the preview', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({
      text: 'Note: this is sanitized. Miriam Solace can email miriam@example.org.',
      usage: null
    });

    const res = await request(app).post('/api/sanitize').send({
      text: 'From: Miriam Solace <miriam@example.org>\nPlease advise Miriam.'
    });

    expect(res.status).toBe(200);
    expect(res.body.sanitized).not.toMatch(/Miriam|Solace|miriam@example\.org/i);
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
    ollamaMock.mockResolvedValueOnce({ text: 'a local reply mentioning SECRET_TOKEN_123', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'tell me about SECRET_TOKEN_123' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce({ text: 'a cloud reply', usage: null });
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

  it('redacts names reintroduced into a reviewed draft before calling Gemini', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'local reply', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'Help Miriam Solace prepare a response.' });

    geminiMock.mockResolvedValueOnce({ text: 'cloud reply', usage: null });
    const res = await request(app)
      .post('/api/chat')
      .send({
        conversationId: first.body.conversationId,
        prompt: 'Miriam Solace should respond carefully.',
        provider: 'cloud',
        sanitized: true
      });

    expect(res.status).toBe(200);
    const sentText = JSON.stringify(geminiMock.mock.calls[0][0]);
    expect(sentText).not.toContain('Miriam');
    expect(sentText).not.toContain('Solace');
  });

  it('treats a string "false" sanitized flag as false, not true', async () => {
    const app = createApp();
    geminiMock.mockResolvedValueOnce({ text: 'a cloud reply', usage: null });
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
    ollamaMock.mockResolvedValueOnce({ text: 'a local reply mentioning SECRET_TOKEN_456', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'about SECRET_TOKEN_456' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce({ text: 'feedback text', usage: null });
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

  it('redacts names and email addresses at the cloud boundary', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'local reply', usage: null });
    const first = await request(app).post('/api/chat').send({
      prompt: 'From: Miriam Solace <miriam@example.org>\nMiriam asked Jonah Vale for advice.'
    });

    geminiMock.mockResolvedValueOnce({ text: 'feedback', usage: null });
    const res = await request(app).post('/api/cloud-feedback').send({
      conversationId: first.body.conversationId,
      text: 'Miriam asked Jonah Vale to email miriam@example.org.'
    });

    expect(res.status).toBe(200);
    const sentText = JSON.stringify(geminiMock.mock.calls[0][0]);
    for (const secret of ['Miriam', 'Jonah', 'Vale', 'miriam@example.org']) expect(sentText).not.toContain(secret);
  });
});

describe('/api/objections', () => {
  it('sends only the given text to Gemini, not conversation history, and tags the reply "objections"', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a local reply mentioning SECRET_TOKEN_789', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'about SECRET_TOKEN_789' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce({ text: '1. First objection\n2. Second objection', usage: null });
    const res = await request(app)
      .post('/api/objections')
      .send({ conversationId, text: 'Person 1 asked a sanitized question' });

    expect(res.status).toBe(200);
    expect(res.body.objections).toBe('1. First objection\n2. Second objection');
    expect(geminiMock).toHaveBeenCalledTimes(1);
    const sentMessages = geminiMock.mock.calls[0][0];
    const sentText = JSON.stringify(sentMessages);
    expect(sentText).not.toContain('SECRET_TOKEN_789');
    expect(sentText).toContain('Person 1');

    const history = await request(app).get(`/api/conversations/${conversationId}`);
    const objectionsMessage = history.body.find((m) => m.kind === 'objections');
    expect(objectionsMessage).toBeTruthy();
    expect(objectionsMessage.provider).toBe('cloud');
    expect(objectionsMessage.sanitized).toBe(true);
  });
});

describe('purpose-built cloud feedback variants', () => {
  it('uses four distinct Gemini prompts, isolates real history, and persists a distinct kind for each response', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'local reply mentioning FABRICATED_REAL_NAME', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'about FABRICATED_REAL_NAME' });
    const conversationId = first.body.conversationId;
    const variants = [
      { path: '/api/cloud-feedback', field: 'feedback', kind: 'cloud_feedback', reply: 'open-ended analysis' },
      { path: '/api/pros-cons', field: 'prosCons', kind: 'pros_cons', reply: 'Pros: clear. Cons: thin.' },
      { path: '/api/objections', field: 'objections', kind: 'objections', reply: '1. A counterargument' },
      { path: '/api/improvements', field: 'improvements', kind: 'improvements', reply: '1. Add a concrete example' }
    ];

    for (const variant of variants) {
      geminiMock.mockResolvedValueOnce({ text: variant.reply, usage: null });
      const res = await request(app)
        .post(variant.path)
        .send({ conversationId, text: 'Person 1 recommends a measured transition for Person 2.' });
      expect(res.status).toBe(200);
      expect(res.body[variant.field]).toBe(variant.reply);
      expect(res.body.feedbackMessageId).toBeTruthy();
    }

    const promptTexts = geminiMock.mock.calls.map(([messages]) => messages[0].content);
    expect(new Set(promptTexts).size).toBe(4);
    expect(promptTexts.join('\n')).not.toContain('FABRICATED_REAL_NAME');
    expect(promptTexts[1]).toMatch(/balanced assessment/i);
    expect(promptTexts[2]).toMatch(/stress-test/i);
    expect(promptTexts[3]).toMatch(/actionable improvement/i);

    for (const [messages] of geminiMock.mock.calls) {
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toContain('Person 1');
      expect(JSON.stringify(messages)).not.toContain('FABRICATED_REAL_NAME');
    }

    const history = await request(app).get(`/api/conversations/${conversationId}`);
    expect(
      history.body.filter((message) => message.role === 'assistant' && message.provider === 'cloud').map((message) => message.kind)
    ).toEqual(variants.map((variant) => variant.kind));
  });
});

describe('/api/incorporate', () => {
  it('only calls the local (Ollama) client, never Gemini', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a local reply about REAL_NAME', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'about REAL_NAME' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce({ text: 'feedback text', usage: null });
    const feedbackRes = await request(app)
      .post('/api/cloud-feedback')
      .send({ conversationId, text: 'Person 1 sanitized text' });
    const feedbackMessageId = feedbackRes.body.feedbackMessageId;

    geminiMock.mockClear();
    ollamaMock.mockClear();
    ollamaMock.mockResolvedValueOnce({ text: 'final answer with REAL_NAME', usage: null });
    const res = await request(app).post('/api/incorporate').send({ conversationId, feedbackMessageId });

    expect(res.status).toBe(200);
    expect(geminiMock).not.toHaveBeenCalled();
    expect(ollamaMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a feedbackMessageId pointing at an objections reply, not just cloud_feedback', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a local reply about REAL_NAME', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'about REAL_NAME' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce({ text: '1. An objection', usage: null });
    const objectionsRes = await request(app)
      .post('/api/objections')
      .send({ conversationId, text: 'Person 1 sanitized text' });
    const feedbackMessageId = objectionsRes.body.feedbackMessageId;

    ollamaMock.mockResolvedValueOnce({ text: 'final answer addressing the objection, with REAL_NAME', usage: null });
    const res = await request(app).post('/api/incorporate').send({ conversationId, feedbackMessageId });

    expect(res.status).toBe(200);
    const sentMessages = ollamaMock.mock.calls[ollamaMock.mock.calls.length - 1][0];
    const sentText = JSON.stringify(sentMessages);
    expect(sentText).toContain('REAL_NAME');
    expect(sentText).toContain('An objection');
  });

  it('uses the local model and restores real-name context after every feedback variant', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'Initial advice for Miriam Solace and Jonah Vale', usage: null });
    const first = await request(app)
      .post('/api/chat')
      .send({ prompt: 'Help Miriam Solace prepare a recommendation for Jonah Vale.' });
    const conversationId = first.body.conversationId;
    const variants = [
      { path: '/api/cloud-feedback', kind: 'cloud_feedback', reply: 'General feedback about Person 1 and Person 2' },
      { path: '/api/pros-cons', kind: 'pros_cons', reply: 'Pros and cons for Person 1 and Person 2' },
      { path: '/api/objections', kind: 'objections', reply: 'Objections concerning Person 1 and Person 2' },
      { path: '/api/improvements', kind: 'improvements', reply: 'Improvements for Person 1 and Person 2' }
    ];

    for (const variant of variants) {
      geminiMock.mockResolvedValueOnce({ text: variant.reply, usage: null });
      const feedback = await request(app)
        .post(variant.path)
        .send({ conversationId, text: 'Person 1 is preparing a recommendation for Person 2.' });

      geminiMock.mockClear();
      ollamaMock.mockClear();
      ollamaMock.mockResolvedValueOnce({
        text: `Final recommendation naming Miriam Solace and Jonah Vale after ${variant.kind}`,
        usage: null
      });
      const incorporated = await request(app)
        .post('/api/incorporate')
        .send({ conversationId, feedbackMessageId: feedback.body.feedbackMessageId, mode: 'incorporate' });

      expect(incorporated.status).toBe(200);
      expect(incorporated.body.feedbackKind).toBe(variant.kind);
      expect(incorporated.body.incorporationMode).toBe('incorporate');
      expect(geminiMock).not.toHaveBeenCalled();
      expect(ollamaMock).toHaveBeenCalledTimes(1);
      const sentText = JSON.stringify(ollamaMock.mock.calls[0][0]);
      expect(sentText).toContain('Miriam Solace');
      expect(sentText).toContain('Jonah Vale');
      expect(sentText).toContain(variant.reply);
    }

    const history = await request(app).get(`/api/conversations/${conversationId}`);
    const incorporatedMessages = history.body.filter((message) => message.kind === 'incorporated');
    expect(incorporatedMessages).toHaveLength(4);
    expect(incorporatedMessages.map((message) => message.feedbackKind)).toEqual(variants.map((variant) => variant.kind));
    expect(incorporatedMessages.every((message) => message.incorporationMode === 'incorporate')).toBe(true);
    expect(incorporatedMessages.every((message) => Boolean(message.feedbackMessageId))).toBe(true);
  });

  it('supports Organize Feedback as a distinct local mode and records its provenance', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'Initial answer about Miriam Solace', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'Advise Miriam Solace.' });
    const conversationId = first.body.conversationId;

    geminiMock.mockResolvedValueOnce({ text: 'Pros and cons about Person 1', usage: null });
    const feedback = await request(app)
      .post('/api/pros-cons')
      .send({ conversationId, text: 'Person 1 is considering a change.' });

    geminiMock.mockClear();
    ollamaMock.mockClear();
    ollamaMock.mockResolvedValueOnce({ text: 'Adopt / Consider / Reject for Miriam Solace', usage: null });
    const organized = await request(app)
      .post('/api/incorporate')
      .send({ conversationId, feedbackMessageId: feedback.body.feedbackMessageId, mode: 'organize' });

    expect(organized.status).toBe(200);
    expect(organized.body.incorporationMode).toBe('organize');
    expect(organized.body.feedbackKind).toBe('pros_cons');
    expect(geminiMock).not.toHaveBeenCalled();
    const sentMessages = ollamaMock.mock.calls[0][0];
    expect(sentMessages[0].content).toMatch(/Adopt.*Consider.*Reject/s);
    expect(JSON.stringify(sentMessages)).toContain('Miriam Solace');

    const history = await request(app).get(`/api/conversations/${conversationId}`);
    const organizedMessage = history.body.find(
      (message) => message.kind === 'incorporated' && message.incorporationMode === 'organize'
    );
    expect(organizedMessage.feedbackMessageId).toBe(feedback.body.feedbackMessageId);
    expect(organizedMessage.feedbackKind).toBe('pros_cons');
  });

  it('rejects an unknown incorporation mode', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'initial reply', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'hello' });
    const res = await request(app)
      .post('/api/incorporate')
      .send({ conversationId: first.body.conversationId, feedbackMessageId: 'anything', mode: 'unknown' });
    expect(res.status).toBe(400);
  });

  it('rejects a feedbackMessageId that does not belong to the conversation', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a reply', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'hi' });
    const conversationId = first.body.conversationId;

    const res = await request(app).post('/api/incorporate').send({ conversationId, feedbackMessageId: 'not-a-real-id' });
    expect(res.status).toBe(404);
  });

  it('rejects a feedbackMessageId pointing at a message that is not a recognized feedback variant', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a plain local reply', usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: 'hi' });
    const conversationId = first.body.conversationId;

    const history = await request(app).get(`/api/conversations/${conversationId}`);
    const plainMessageId = history.body.find((m) => m.role === 'assistant').id;

    const res = await request(app).post('/api/incorporate').send({ conversationId, feedbackMessageId: plainMessageId });
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

    ollamaMock.mockResolvedValueOnce({ text: 'second attempt reply', usage: null });
    const okRes = await request(app).post('/api/chat').send({ conversationId, prompt: 'second attempt' });

    expect(okRes.status).toBe(200);
    const sentMessages = ollamaMock.mock.calls[1][0];
    expect(JSON.stringify(sentMessages)).not.toContain('first attempt that fails');
  });
});

describe('/api/chat conversation continuity', () => {
  it('sends every completed prior turn to Ollama unchanged and instructs it to handle revisions incrementally', async () => {
    const app = createApp();
    const originalDraft = `ORIGINAL_DRAFT_START\n${'original communion draft paragraph '.repeat(210)}\nNot earned — given\nORIGINAL_DRAFT_END`;
    const firstFeedback = `FIRST_FEEDBACK_START\n${'specific feedback on the original draft '.repeat(130)}\nFIRST_FEEDBACK_END`;
    const revisedDraft = `REVISED_DRAFT_START\n${'original communion draft paragraph '.repeat(210)}\nNot earned — traded\nREVISED_DRAFT_END`;

    ollamaMock.mockResolvedValueOnce({ text: firstFeedback, usage: null });
    const first = await request(app).post('/api/chat').send({ prompt: originalDraft });
    expect(first.status).toBe(200);

    ollamaMock.mockResolvedValueOnce({ text: 'targeted revision feedback', usage: null });
    const second = await request(app)
      .post('/api/chat')
      .send({ conversationId: first.body.conversationId, prompt: revisedDraft });
    expect(second.status).toBe(200);

    const sentMessages = ollamaMock.mock.calls[1][0];
    expect(sentMessages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('explicitly acknowledge it as a revision')
      }),
      { role: 'user', content: originalDraft },
      { role: 'assistant', content: firstFeedback },
      { role: 'user', content: revisedDraft }
    ]);
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
    ollamaMock.mockResolvedValue({ text: 'a reply', usage: null });

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
    ollamaMock.mockResolvedValueOnce({ text: 'a reply', usage: null });
    const ownerChat = await asUser(request(app).post('/api/chat'), OWNER).send({ prompt: 'owner-only content' });
    const conversationId = ownerChat.body.conversationId;

    const asOwner = await asUser(request(app).get(`/api/conversations/${conversationId}`), OWNER);
    expect(asOwner.status).toBe(200);

    const asOther = await asUser(request(app).get(`/api/conversations/${conversationId}`), OTHER_USER);
    expect(asOther.status).toBe(404);
  });

  it('/api/chat rejects a conversationId belonging to another user', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a reply', usage: null });
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

    ollamaMock.mockResolvedValueOnce({ text: 'reply 1', usage: null });
    await asUser(request(app).post('/api/chat'), OWNER).send({ prompt: 'hello' });
    const ownerMessages = ollamaMock.mock.calls[0][0];
    expect(ownerMessages[0].content).toContain('Ben Gillihan');

    ollamaMock.mockResolvedValueOnce({ text: 'reply 2', usage: null });
    await asUser(request(app).post('/api/chat'), OTHER_USER).send({ prompt: 'hello' });
    const otherMessages = ollamaMock.mock.calls[1][0];
    expect(otherMessages[0].content).not.toContain('Ben Gillihan');
    expect(otherMessages[0].content).not.toContain('Elizabeth');
    expect(otherMessages[0].content).not.toContain('American Power Systems');
  });

  it('falls back to OWNER_EMAIL as the local-dev identity when the Access header is absent and ALLOW_INSECURE_LOCAL_AUTH=true', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a reply', usage: null });
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
    ollamaMock.mockResolvedValueOnce({ text: 'a reply', usage: null });

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

describe('file attachments', () => {
  it('extracts and attaches text from a plain-text file to a local send, and reports usage/timestamps', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({
      text: 'a reply about the notes',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    });

    const res = await request(app)
      .post('/api/chat')
      .field('prompt', 'please review my notes')
      .attach('file', Buffer.from('SECRET_PERSON details go here'), 'notes.txt');

    expect(res.status).toBe(200);
    expect(res.body.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(res.body.requestedAt).toBeTruthy();
    expect(res.body.respondedAt).toBeTruthy();

    const sentMessages = ollamaMock.mock.calls[0][0];
    const lastTurn = sentMessages[sentMessages.length - 1];
    expect(lastTurn.content).toContain('[Attached file: notes.txt]');
    expect(lastTurn.content).toContain('SECRET_PERSON details go here');

    const history = await request(app).get(`/api/conversations/${res.body.conversationId}`);
    const userTurn = history.body.find((m) => m.role === 'user');
    expect(userTurn.hasAttachment).toBe(true);
    expect(userTurn.attachmentFilename).toBe('notes.txt');

    const assistantTurn = history.body.find((m) => m.role === 'assistant');
    expect(assistantTurn.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('rejects a disallowed file extension', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/chat')
      .field('prompt', 'hi')
      .attach('file', Buffer.from('binary junk'), 'malware.exe');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported file type/);
    expect(ollamaMock).not.toHaveBeenCalled();
  });

  it('rejects a file over the size limit', async () => {
    const app = createApp();
    const oversized = Buffer.alloc(11 * 1024 * 1024, 'a');
    const res = await request(app)
      .post('/api/chat')
      .field('prompt', 'hi')
      .attach('file', oversized, 'big.txt');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceed/);
  }, 20000);

  it('rejects sending a file attachment directly to the cloud provider', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/chat')
      .field('prompt', 'hi')
      .field('provider', 'cloud')
      .attach('file', Buffer.from('some content'), 'notes.txt');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be sent to the cloud provider directly/);
    expect(geminiMock).not.toHaveBeenCalled();
  });

  it('rejects a raw cloud send once the conversation history contains an unsanitized attachment', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a reply about the notes', usage: null });

    const first = await request(app)
      .post('/api/chat')
      .field('prompt', 'please review my notes')
      .attach('file', Buffer.from('SECRET_PERSON details'), 'notes.txt');
    const conversationId = first.body.conversationId;

    const res = await request(app)
      .post('/api/chat')
      .send({ conversationId, prompt: 'now send this to the cloud', provider: 'cloud' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/has not been sanitized/);
    expect(geminiMock).not.toHaveBeenCalled();
  });

  it('folds attached-file content into what /api/sanitize sends to the local model for genericization', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValueOnce({ text: 'a reply about the notes', usage: null });

    const first = await request(app)
      .post('/api/chat')
      .field('prompt', 'please review my notes about REAL_NAME_IN_FILE')
      .attach('file', Buffer.from('REAL_NAME_IN_FILE lives at 123 Main St'), 'notes.txt');
    const conversationId = first.body.conversationId;

    ollamaMock.mockResolvedValueOnce({
      text: 'Note: names have been replaced with numbered placeholders (Person 1, Person 2, etc.) to protect identities. This is a sanitized version of a real conversation.\n\nPerson 1 asked about attached notes.',
      usage: null
    });
    const res = await request(app).post('/api/sanitize').send({ conversationId });

    expect(res.status).toBe(200);
    const sourceTextSent = ollamaMock.mock.calls[1][0][1].content;
    expect(sourceTextSent).toContain('[Attached file: notes.txt]');
    expect(sourceTextSent).toContain('REAL_NAME_IN_FILE lives at 123 Main St');
  });
});

describe('rate limiting', () => {
  it('keys the limiter by verified user identity, not IP, so one user hitting the limit does not block another', async () => {
    const app = createApp();
    ollamaMock.mockResolvedValue({ text: 'a reply', usage: null });

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
