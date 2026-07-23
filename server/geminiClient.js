import { GoogleGenAI } from '@google/genai';

// The old @google/generative-ai SDK reached end-of-life in Nov 2025 — this
// uses its replacement, @google/genai, instead.
let client;

function getGeminiClient() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

export function checkGeminiHealth() {
  return process.env.GEMINI_API_KEY ? 'healthy' : 'unconfigured';
}

export async function sendChat(messages) {
  const systemMessage = messages.find((m) => m.role === 'system');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  const response = await getGeminiClient().models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    contents,
    ...(systemMessage ? { config: { systemInstruction: systemMessage.content } } : {})
  });

  return response.text;
}
