async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request to ${path} failed with ${response.status}`);
  }
  return data;
}

export function sendMessage({ conversationId, prompt, provider, sanitized, signal }) {
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
