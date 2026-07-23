import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { sendMessage, listConversations, getConversation, sanitizeForCloud } from './lib/api.js';
import './App.css';

function ProviderBadge({ provider }) {
  if (!provider) return null;
  const label = provider === 'cloud' ? 'Cloud · Gemini' : 'Local · qwen3-church';
  return <span className={`provider-badge ${provider}`}>{label}</span>;
}

function Message({ message }) {
  const hasTags = Boolean(message.provider) || Boolean(message.sanitized);
  return (
    <div className={`message ${message.role}`}>
      {message.role === 'assistant' ? (
        <div className="message-text markdown">
          <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{message.content}</ReactMarkdown>
        </div>
      ) : (
        <div className="message-text">{message.content}</div>
      )}
      {hasTags && (
        <div className="message-tags">
          <ProviderBadge provider={message.provider} />
          {message.sanitized && <span className="sanitized-badge">sanitized</span>}
        </div>
      )}
    </div>
  );
}

function App() {
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState('local');
  const [sending, setSending] = useState(false);
  const [sanitizing, setSanitizing] = useState(false);
  const [sanitizeDraft, setSanitizeDraft] = useState(null);
  const [sanitizeError, setSanitizeError] = useState(null);
  const historyEndRef = useRef(null);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  useEffect(() => {
    refreshConversations();
  }, []);

  async function refreshConversations() {
    try {
      setConversations(await listConversations());
    } catch {
      // Sidebar is a convenience, not critical — leave it stale on failure.
    }
  }

  async function openConversation(id) {
    const priorMessages = await getConversation(id);
    setActiveConversationId(id);
    setMessages(
      priorMessages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        provider: m.provider,
        sanitized: m.sanitized
      }))
    );
    setSanitizeDraft(null);
    setSanitizeError(null);
  }

  function startNewChat() {
    setActiveConversationId(null);
    setMessages([]);
    setSanitizeDraft(null);
    setSanitizeError(null);
  }

  async function handleSend() {
    const prompt = input.trim();
    if (!prompt || sending) return;

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: prompt }]);
    setInput('');
    setSending(true);

    try {
      const response = await sendMessage({ conversationId: activeConversationId, prompt, provider });
      const isNewConversation = !activeConversationId;
      setActiveConversationId(response.conversationId);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: response.text, provider: response.provider }
      ]);
      if (isNewConversation) refreshConversations();
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${err.message}` }
      ]);
    } finally {
      setSending(false);
    }
  }

  // Always sanitizes the conversation that has actually happened so far
  // (via conversationId) rather than an unsent draft — this is a review step
  // over what was already discussed locally, not over what you're about to
  // type. If nothing has been sent yet, it falls back to sanitizing the
  // current compose-box text instead so the button still does something
  // useful on a brand-new chat.
  async function handleSanitize() {
    if (sanitizing) return;
    setSanitizeError(null);
    setSanitizing(true);
    try {
      const { sanitized } = activeConversationId
        ? await sanitizeForCloud({ conversationId: activeConversationId })
        : await sanitizeForCloud({ text: input.trim() });
      setSanitizeDraft(sanitized);
    } catch (err) {
      setSanitizeError(err.message);
    } finally {
      setSanitizing(false);
    }
  }

  function handleCancelSanitize() {
    setSanitizeDraft(null);
    setSanitizeError(null);
  }

  async function handleSendSanitized() {
    const prompt = sanitizeDraft.trim();
    if (!prompt || sending) return;

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: prompt, sanitized: true }]);
    setSanitizeDraft(null);
    setSending(true);

    try {
      const response = await sendMessage({
        conversationId: activeConversationId,
        prompt,
        provider: 'cloud',
        sanitized: true
      });
      const isNewConversation = !activeConversationId;
      setActiveConversationId(response.conversationId);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.text,
          provider: response.provider,
          sanitized: true
        }
      ]);
      if (isNewConversation) refreshConversations();
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${err.message}` }
      ]);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  const canSanitize = Boolean(activeConversationId) || Boolean(input.trim());

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button type="button" className="new-chat-button" onClick={startNewChat}>
          + New chat
        </button>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`conversation-item ${conversation.id === activeConversationId ? 'active' : ''}`}
              onClick={() => openConversation(conversation.id)}
            >
              {conversation.title || 'New conversation'}
            </button>
          ))}
        </div>
      </aside>
      <div className="chat-app">
        <div className="chat-history">
          {messages.length === 0 && <div className="empty-state">Ask ChatBDG anything to get started.</div>}
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          {sending && <div className="message assistant pending">Thinking…</div>}
          <div ref={historyEndRef} />
        </div>

        {sanitizeDraft !== null ? (
          <div className="sanitize-panel">
            <div className="sanitize-panel-label">
              Review before sending to the cloud — edit anything the local model missed or got wrong.
            </div>
            <textarea
              className="sanitize-textarea"
              value={sanitizeDraft}
              onChange={(event) => setSanitizeDraft(event.target.value)}
              rows={6}
            />
            <div className="sanitize-panel-actions">
              <button type="button" className="cancel-button" onClick={handleCancelSanitize}>
                Cancel
              </button>
              <button
                type="button"
                className="send-to-cloud-button"
                onClick={handleSendSanitized}
                disabled={sending || !sanitizeDraft.trim()}
              >
                Send to Cloud
              </button>
            </div>
          </div>
        ) : (
          <div className="chat-input-row">
            <div className="provider-toggle" role="radiogroup" aria-label="Provider">
              <button
                type="button"
                role="radio"
                aria-checked={provider === 'local'}
                className={provider === 'local' ? 'active' : ''}
                onClick={() => setProvider('local')}
              >
                Local
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={provider === 'cloud'}
                className={provider === 'cloud' ? 'active' : ''}
                onClick={() => setProvider('cloud')}
              >
                Cloud
              </button>
            </div>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask ChatBDG anything..."
              rows={2}
            />
            <button
              type="button"
              className="sanitize-button"
              onClick={handleSanitize}
              disabled={sanitizing || !canSanitize}
              title="Generate a genericized draft of this conversation to review before sending it to the cloud"
            >
              {sanitizing ? 'Sanitizing…' : 'Sanitize for Cloud'}
            </button>
            <button type="button" onClick={handleSend} disabled={sending || !input.trim()}>
              Send
            </button>
          </div>
        )}
        {sanitizeError && <div className="sanitize-error">{sanitizeError}</div>}
      </div>
    </div>
  );
}

export default App;
