import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function GoogleGenAI() {
    this.models = { generateContent: generateContentMock, list: vi.fn() };
  })
}));

let sendChat;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  vi.resetModules();
  generateContentMock.mockReset();
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'test-gemini-model';
  ({ sendChat } = await import('./geminiClient.js'));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sendChat', () => {
  it('returns the response text on a normal reply', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'a real reply' });
    const text = await sendChat([{ role: 'user', content: 'hi' }]);
    expect(text).toBe('a real reply');
  });

  it('throws a clear error, naming the block reason, when Gemini returns no text (safety block)', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: undefined,
      promptFeedback: { blockReason: 'SAFETY' },
      candidates: []
    });

    await expect(sendChat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/no text response.*blocked: SAFETY/i);
  });

  it('throws a clear error naming the finish reason when there is no block reason but no text either', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: undefined,
      candidates: [{ finishReason: 'RECITATION' }]
    });

    await expect(sendChat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/no text response.*finishReason: RECITATION/i);
  });
});
