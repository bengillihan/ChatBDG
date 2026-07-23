import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { sendMessage, listConversations, getConversation } from './lib/api.js';
import './App.css';

function ProviderBadge({ provider }) {
  if (!provider) return null;
  const label = provider === 'cloud' ? 'Cloud · Gemini' : 'Local · qwen3-church';
  return <span className={`provider-badge ${provider}`}>{label}</span>;
}

function Message({ message }) {
  return (
    <div className={`message ${message.role}`}>
      {message.role === 'assistant' ? (
        <>
          <div className="message-text markdown">
            <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{message.content}</ReactMarkdown>
          </div>
          <ProviderBadge provider={message.provider} />
        </>
      ) : (
        <div className="message-text">{message.content}</div>
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
    setMessages(priorMessages.map((m) => ({ id: m.id, role: m.role, content: m.content, provider: m.provider })));
  }

  function startNewChat() {
    setActiveConversationId(null);
    setMessages([]);
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

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

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
          <button type="button" onClick={handleSend} disabled={sending || !input.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
