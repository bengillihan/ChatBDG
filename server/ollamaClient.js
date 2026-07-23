import OpenAI from 'openai';

let client;

export function getOllamaClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.OLLAMA_BASE_URL,
      apiKey: 'ollama'
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
    messages
  });

  return completion.choices[0].message.content;
}
