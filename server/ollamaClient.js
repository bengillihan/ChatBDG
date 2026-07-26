import OpenAI from 'openai';

// A 32k-token context (long history + an attached PDF) can legitimately take
// several minutes for the local model to process and generate against, well
// past the old 2-minute ceiling. The HTTP response to the browser stays open
// past Cloudflare's own edge timeout via a heartbeat (see app.js), so this is
// now the binding timeout for a local-model call — set generously.
const REQUEST_TIMEOUT_MS = 600_000;
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

// Reasoning models (e.g. Qwen's thinking mode) emit their internal
// chain-of-thought inline as <think>...</think> before the real answer. That
// reasoning is often in a different language than the reply and must never
// reach storage or the UI. Strip every closed block, then — if a <think> was
// opened but never closed (generation cut off mid-thought by max_tokens) —
// drop everything from that point on rather than leaking a partial thought.
export function stripThinking(rawContent) {
  if (typeof rawContent !== 'string') return rawContent;
  let text = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const openIdx = text.search(/<think>/i);
  if (openIdx !== -1) {
    text = text.slice(0, openIdx);
  }
  return text.trim();
}

// Some Ollama versions split a reasoning model's chain-of-thought into a
// sibling `message.reasoning` (or `reasoning_content`) field instead of
// inlining <think> tags in `content` — confirmed directly against the
// qwen3-church model in production. That field is never read here, on
// purpose: only `content` (after stripThinking) is treated as the reply.
//
// When reasoning runs long enough to exhaust the whole completion token
// budget before any real answer is produced, `content` comes back empty
// (finish_reason: "length") — also confirmed directly against production.
// Silently returning that empty string would show the user a blank reply,
// so it's swapped for an explicit, honest message instead.
const EMPTY_AFTER_THINKING_MESSAGE =
  "The model's internal reasoning used its entire response budget and never produced an answer. Try a shorter or more specific prompt.";

export async function sendChat(messages) {
  const completion = await getOllamaClient().chat.completions.create({
    model: process.env.OLLAMA_MODEL,
    messages,
    max_tokens: MAX_RESPONSE_TOKENS
  });

  const text = stripThinking(completion.choices[0].message.content);

  return {
    text: text || EMPTY_AFTER_THINKING_MESSAGE,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      totalTokens: completion.usage?.total_tokens ?? null
    }
  };
}
