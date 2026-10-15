import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendChat } from './ollamaClient.js';

const fetchMock = vi.fn();

// Builds a fake native-API NDJSON stream. Each entry becomes one line; a
// final `done` chunk is appended unless the test supplies its own.
function ollamaStream(chunks, { done = { done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 } } = {}) {
  const lines = [...chunks.map((c) => ({ message: { role: 'assistant', ...c }, done: false })), ...(done ? [done] : [])];
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    }
  });
  return new Response(body, { status: 200 });
}

function contentStream(...pieces) {
  return ollamaStream(pieces.map((content) => ({ content })));
}

beforeEach(() => {
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434/v1';
  process.env.OLLAMA_MODEL = 'test-model';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendChat', () => {
  it('strips a <think> block before returning the reply', async () => {
    fetchMock.mockResolvedValueOnce(contentStream('<think>reasoning about the answer</think>', 'The answer is 4.'));

    const { text } = await sendChat([{ role: 'user', content: '2+2?' }]);

    expect(text).toBe('The answer is 4.');
  });

  it('strips a long, non-English (Chinese) thinking block', async () => {
    const thinking = '让我仔细想想这个问题。'.repeat(200);
    fetchMock.mockResolvedValueOnce(contentStream(`<think>${thinking}</think>\n\nHere is the answer.`));

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).toBe('Here is the answer.');
    expect(text).not.toMatch(/</);
  });

  it('falls back to an explicit message when an unclosed <think> tag leaves nothing else to show', async () => {
    fetchMock.mockResolvedValueOnce(contentStream('<think>still reasoning and never got to finish because max_tokens hit'));

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).not.toBe('');
    expect(text).not.toMatch(/still reasoning/);
    expect(text.toLowerCase()).toContain('reasoning');
  });

  it('never reads the separate thinking field, even when content is empty', async () => {
    fetchMock.mockResolvedValueOnce(
      ollamaStream([{ content: '', thinking: '这是一个很长的中文推理过程，绝不应该出现在最终回复中。'.repeat(50) }], {
        done: { done: true, done_reason: 'length' }
      })
    );

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).not.toMatch(/[一-鿿]/);
    expect(text.toLowerCase()).toContain('reasoning');
  });

  it('strips multiple <think> blocks in the same response', async () => {
    fetchMock.mockResolvedValueOnce(
      contentStream('<think>first pass</think>Partial answer.<think>reconsidering</think>Final answer.')
    );

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).toBe('Partial answer.Final answer.');
  });

  it('leaves content with no <think> tags completely unchanged', async () => {
    fetchMock.mockResolvedValueOnce(contentStream('a plain reply ', 'with no reasoning block'));

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).toBe('a plain reply with no reasoning block');
  });

  it('passes the complete messages array to Ollama without slicing or rewriting it', async () => {
    const messages = [
      { role: 'system', content: 'revision-aware system prompt' },
      { role: 'user', content: `original:${'a'.repeat(7_000)}` },
      { role: 'assistant', content: `feedback:${'b'.repeat(5_000)}` },
      { role: 'user', content: `revision:${'c'.repeat(7_000)}` }
    ];
    fetchMock.mockResolvedValueOnce(
      ollamaStream([{ content: 'targeted response' }], {
        done: { done: true, prompt_eval_count: 4_900, eval_count: 30 }
      })
    );

    const { usage } = await sendChat(messages);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'test-model', messages, stream: true, keep_alive: '30m' });
    expect(body.options.num_predict).toBe(4096);
    expect(usage).toEqual({ promptTokens: 4_900, completionTokens: 30, totalTokens: 4_930 });
  });

  it('defaults to thinking off with non-thinking sampling, and switches both when asked', async () => {
    fetchMock.mockResolvedValueOnce(contentStream('fast')).mockResolvedValueOnce(contentStream('deep'));

    await sendChat([{ role: 'user', content: 'q' }]);
    await sendChat([{ role: 'user', content: 'q' }], { think: true });

    const fast = JSON.parse(fetchMock.mock.calls[0][1].body);
    const deep = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(fast.think).toBe(false);
    expect(fast.options.top_p).toBe(0.8);
    expect(deep.think).toBe(true);
    expect(deep.options.top_p).toBe(0.95);
  });

  it('streams visible deltas that never include thinking, even when a tag is split across chunks', async () => {
    fetchMock.mockResolvedValueOnce(
      ollamaStream([
        { thinking: 'private reasoning' },
        { content: 'Hello' },
        { content: ' there <thi' },
        { content: 'nk>secret inline thought</think> friend' }
      ])
    );
    const deltas = [];
    const onThinking = vi.fn();

    const { text } = await sendChat([{ role: 'user', content: 'hi' }], { onDelta: (d) => deltas.push(d), onThinking });

    const streamed = deltas.join('');
    expect(streamed).not.toMatch(/secret|private|<thi/);
    expect(text).toBe('Hello there  friend');
    expect(text.startsWith(streamed.trim())).toBe(true);
    expect(onThinking).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error chunk from Ollama as a thrown error', async () => {
    fetchMock.mockResolvedValueOnce(ollamaStream([], { done: { error: 'model failed to load' } }));

    await expect(sendChat([{ role: 'user', content: 'q' }])).rejects.toThrow('model failed to load');
  });

  it('throws when the stream ends without a done chunk', async () => {
    fetchMock.mockResolvedValueOnce(ollamaStream([{ content: 'partial' }], { done: null }));

    await expect(sendChat([{ role: 'user', content: 'q' }])).rejects.toThrow(/ended before/);
  });
});
