// The Express app, separated from index.js's app.listen() call so tests can
// import and exercise it directly via supertest without binding a real port.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { validateConfig } from './config.js';
import { MAX_ATTACHMENT_BYTES, isAllowedFilename, extractText, wrapAttachment } from './fileExtract.js';
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

// Memory storage only — the point is text-in-context, not a document store,
// so the original bytes never touch disk and are discarded once extractText
// pulls the text out of them. The extension allowlist runs here, in
// fileFilter, so an unsupported file is rejected before its bytes are ever
// buffered into memory.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  fileFilter: (req, file, cb) => {
    if (!isAllowedFilename(file.originalname)) {
      return cb(new Error(`unsupported file type — allowed: .pdf, .docx, .txt, .md`));
    }
    cb(null, true);
  }
});

// Wraps multer's callback-style error handling so a rejected upload (wrong
// type, too large) comes back as the same clean JSON 400 shape every other
// validation error in this app uses, instead of falling through to the
// centralized 500 handler.
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `file must not exceed ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB` });
    }
    res.status(400).json({ error: err.message });
  });
}

// Cloudflare Access is the entire auth boundary — but the plaintext
// Cf-Access-Authenticated-User-Email header it also sends is NOT trusted:
// anything that could reach the origin directly could set that header to
// any value it likes. Identity comes only from the signed
// Cf-Access-Jwt-Assertion JWT, cryptographically verified against
// Cloudflare's own keys. A JWT that's present but invalid is a hard
// rejection, never a silent fallback. A request with NO Access headers at
// all fails closed too, by default — it's rejected rather than assumed to be
// the owner. The only way to get the old local-dev behavior (no tunnel, no
// JWT, identify as DEFAULT_LOCAL_USER_EMAIL/OWNER_EMAIL) is to explicitly set
// ALLOW_INSECURE_LOCAL_AUTH=true, which should never be set outside a
// developer's own machine — if it were ever set in the deployed environment,
// a misconfigured or bypassed Access policy in front of the tunnel would
// silently grant owner-level access to anyone who reached the origin.
async function identifyRequest(req, res, next) {
  const token = req.get('Cf-Access-Jwt-Assertion');

  if (!token) {
    if (process.env.ALLOW_INSECURE_LOCAL_AUTH === 'true') {
      req.userEmail = process.env.DEFAULT_LOCAL_USER_EMAIL || process.env.OWNER_EMAIL;
      return next();
    }
    return res.status(401).json({ error: 'Access authentication required' });
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

  // Keyed by the verified user identity (set by identifyRequest, which runs
  // before this route-level middleware), not by IP — every request reaches
  // this server through the same Cloudflare tunnel connection, so an IP-based
  // key would put every user in one shared bucket and let one user's traffic
  // throttle another's.
  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userEmail,
    message: { error: 'Too many requests — please slow down' }
  });

  app.post('/api/chat', chatLimiter, handleUpload, async (req, res) => {
    const requestedAt = new Date().toISOString();
    const { conversationId, prompt = '', provider = 'local', sanitized } = req.body || {};
    const sanitizedFlag = sanitized === true || sanitized === 'true';
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';

    if (!trimmedPrompt && !req.file) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
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
    // Raw file content is never allowed to reach the cloud provider — neither
    // a file attached to this exact request, nor an earlier raw (unsanitized)
    // turn already sitting in this conversation's history. The only path a
    // file's content can take to Gemini is through Sanitize for Cloud, which
    // rebuilds its own source text from history and doesn't hit this route.
    if (provider === 'cloud' && req.file) {
      return res.status(400).json({
        error: 'file attachments cannot be sent to the cloud provider directly — use Sanitize for Cloud first'
      });
    }
    if (provider === 'cloud' && !sanitizedFlag && conversationId) {
      const hasRawAttachmentInHistory = forContext(getMessages(conversationId)).some(
        (m) => m.hasAttachment && !m.sanitized
      );
      if (hasRawAttachmentInHistory) {
        return res.status(400).json({
          error:
            'this conversation includes file content that has not been sanitized — use Sanitize for Cloud before sending to the cloud provider'
        });
      }
    }

    let attachment = null;
    if (req.file) {
      try {
        const extracted = await extractText(req.file.buffer, req.file.originalname);
        attachment = { filename: req.file.originalname, text: wrapAttachment(req.file.originalname, extracted) };
      } catch (error) {
        return res.status(400).json({ error: `could not read attached file: ${error.message}` });
      }
    }

    const activeConversationId = conversationId || createConversation(req.userEmail);
    const content = attachment
      ? trimmedPrompt
        ? `${trimmedPrompt}\n\n${attachment.text}`
        : attachment.text
      : trimmedPrompt;

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
      { role: 'user', content }
    ];

    const { id: userMessageId } = appendMessage(activeConversationId, 'user', content, {
      sanitized: sanitizedFlag,
      status: 'pending',
      attachment: attachment ? { filename: attachment.filename } : null
    });

    try {
      const { text, usage } = await selectedProvider.sendChat(messages);
      updateMessageStatus(userMessageId, 'complete');
      const { createdAt: respondedAt } = appendMessage(activeConversationId, 'assistant', text, {
        provider: selectedProvider.label,
        sanitized: sanitizedFlag,
        usage
      });
      res.json({
        conversationId: activeConversationId,
        text,
        provider: selectedProvider.label,
        sanitized: sanitizedFlag,
        usage,
        requestedAt,
        respondedAt
      });
    } catch (error) {
      updateMessageStatus(userMessageId, 'failed');
      res.status(502).json({
        error: `${selectedProvider.label} provider request failed: ${error.message}`,
        conversationId: activeConversationId,
        requestedAt
      });
    }
  });

  app.post('/api/sanitize', chatLimiter, async (req, res) => {
    const requestedAt = new Date().toISOString();
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
      // persisted. sourceText already carries any attached-file text inline
      // (it was folded into the stored message content when the file was
      // sent), so the local model genericizes file content the same way it
      // genericizes typed conversation text — no separate handling needed.
      const { text: sanitizedText, usage } = await sendOllamaChat([
        { role: 'system', content: SANITIZE_SYSTEM_PROMPT },
        { role: 'user', content: sourceText }
      ]);
      res.json({ sanitized: sanitizedText, usage, requestedAt, respondedAt: new Date().toISOString() });
    } catch (error) {
      res.status(502).json({ error: `Sanitization failed: ${error.message}`, requestedAt });
    }
  });

  app.post('/api/cloud-feedback', chatLimiter, async (req, res) => {
    const requestedAt = new Date().toISOString();
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
    const { id: userMessageId } = appendMessage(activeConversationId, 'user', text, { sanitized: true, status: 'pending' });

    try {
      const { text: feedback, usage } = await sendGeminiChat([
        { role: 'system', content: CLOUD_FEEDBACK_SYSTEM_PROMPT },
        { role: 'user', content: text }
      ]);
      updateMessageStatus(userMessageId, 'complete');
      const { id: feedbackMessageId, createdAt: respondedAt } = appendMessage(activeConversationId, 'assistant', feedback, {
        provider: 'cloud',
        sanitized: true,
        kind: 'cloud_feedback',
        usage
      });
      res.json({
        conversationId: activeConversationId,
        feedback,
        feedbackMessageId,
        usage,
        requestedAt,
        respondedAt
      });
    } catch (error) {
      updateMessageStatus(userMessageId, 'failed');
      res.status(502).json({
        error: `Cloud feedback request failed: ${error.message}`,
        conversationId: activeConversationId,
        requestedAt
      });
    }
  });

  app.post('/api/incorporate', chatLimiter, async (req, res) => {
    const requestedAt = new Date().toISOString();
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
      const { text, usage } = await sendOllamaChat(messages);
      const { createdAt: respondedAt } = appendMessage(conversationId, 'assistant', text, {
        provider: 'local',
        kind: 'incorporated',
        usage
      });
      res.json({ conversationId, text, usage, requestedAt, respondedAt });
    } catch (error) {
      res.status(502).json({ error: `Incorporation failed: ${error.message}`, requestedAt });
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
