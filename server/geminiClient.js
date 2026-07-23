import { GoogleGenAI } from '@google/genai';

// The old @google/generative-ai SDK reached end-of-life in Nov 2025 — this
// uses its replacement, @google/genai, instead.
let client;

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 4096;
const HEALTH_CACHE_MS = 30_000;

let healthCache = { checkedAt: 0, status: 'unconfigured' };

function getGeminiClient() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Gemini request timed out after ${ms}ms`)), ms))
  ]);
}

function isQuotaError(error) {
  return error?.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(error?.message || '');
}

export async function checkGeminiHealth() {
  if (!process.env.GEMINI_API_KEY) {
    healthCache = { checkedAt: Date.now(), status: 'unconfigured' };
    return healthCache.status;
  }

  const now = Date.now();
  if (now - healthCache.checkedAt < HEALTH_CACHE_MS) {
    return healthCache.status;
  }

  try {
    await withTimeout(getGeminiClient().models.list(), 5000);
    healthCache = { checkedAt: now, status: 'healthy' };
  } catch {
    healthCache = { checkedAt: now, status: 'unhealthy' };
  }

  return healthCache.status;
}

export async function sendChat(messages) {
  const systemMessage = messages.find((m) => m.role === 'system');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  try {
    const response = await withTimeout(
      getGeminiClient().models.generateContent({
        model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
        contents,
        config: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...(systemMessage ? { systemInstruction: systemMessage.content } : {})
        }
      }),
      REQUEST_TIMEOUT_MS
    );

    return response.text;
  } catch (error) {
    if (isQuotaError(error)) {
      throw new Error('Gemini quota exceeded for this model — check billing/plan on your Google AI Studio project');
    }
    throw error;
  }
}
