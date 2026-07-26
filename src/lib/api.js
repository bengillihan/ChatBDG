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

export function sendMessage({ conversationId, prompt, provider, sanitized, file, signal }) {
  if (file) {
    const formData = new FormData();
    if (conversationId) formData.append('conversationId', conversationId);
    formData.append('prompt', prompt || '');
    formData.append('provider', provider);
    formData.append('sanitized', String(Boolean(sanitized)));
    formData.append('file', file);
    // No Content-Type header here — the browser sets the multipart boundary
    // itself, which it can only do correctly if it builds the header.
    return request('/api/chat', { method: 'POST', body: formData, signal });
  }

  return request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, prompt, provider, sanitized }),
    signal
  });
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

export function incorporateLocally({ conversationId, feedbackMessageId, mode = 'incorporate', signal }) {
  return request('/api/incorporate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, feedbackMessageId, mode }),
    signal
  });
}

export function listConversations() {
  return request('/api/conversations');
}

export function getConversation(id) {
  return request(`/api/conversations/${id}`);
}
