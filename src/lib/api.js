async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  // A long-running request that fails only after the server has started
  // sending keep-alive bytes (see app.js's heartbeat) can't change its status
  // code after the fact, so it reports failure as a 200 with an `error`
  // field instead of a 502 — check for that regardless of response.ok.
  if (!response.ok || data.error) {
    throw new Error(data.error || `Request to ${path} failed with ${response.status}`);
  }
  return data;
}

// For routes that accept `stream: true`: reads the server-sent events,
// calling onDelta with each new piece of reply text and onThinking when the
// model starts reasoning, and resolves with the final `done` payload — the
// same object request() would have returned. Validation failures arrive
// before the stream opens, as an ordinary JSON error response.
async function streamRequest(path, options, { onDelta, onThinking } = {}) {
  const response = await fetch(path, options);
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request to ${path} failed with ${response.status}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue; // heartbeat comment
      const event = JSON.parse(dataLine.slice('data: '.length));
      if (event.type === 'delta') onDelta?.(event.text);
      else if (event.type === 'thinking') onThinking?.();
      else if (event.type === 'error') throw new Error(event.error);
      else if (event.type === 'done') return event;
    }
  }
  throw new Error('The connection closed before the reply finished');
}

export function sendMessage({ conversationId, prompt, provider, sanitized, think, file, signal, onDelta, onThinking }) {
  if (file) {
    const formData = new FormData();
    if (conversationId) formData.append('conversationId', conversationId);
    formData.append('prompt', prompt || '');
    formData.append('provider', provider);
    formData.append('sanitized', String(Boolean(sanitized)));
    formData.append('think', String(Boolean(think)));
    formData.append('stream', 'true');
    formData.append('file', file);
    // No Content-Type header here — the browser sets the multipart boundary
    // itself, which it can only do correctly if it builds the header.
    return streamRequest('/api/chat', { method: 'POST', body: formData, signal }, { onDelta, onThinking });
  }

  return streamRequest(
    '/api/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, prompt, provider, sanitized, think: Boolean(think), stream: true }),
      signal
    },
    { onDelta, onThinking }
  );
}

export function sanitizeForCloud({ conversationId, text, signal }) {
  return request('/api/sanitize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text }),
    signal
  });
}

export function getCloudFeedback({ conversationId, text, signal }) {
  return request('/api/cloud-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text }),
    signal
  });
}

export function getProsCons({ conversationId, text, signal }) {
  return request('/api/pros-cons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text }),
    signal
  });
}

export function getObjections({ conversationId, text, signal }) {
  return request('/api/objections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text }),
    signal
  });
}

export function getImprovements({ conversationId, text, signal }) {
  return request('/api/improvements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text }),
    signal
  });
}

export function incorporateLocally({ conversationId, feedbackMessageId, mode = 'incorporate', signal, onDelta, onThinking }) {
  return streamRequest(
    '/api/incorporate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, feedbackMessageId, mode, stream: true }),
      signal
    },
    { onDelta, onThinking }
  );
}

export function listConversations() {
  return request('/api/conversations');
}

export function getConversation(id) {
  return request(`/api/conversations/${id}`);
}
