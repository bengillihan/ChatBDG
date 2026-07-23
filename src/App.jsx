import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import {
  sendMessage,
  listConversations,
  getConversation,
  sanitizeForCloud,
  getCloudFeedback,
  incorporateLocally
} from './lib/api.js';
import './App.css';

function ProviderBadge({ provider }) {
  if (!provider) return null;
  const label = provider === 'cloud' ? 'Cloud · Gemini' : 'Local · qwen3-church';
  return <span className={`provider-badge ${provider}`}>{label}</span>;
}

const LAST_CONVERSATION_KEY = 'chatbdg:lastConversationId';

// The "Incorporate Locally" button's visibility is derived from the
// conversation's actual message history, not a separate flag kept only in
// memory — otherwise reopening the conversation (or a page refresh) loses
// track of an unincorporated cloud-feedback reply even though it's still
// sitting right there in history.
function deriveFeedbackFromMessages(messages) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && last.kind === 'cloud_feedback') {
    return { messageId: last.id, text: last.content };
  }
  return null;
}

function Message({ message }) {
  const hasTags = Boolean(message.provider) || Boolean(message.sanitized) || Boolean(message.kind);
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
          {message.kind === 'cloud_feedback' && <span className="kind-badge feedback">cloud feedback</span>}
          {message.kind === 'incorporated' && <span className="kind-badge incorporated">incorporated cloud feedback</span>}
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
  // Single shared in-flight indicator across every network action, so
  // competing actions (Send to Cloud / Get Cloud Feedback / a plain send)
  // can't race and double-fire against the same draft.
  const [busyAction, setBusyAction] = useState(null);
  const [sanitizeDraft, setSanitizeDraft] = useState(null);
  const [sanitizeError, setSanitizeError] = useState(null);
  const [pendingFeedback, setPendingFeedback] = useState(null);
  const [pendingCloudConfirm, setPendingCloudConfirm] = useState(null);
  const historyEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busyAction]);

  useEffect(() => {
    refreshConversations();
    // Restores the same conversation across a real page refresh — without
    // this, a refresh always dropped back to an empty "new chat" view, which
    // is how an unincorporated cloud-feedback reply could get lost track of
    // in practice even after the openConversation()-level fix above. If the
    // saved ID no longer belongs to this user (e.g. deleted, or a different
    // person's session on a shared browser), the server 404s and this just
    // falls back to a fresh chat rather than leaking anything.
    const savedId = localStorage.getItem(LAST_CONVERSATION_KEY);
    if (savedId) {
      openConversation(savedId).catch(() => {
        localStorage.removeItem(LAST_CONVERSATION_KEY);
      });
    }
  }, []);

  useEffect(() => {
    if (activeConversationId) {
      localStorage.setItem(LAST_CONVERSATION_KEY, activeConversationId);
    } else {
      localStorage.removeItem(LAST_CONVERSATION_KEY);
    }
  }, [activeConversationId]);

  function startAction(name) {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBusyAction(name);
    return controller.signal;
  }

  function endAction() {
    abortControllerRef.current = null;
    setBusyAction(null);
  }

  function handleAbort() {
    abortControllerRef.current?.abort();
  }

  async function refreshConversations() {
    try {
      setConversations(await listConversations());
    } catch {
      // Sidebar is a convenience, not critical — leave it stale on failure.
    }
  }

  async function openConversation(id) {
    const priorMessages = await getConversation(id);
    const mapped = priorMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      provider: m.provider,
      sanitized: m.sanitized,
      kind: m.kind
    }));
    setActiveConversationId(id);
    setMessages(mapped);
    setSanitizeDraft(null);
    setSanitizeError(null);
    setPendingFeedback(deriveFeedbackFromMessages(mapped));
    setPendingCloudConfirm(null);
    setProvider('local');
  }

  function startNewChat() {
    setActiveConversationId(null);
    setMessages([]);
    setSanitizeDraft(null);
    setSanitizeError(null);
    setPendingFeedback(null);
    setPendingCloudConfirm(null);
    setProvider('local');
  }

  async function submitMessage(prompt, providerToUse, sanitizedFlag) {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: prompt, sanitized: sanitizedFlag }
    ]);
    const signal = startAction(sanitizedFlag ? 'sendSanitized' : 'send');

    try {
      const response = await sendMessage({
        conversationId: activeConversationId,
        prompt,
        provider: providerToUse,
        sanitized: sanitizedFlag,
        signal
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
          sanitized: sanitizedFlag
        }
      ]);
      if (isNewConversation) refreshConversations();
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${err.message}` }
        ]);
      }
    } finally {
      endAction();
      // Cloud is never the ambient default beyond the message that used it —
      // every send (local or cloud) resets the toggle back to Local.
      setProvider('local');
    }
  }

  function handleSend() {
    const prompt = input.trim();
    if (!prompt || busyAction) return;
    if (provider === 'cloud') {
      // Don't clear the input yet — if the user cancels the confirmation
      // below, their draft needs to still be sitting in the compose box.
      setPendingCloudConfirm(prompt);
      return;
    }

    setInput('');
    submitMessage(prompt, 'local', false);
  }

  function handleConfirmCloudSend() {
    if (!pendingCloudConfirm || busyAction) return;
    const prompt = pendingCloudConfirm;
    setPendingCloudConfirm(null);
    setInput('');
    submitMessage(prompt, 'cloud', false);
  }

  function handleCancelCloudConfirm() {
    setPendingCloudConfirm(null);
  }

  // Requires an existing conversation — sanitizing an unsent draft with no
  // stored history left "Get Cloud Feedback" with nothing for /api/incorporate
  // to later restore real names from, so that fallback path is gone.
  async function handleSanitize() {
    if (!activeConversationId || busyAction) return;
    setSanitizeError(null);
    const signal = startAction('sanitize');
    try {
      const { sanitized } = await sanitizeForCloud({ conversationId: activeConversationId, signal });
      setSanitizeDraft(sanitized);
    } catch (err) {
      if (err.name !== 'AbortError') setSanitizeError(err.message);
    } finally {
      endAction();
    }
  }

  function handleCancelSanitize() {
    abortControllerRef.current?.abort();
    setSanitizeDraft(null);
    setSanitizeError(null);
    endAction();
  }

  async function handleSendSanitized() {
    const prompt = sanitizeDraft.trim();
    if (!prompt || busyAction) return;

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: prompt, sanitized: true }]);
    setSanitizeDraft(null);
    const signal = startAction('sendSanitized');

    try {
      const response = await sendMessage({
        conversationId: activeConversationId,
        prompt,
        provider: 'cloud',
        sanitized: true,
        signal
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
      if (err.name !== 'AbortError') {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${err.message}` }
        ]);
      }
    } finally {
      endAction();
    }
  }

  async function handleGetCloudFeedback() {
    const text = sanitizeDraft.trim();
    if (!text || busyAction) return;

    setSanitizeError(null);
    const signal = startAction('feedback');

    try {
      const response = await getCloudFeedback({ conversationId: activeConversationId, text, signal });
      const isNewConversation = !activeConversationId;
      setActiveConversationId(response.conversationId);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: text, sanitized: true },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.feedback,
          provider: 'cloud',
          sanitized: true,
          kind: 'cloud_feedback'
        }
      ]);
      setSanitizeDraft(null);
      setPendingFeedback({ messageId: response.feedbackMessageId, text: response.feedback });
      if (isNewConversation) refreshConversations();
    } catch (err) {
      if (err.name !== 'AbortError') setSanitizeError(err.message);
    } finally {
      endAction();
    }
  }

  function handleDismissFeedback() {
    abortControllerRef.current?.abort();
    setPendingFeedback(null);
    endAction();
  }

  async function handleIncorporate() {
    if (!pendingFeedback || busyAction) return;
    const signal = startAction('incorporate');

    try {
      const response = await incorporateLocally({
        conversationId: activeConversationId,
        feedbackMessageId: pendingFeedback.messageId,
        signal
      });
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.text,
          provider: 'local',
          kind: 'incorporated'
        }
      ]);
      setPendingFeedback(null);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${err.message}` }
        ]);
      }
    } finally {
      endAction();
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  const canSanitize = Boolean(activeConversationId);

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
          {busyAction && (
            <div className="message assistant pending">
              Thinking…
              <button type="button" className="stop-button" onClick={handleAbort}>
                Stop
              </button>
            </div>
          )}
          <div ref={historyEndRef} />
        </div>

        {sanitizeDraft !== null ? (
          <div className="sanitize-panel">
            <div className="sanitize-panel-label">
              Names have been replaced with numbered placeholders (Person 1, Person 2, etc.) to protect identities.
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
                className="feedback-button"
                onClick={handleGetCloudFeedback}
                disabled={Boolean(busyAction) || !sanitizeDraft.trim()}
              >
                {busyAction === 'feedback' ? 'Getting feedback…' : 'Get Cloud Feedback'}
              </button>
              <button
                type="button"
                className="send-to-cloud-button"
                onClick={handleSendSanitized}
                disabled={Boolean(busyAction) || !sanitizeDraft.trim()}
              >
                {busyAction === 'sendSanitized' ? 'Sending…' : 'Send to Cloud'}
              </button>
            </div>
          </div>
        ) : pendingCloudConfirm !== null ? (
          <div className="cloud-confirm-bar">
            <div className="cloud-confirm-label">
              This will send your complete conversation history and personal profile to Gemini:
            </div>
            <div className="cloud-confirm-preview">{pendingCloudConfirm}</div>
            <div className="cloud-confirm-actions">
              <button type="button" className="cancel-button" onClick={handleCancelCloudConfirm}>
                Cancel
              </button>
              <button
                type="button"
                className="send-to-cloud-button"
                onClick={handleConfirmCloudSend}
                disabled={Boolean(busyAction)}
              >
                {busyAction === 'send' ? 'Sending…' : 'Confirm & Send'}
              </button>
            </div>
          </div>
        ) : pendingFeedback !== null ? (
          <div className="incorporate-bar">
            <div className="incorporate-bar-label">
              Cloud feedback (Gemini) received — incorporate it into a complete local answer using the real details
              from this conversation?
            </div>
            <div className="incorporate-bar-actions">
              <button type="button" className="cancel-button" onClick={handleDismissFeedback}>
                Dismiss
              </button>
              <button
                type="button"
                className="incorporate-button"
                onClick={handleIncorporate}
                disabled={Boolean(busyAction)}
              >
                {busyAction === 'incorporate' ? 'Incorporating…' : 'Incorporate Locally'}
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
              disabled={Boolean(busyAction) || !canSanitize}
              title="Generate a genericized draft of this conversation to review before sending it to the cloud"
            >
              {busyAction === 'sanitize' ? 'Sanitizing…' : 'Sanitize for Cloud'}
            </button>
            <button type="button" onClick={handleSend} disabled={Boolean(busyAction) || !input.trim()}>
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
