import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { validateConfig } from './config.js';
import {
  initDatabase,
  checkDatabaseHealth,
  createConversation,
  conversationExists,
  listConversations,
  getMessages,
  appendMessage
} from './db.js';
import { sendChat as sendOllamaChat, checkOllamaHealth } from './ollamaClient.js';
import { sendChat as sendGeminiChat, checkGeminiHealth } from './geminiClient.js';
import { DEFAULT_SYSTEM_PROMPT } from './systemPrompt.js';

const PROVIDERS = {
  local: { sendChat: sendOllamaChat, label: 'local' },
  cloud: { sendChat: sendGeminiChat, label: 'cloud' }
};

validateConfig();
initDatabase(process.env.DATABASE_PATH);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');
const MAX_PROMPT_LENGTH = 8000;

const app = express();
app.use(express.json());

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down' }
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { conversationId, prompt, provider = 'local' } = req.body || {};

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return res.status(400).json({ error: 'prompt is required' });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return res.status(400).json({ error: `prompt must not exceed ${MAX_PROMPT_LENGTH} characters` });
  }
  if (conversationId && !conversationExists(conversationId)) {
    return res.status(404).json({ error: 'conversation not found' });
  }
  const selectedProvider = PROVIDERS[provider];
  if (!selectedProvider) {
    return res.status(400).json({ error: `provider must be one of: ${Object.keys(PROVIDERS).join(', ')}` });
  }
  if (provider === 'cloud' && !process.env.GEMINI_API_KEY) {
    return res.status(400).json({ error: 'GEMINI_API_KEY is not configured — cloud provider is unavailable' });
  }

  const activeConversationId = conversationId || createConversation();
  const priorMessages = getMessages(activeConversationId);

  const messages = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: prompt }
  ];

  appendMessage(activeConversationId, 'user', prompt);

  try {
    const text = await selectedProvider.sendChat(messages);
    appendMessage(activeConversationId, 'assistant', text, selectedProvider.label);
    res.json({ conversationId: activeConversationId, text, provider: selectedProvider.label });
  } catch (error) {
    res.status(502).json({ error: `${selectedProvider.label} provider request failed: ${error.message}` });
  }
});

app.get('/api/conversations', (req, res) => {
  res.json(listConversations());
});

app.get('/api/conversations/:id', (req, res) => {
  if (!conversationExists(req.params.id)) {
    return res.status(404).json({ error: 'conversation not found' });
  }
  res.json(getMessages(req.params.id));
});

app.get('/api/health', async (req, res) => {
  const [ollama, database] = await Promise.all([checkOllamaHealth(), checkDatabaseHealth()]);
  const gemini = checkGeminiHealth();
  const allHealthy = ollama === 'healthy' && database === 'healthy';
  res.json({ status: allHealthy ? 'healthy' : 'degraded', ollama, gemini, database });
});

app.use(express.static(distDir));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`ChatBDG listening on port ${port}`);
});
