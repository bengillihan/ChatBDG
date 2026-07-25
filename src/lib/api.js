async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
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

export function getObjections({ conversationId, text, signal }) {
  return request('/api/objections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text }),
    signal
  });
}

export function incorporateLocally({ conversationId, feedbackMessageId, signal }) {
  return request('/api/incorporate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, feedbackMessageId }),
    signal
  });
}

export function listConversations() {
  return request('/api/conversations');
}

export function getConversation(id) {
  return request(`/api/conversations/${id}`);
}
