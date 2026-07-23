import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { sendMessage, listConversations, getConversation } from './lib/api.js';
import './App.css';

function Message({ message }) {
  return (
    <div className={`message ${message.role}`}>
      {message.role === 'assistant' ? (
        <div className="message-text markdown">
          <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{message.content}</ReactMarkdown>
        </div>
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
    setMessages(priorMessages.map((m) => ({ id: m.id, role: m.role, content: m.content })));
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
      const response = await sendMessage({ conversationId: activeConversationId, prompt });
      const isNewConversation = !activeConversationId;
      setActiveConversationId(response.conversationId);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: response.text }]);
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
