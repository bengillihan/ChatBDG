// The Express app, separated from index.js's app.listen() call so tests can
// import and exercise it directly via supertest without binding a real port.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { validateConfig } from './config.js';
import {
  initDatabase,
  checkDatabaseHealth,
  createConversation,
  userOwnsConversation,
  listConversations,
  getMessages,
  getMessageById,
  appendMessage,
  updateMessageStatus
} from './db.js';
import { sendChat as sendOllamaChat, checkOllamaHealth } from './ollamaClient.js';
import { sendChat as sendGeminiChat, checkGeminiHealth } from './geminiClient.js';
import { DEFAULT_SYSTEM_PROMPT, SANITIZED_SYSTEM_PROMPT, IDENTITY_CONTINUITY_NOTE } from './systemPrompt.js';
import { SHARED_SYSTEM_PROMPT } from './sharedSystemPrompt.js';
import { SANITIZE_SYSTEM_PROMPT } from './sanitizePrompt.js';
import { CLOUD_FEEDBACK_SYSTEM_PROMPT } from './cloudFeedbackPrompt.js';
import { INCORPORATE_SYSTEM_PROMPT } from './incorporatePrompt.js';
import { verifyAccessJwt } from './cfAccessAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');
const MAX_PROMPT_LENGTH = 8000;

// Only rows that completed successfully belong in a rebuilt LLM context —
// a 'pending' row means the provider call is still in flight (shouldn't be
// possible to observe mid-request, but excluded for safety) and a 'failed'
// row means the provider call errored, so it never re-enters context or
// gets duplicated if the user retries the same turn.
function forContext(messages) {
  return messages.filter((m) => m.status !== 'failed' && m.status !== 'pending');
}

// Cloudflare Access is the entire auth boundary — but the plaintext
// Cf-Access-Authenticated-User-Email header it also sends is NOT trusted:
// anything that could reach the origin directly could set that header to
// any value it likes. Identity comes only from the signed
// Cf-Access-Jwt-Assertion JWT, cryptographically verified against
// Cloudflare's own keys. A JWT that's present but invalid is a hard
// rejection, never a silent fallback — only a request with NO Access
// headers at all (local development not going through the tunnel) uses the
// configured local-dev identity.
async function identifyRequest(req, res, next) {
  const token = req.get('Cf-Access-Jwt-Assertion');

  if (!token) {
    req.userEmail = process.env.DEFAULT_LOCAL_USER_EMAIL || process.env.OWNER_EMAIL;
    return next();
  }

  try {
    const claims = await verifyAccessJwt(token);
    req.userEmail = claims.email;
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired Access token' });
  }
}

// Two-tier check only: the owner gets the personal prompt, every other
// authorized user (Titus, for now) gets the shared one. Not a general
// role/permission system.
function systemPromptFor(userEmail) {
  return userEmail === process.env.OWNER_EMAIL ? DEFAULT_SYSTEM_PROMPT : SHARED_SYSTEM_PROMPT;
}

