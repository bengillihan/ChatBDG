import { describe, expect, it } from 'vitest';
import { FEEDBACK_VARIANTS, deriveFeedbackFromMessages } from './App.jsx';

describe('cloud feedback UI configuration', () => {
  it('exposes all four purpose-built buttons with distinct kinds and API actions', () => {
    expect(FEEDBACK_VARIANTS.map((variant) => variant.label)).toEqual([
      'General Feedback',
      'Pros & Cons',
      'Objections',
      'How to Improve'
    ]);
    expect(new Set(FEEDBACK_VARIANTS.map((variant) => variant.kind)).size).toBe(4);
    expect(new Set(FEEDBACK_VARIANTS.map((variant) => variant.apiFn)).size).toBe(4);
  });
});

describe('deriveFeedbackFromMessages', () => {
  it('keeps the newest unconsumed feedback actionable even when a plain message follows it', () => {
    const messages = [
      { id: 'feedback-1', role: 'assistant', kind: 'improvements', content: 'Improve this' },
      { id: 'user-2', role: 'user', kind: null, content: 'a later manual message' }
    ];
    expect(deriveFeedbackFromMessages(messages)).toEqual({
      messageId: 'feedback-1',
      text: 'Improve this',
      kind: 'improvements'
    });
  });

  it('does not resurface feedback already linked to a recorded incorporation', () => {
    const messages = [
      { id: 'feedback-1', role: 'assistant', kind: 'pros_cons', content: 'Pros and cons' },
      {
        id: 'incorporated-1',
        role: 'assistant',
        kind: 'incorporated',
        feedbackMessageId: 'feedback-1',
        incorporationMode: 'incorporate'
      }
    ];
    expect(deriveFeedbackFromMessages(messages)).toBeNull();
  });
});
