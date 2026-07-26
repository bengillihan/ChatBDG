import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function OpenAI() {
    this.chat = { completions: { create: createMock } };
  })
}));

let sendChat;

beforeEach(async () => {
  vi.resetModules();
  createMock.mockReset();
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434/v1';
  process.env.OLLAMA_MODEL = 'test-model';
  ({ sendChat } = await import('./ollamaClient.js'));
});

describe('sendChat', () => {
  it('strips a <think> block before returning the reply', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: '<think>reasoning about the answer</think>The answer is 4.' } }],
      usage: {}
    });

    const { text } = await sendChat([{ role: 'user', content: '2+2?' }]);

    expect(text).toBe('The answer is 4.');
  });

  it('strips a long, non-English (Chinese) thinking block', async () => {
    const thinking = '让我仔细想想这个问题。'.repeat(200);
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: `<think>${thinking}</think>\n\nHere is the answer.` } }],
      usage: {}
    });

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).toBe('Here is the answer.');
    expect(text).not.toMatch(/</);
  });

  it('falls back to an explicit message when an unclosed <think> tag leaves nothing else to show', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: '<think>still reasoning and never got to finish because max_tokens hit' } }],
      usage: {}
    });

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).not.toBe('');
    expect(text).not.toMatch(/still reasoning/);
    expect(text.toLowerCase()).toContain('reasoning');
  });

  it('never reads a sibling reasoning/reasoning_content field, even when content is empty', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{
        message: {
          content: '',
          reasoning: '这是一个很长的中文推理过程，绝不应该出现在最终回复中。'.repeat(50)
        }
      }],
      usage: {},
      finish_reason: 'length'
    });

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).not.toMatch(/[一-鿿]/);
    expect(text.toLowerCase()).toContain('reasoning');
  });

  it('strips multiple <think> blocks in the same response', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{
        message: {
          content: '<think>first pass</think>Partial answer.<think>reconsidering</think>Final answer.'
        }
      }],
      usage: {}
    });

    const { text } = await sendChat([{ role: 'user', content: 'a question' }]);

    expect(text).toBe('Partial answer.Final answer.');
  });

  it('leaves content with no <think> tags completely unchanged', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'a plain reply with no reasoning block' } }],
      usage: {}
    });

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
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'targeted response' } }],
      usage: { prompt_tokens: 4_900, completion_tokens: 30, total_tokens: 4_930 }
    });

    await sendChat(messages);

    expect(createMock).toHaveBeenCalledWith({
      model: 'test-model',
      messages,
      max_tokens: 4096
    });
  });
});
