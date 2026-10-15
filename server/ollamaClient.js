// Talks to Ollama's native /api/chat endpoint rather than its OpenAI-compatible
// /v1 shim, because only the native API exposes the three controls this app
// needs: token streaming with thinking separated from content (`think`),
// per-request `keep_alive`, and per-request sampling `options`.

// A long context (long history + an attached PDF) can legitimately take
// several minutes for the local model to process and generate against. The
// HTTP response to the browser stays open past Cloudflare's own edge timeout
// via a heartbeat (see app.js), so this is the binding timeout for a
// local-model call — set generously.
const REQUEST_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_TOKENS = 4096;

// Ollama's default is to unload a model after 5 idle minutes — shorter than
// it takes to read a long reply and write the next message, so conversations
// kept paying a ~9GB reload mid-thread. Not -1 (forever): this machine is
// also a daily-use desktop with no memory to spare, so the model should
// still release its memory once a study session is genuinely over.
const KEEP_ALIVE = '30m';

// Qwen3's recommended sampling for each mode. Sampling params don't force a
// model reload, so one Modelfile can serve both via per-request options.
const THINKING_OPTIONS = { temperature: 0.6, top_p: 0.95, top_k: 20 };
const NON_THINKING_OPTIONS = { temperature: 0.7, top_p: 0.8, top_k: 20 };

function ollamaRoot() {
  return process.env.OLLAMA_BASE_URL.replace(/\/v1\/?$/, '');
}

export async function checkOllamaHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(new URL('/api/tags', ollamaRoot()), { signal: controller.signal });
    clearTimeout(timeoutId);
    return response.ok ? 'healthy' : 'unhealthy';
  } catch {
    return 'unhealthy';
  }
}

// Reasoning models (e.g. Qwen's thinking mode) can emit their internal
// chain-of-thought inline as <think>...</think> before the real answer. With
// the native `think` parameter Ollama normally routes that into a separate
// `message.thinking` field instead, but this stays as a defense in case a
// template or Ollama version ever inlines it again. That reasoning is often
// in a different language than the reply and must never reach storage or the
// UI. Strip every closed block, then — if a <think> was opened but never
// closed (generation cut off mid-thought by the token cap) — drop everything
// from that point on rather than leaking a partial thought.
export function stripThinking(rawContent) {
  if (typeof rawContent !== 'string') return rawContent;
  return visibleSoFar(rawContent).trim();
}

// Streaming-safe variant of stripThinking: the same rules, plus it holds back
// a trailing fragment like "<thi" that might be the start of a tag, and it
// never trims trailing whitespace (more text may still follow it).
function visibleSoFar(raw) {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const openIdx = text.search(/<think>/i);
  if (openIdx !== -1) text = text.slice(0, openIdx);
  for (let n = Math.min(6, text.length); n > 0; n -= 1) {
    if ('<think>'.startsWith(text.slice(-n).toLowerCase())) {
      text = text.slice(0, -n);
      break;
    }
  }
  return text.trimStart();
}

async function* readLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

// When reasoning runs long enough to exhaust the whole completion token
// budget before any real answer is produced, content comes back empty
// (done_reason: "length") — confirmed directly against production. Silently
// returning that empty string would show the user a blank reply, so it's
// swapped for an explicit, honest message instead. The `thinking` field is
// never read for content, on purpose.
const EMPTY_AFTER_THINKING_MESSAGE =
  "The model's internal reasoning used its entire response budget and never produced an answer. Try a shorter or more specific prompt, or turn off Think hard.";

// onDelta receives each new piece of visible reply text as it's generated;
// onThinking fires once when the model starts reasoning (so the UI can say
// so), without ever exposing the reasoning itself.
export async function sendChat(messages, { think = false, onDelta, onThinking, signal } = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(new URL('/api/chat', ollamaRoot()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL,
      messages,
      stream: true,
      think,
      keep_alive: KEEP_ALIVE,
      options: { ...(think ? THINKING_OPTIONS : NON_THINKING_OPTIONS), num_predict: MAX_RESPONSE_TOKENS }
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Ollama returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  let raw = '';
  let emitted = '';
  let sawThinking = false;
  let final = null;

  for await (const line of readLines(response.body)) {
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(chunk.error);

    if (chunk.message?.thinking && !sawThinking) {
      sawThinking = true;
      onThinking?.();
    }

    if (chunk.message?.content) {
      raw += chunk.message.content;
      const visible = visibleSoFar(raw);
      // A delta can only extend what was already sent — if stripping ever
      // shrinks the visible text, hold off until it grows past it again.
      if (onDelta && visible.length > emitted.length && visible.startsWith(emitted)) {
        onDelta(visible.slice(emitted.length));
        emitted = visible;
      }
    }

    if (chunk.done) final = chunk;
  }

  if (!final) throw new Error('Ollama stream ended before the response completed');

  const text = stripThinking(raw);
  const promptTokens = final.prompt_eval_count ?? null;
  const completionTokens = final.eval_count ?? null;

  return {
    text: text || EMPTY_AFTER_THINKING_MESSAGE,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null
    }
  };
}