export function createApp() {
  validateConfig();
  initDatabase(process.env.DATABASE_PATH);

  const PROVIDERS = {
    local: { sendChat: sendOllamaChat, label: 'local' },
    cloud: { sendChat: sendGeminiChat, label: 'cloud' }
  };

  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(identifyRequest);

  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down' }
  });

  app.post('/api/chat', chatLimiter, async (req, res) => {
    const { conversationId, prompt, provider = 'local', sanitized } = req.body || {};
    const sanitizedFlag = sanitized === true;

    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: `prompt must not exceed ${MAX_PROMPT_LENGTH} characters` });
    }
    // "Not found" and "not yours" collapse into the same 404 — a user must
    // never be able to tell another user's conversation ID is real by
    // guessing/incrementing it.
    if (conversationId && !userOwnsConversation(conversationId, req.userEmail)) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    const selectedProvider = PROVIDERS[provider];
    if (!selectedProvider) {
      return res.status(400).json({ error: `provider must be one of: ${Object.keys(PROVIDERS).join(', ')}` });
    }
    if (provider === 'cloud' && !process.env.GEMINI_API_KEY) {
      return res.status(400).json({ error: 'GEMINI_API_KEY is not configured — cloud provider is unavailable' });
    }
    if (sanitizedFlag && provider !== 'cloud') {
      return res.status(400).json({ error: 'the sanitize workflow only applies to the cloud provider' });
    }

    const activeConversationId = conversationId || createConversation(req.userEmail);

    // Sanitized sends are deliberately isolated from this conversation's raw
    // history and from the personal system prompt (which names the owner,
    // his family, employer, and church) — only the reviewed/edited text the
    // user explicitly confirmed reaches the cloud provider, nothing else.
    const priorMessages = sanitizedFlag ? [] : forContext(getMessages(activeConversationId));
    let systemPrompt = sanitizedFlag ? SANITIZED_SYSTEM_PROMPT : systemPromptFor(req.userEmail);

    if (!sanitizedFlag && priorMessages.some((m) => m.provider && m.provider !== selectedProvider.label)) {
      systemPrompt += `\n\n${IDENTITY_CONTINUITY_NOTE}`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: prompt }
    ];

    const { id: userMessageId } = appendMessage(
      activeConversationId,
      'user',
      prompt,
      null,
      sanitizedFlag,
      null,
      'pending'
    );

    try {
      const text = await selectedProvider.sendChat(messages);
      updateMessageStatus(userMessageId, 'complete');
      appendMessage(activeConversationId, 'assistant', text, selectedProvider.label, sanitizedFlag);
      res.json({
        conversationId: activeConversationId,
        text,
        provider: selectedProvider.label,
        sanitized: sanitizedFlag
      });
    } catch (error) {
      updateMessageStatus(userMessageId, 'failed');
      res.status(502).json({
        error: `${selectedProvider.label} provider request failed: ${error.message}`,
        conversationId: activeConversationId
      });
    }
  });

  app.post('/api/sanitize', chatLimiter, async (req, res) => {
    const { conversationId, text } = req.body || {};
    let sourceText;

    if (conversationId) {
      if (!userOwnsConversation(conversationId, req.userEmail)) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const priorMessages = forContext(getMessages(conversationId));
      if (priorMessages.length === 0) {
        return res.status(400).json({ error: 'conversation has no messages to sanitize' });
      }
      sourceText = priorMessages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
    } else if (typeof text === 'string' && text.trim() !== '') {
      if (text.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `text must not exceed ${MAX_PROMPT_LENGTH} characters` });
      }
      sourceText = text;
    } else {
      return res.status(400).json({ error: 'conversationId or text is required' });
    }

    try {
      // Always local, regardless of the Local/Cloud toggle — this preview
      // step must never itself reach the cloud, and nothing here is
      // persisted.
      const sanitizedText = await sendOllamaChat([
        { role: 'system', content: SANITIZE_SYSTEM_PROMPT },
        { role: 'user', content: sourceText }
      ]);
      res.json({ sanitized: sanitizedText });
    } catch (error) {
      res.status(502).json({ error: `Sanitization failed: ${error.message}` });
    }
  });

  app.post('/api/cloud-feedback', chatLimiter, async (req, res) => {
    const { conversationId, text } = req.body || {};

    if (typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: `text must not exceed ${MAX_PROMPT_LENGTH} characters` });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(400).json({ error: 'GEMINI_API_KEY is not configured — cloud provider is unavailable' });
    }
    if (conversationId && !userOwnsConversation(conversationId, req.userEmail)) {
      return res.status(404).json({ error: 'conversation not found' });
    }

    const activeConversationId = conversationId || createConversation(req.userEmail);

    // Same rule as /api/chat's sanitized path: only the already-reviewed
    // text the user explicitly submitted reaches Gemini, isolated from this
    // conversation's raw history.
    const { id: userMessageId } = appendMessage(activeConversationId, 'user', text, null, true, null, 'pending');

    try {
      const feedback = await sendGeminiChat([
        { role: 'system', content: CLOUD_FEEDBACK_SYSTEM_PROMPT },
        { role: 'user', content: text }
      ]);
      updateMessageStatus(userMessageId, 'complete');
      const { id: feedbackMessageId } = appendMessage(
        activeConversationId,
        'assistant',
        feedback,
        'cloud',
        true,
        'cloud_feedback'
      );
      res.json({ conversationId: activeConversationId, feedback, feedbackMessageId });
    } catch (error) {
      updateMessageStatus(userMessageId, 'failed');
      res.status(502).json({
        error: `Cloud feedback request failed: ${error.message}`,
        conversationId: activeConversationId
      });
    }
  });

  app.post('/api/incorporate', chatLimiter, async (req, res) => {
    const { conversationId, feedbackMessageId } = req.body || {};

    if (!conversationId || !userOwnsConversation(conversationId, req.userEmail)) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    if (typeof feedbackMessageId !== 'string' || feedbackMessageId.trim() === '') {
      return res.status(400).json({ error: 'feedbackMessageId is required' });
    }

    // Never trust arbitrary client-supplied feedback text — look up the
    // actual stored message and verify it's really a cloud-feedback reply
    // belonging to this conversation.
    const feedbackMessage = getMessageById(feedbackMessageId);
    if (
      !feedbackMessage ||
      feedbackMessage.conversation_id !== conversationId ||
      feedbackMessage.kind !== 'cloud_feedback'
    ) {
      return res.status(404).json({ error: 'feedback message not found for this conversation' });
    }

    // Only the original, unsanitized turns — the sanitized cloud-feedback
    // exchange itself is excluded, since its genericized text would just
    // duplicate/contradict the real details this step is meant to restore.
    const originalMessages = forContext(getMessages(conversationId)).filter((m) => !m.sanitized);

    const messages = [
      { role: 'system', content: INCORPORATE_SYSTEM_PROMPT },
      ...originalMessages.map((m) => ({ role: m.role, content: m.content })),
      {
        role: 'user',
        content: `Outside feedback on a sanitized version of this situation:\n\n${feedbackMessage.content}\n\nProduce a final, complete response to the original question above, incorporating the useful parts of this feedback and using the real names and specifics from our conversation.`
      }
    ];

    try {
      const text = await sendOllamaChat(messages);
      appendMessage(conversationId, 'assistant', text, 'local', false, 'incorporated');
      res.json({ conversationId, text });
    } catch (error) {
      res.status(502).json({ error: `Incorporation failed: ${error.message}` });
    }
  });

  app.get('/api/conversations', (req, res) => {
    res.json(listConversations(req.userEmail));
  });

  app.get('/api/conversations/:id', (req, res) => {
    if (!userOwnsConversation(req.params.id, req.userEmail)) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json(getMessages(req.params.id));
  });

  app.get('/api/health', async (req, res) => {
    const [ollama, gemini, database] = await Promise.all([
      checkOllamaHealth(),
      checkGeminiHealth(),
      checkDatabaseHealth()
    ]);
    const allHealthy = ollama === 'healthy' && database === 'healthy';
    res.json({ status: allHealthy ? 'healthy' : 'degraded', ollama, gemini, database });
  });

  // Unmatched /api/* routes get a JSON 404, not the SPA's index.html fallback.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use(express.static(distDir));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  // Centralized fallback so an uncaught error becomes a clean JSON 500
  // instead of Express's default HTML error page.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
