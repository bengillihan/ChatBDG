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
