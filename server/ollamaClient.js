import OpenAI from 'openai';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_TOKENS = 4096;

let client;

export function getOllamaClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.OLLAMA_BASE_URL,
      apiKey: 'ollama',
      timeout: REQUEST_TIMEOUT_MS
    });
  }
  return client;
}

export async function checkOllamaHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const tagsUrl = new URL('/api/tags', process.env.OLLAMA_BASE_URL.replace(/\/v1\/?$/, ''));
    const response = await fetch(tagsUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response.ok ? 'healthy' : 'unhealthy';
  } catch {
    return 'unhealthy';
  }
}

export async function sendChat(messages) {
  const completion = await getOllamaClient().chat.completions.create({
    model: process.env.OLLAMA_MODEL,
    messages,
    max_tokens: MAX_RESPONSE_TOKENS
  });

  return {
    text: completion.choices[0].message.content,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      totalTokens: completion.usage?.total_tokens ?? null
    }
  };
}
