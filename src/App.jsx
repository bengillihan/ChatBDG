import { useEffect, useRef, useState } from 'react';
import { ALLOWED_ATTACHMENT_EXTENSIONS, attachmentError } from './lib/attachments.js';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import {
  sendMessage,
  listConversations,
  getConversation,
  sanitizeForCloud,
  getCloudFeedback,
  getProsCons,
  getObjections,
  getImprovements,
  incorporateLocally
} from './lib/api.js';
import './App.css';

function ProviderBadge({ provider }) {
  if (!provider) return null;
  const label = provider === 'cloud' ? 'Cloud · Gemini' : 'Local · qwen3-church';
  return <span className={`provider-badge ${provider}`}>{label}</span>;
}

const LAST_CONVERSATION_KEY = 'chatbdg:lastConversationId';

export const FEEDBACK_VARIANTS = [
  {
    actionName: 'feedback',
    label: 'General Feedback',
    pendingLabel: 'Getting feedback…',
    apiFn: getCloudFeedback,
    responseField: 'feedback',
    kind: 'cloud_feedback',
    className: 'feedback-button'
  },
  {
    actionName: 'prosCons',
    label: 'Pros & Cons',
    pendingLabel: 'Weighing pros & cons…',
    apiFn: getProsCons,
    responseField: 'prosCons',
    kind: 'pros_cons',
    className: 'pros-cons-button'
  },
  {
    actionName: 'objections',
    label: 'Objections',
    pendingLabel: 'Getting objections…',
    apiFn: getObjections,
    responseField: 'objections',
    kind: 'objections',
    className: 'objections-button'
  },
  {
    actionName: 'improvements',
    label: 'How to Improve',
    pendingLabel: 'Finding improvements…',
    apiFn: getImprovements,
    responseField: 'improvements',
    kind: 'improvements',
    className: 'improvements-button'
  }
];

const FEEDBACK_LABELS = Object.fromEntries(FEEDBACK_VARIANTS.map((variant) => [variant.kind, variant.label]));
const FEEDBACK_KINDS = new Set(FEEDBACK_VARIANTS.map((variant) => variant.kind));

// Find the newest feedback reply that has not already been consumed by an
// incorporation action. This deliberately does not require feedback to be
// the very last message: a later plain message or page refresh must not make
// the explicit button disappear. Legacy incorporated rows lack a source ID,
// so treat one as a boundary rather than resurfacing older feedback.
export function deriveFeedbackFromMessages(messages) {
  const consumedIds = new Set(
    messages.filter((message) => message.kind === 'incorporated' && message.feedbackMessageId).map((message) => message.feedbackMessageId)
  );

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind === 'incorporated' && !message.feedbackMessageId) break;
    if (message.role === 'assistant' && FEEDBACK_KINDS.has(message.kind) && !consumedIds.has(message.id)) {
      return { messageId: message.id, text: message.content, kind: message.kind };
    }
  }
  return null;
}

function formatTimestamp(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Message({ message }) {
  const hasTags =
    Boolean(message.provider) ||
    Boolean(message.sanitized) ||
    Boolean(message.kind) ||
    Boolean(message.attachmentFilename) ||
    Boolean(message.usage?.totalTokens) ||
    Boolean(message.createdAt);
  const timestamp = formatTimestamp(message.createdAt);
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
          {message.kind === 'pros_cons' && <span className="kind-badge pros-cons">pros &amp; cons</span>}
          {message.kind === 'objections' && <span className="kind-badge objections">objections</span>}
          {message.kind === 'improvements' && <span className="kind-badge improvements">how to improve</span>}
          {message.kind === 'incorporated' && (
            <span className="kind-badge incorporated">
              {message.incorporationMode === 'organize' ? 'organized' : 'incorporated'}
              {message.feedbackKind ? ` · ${FEEDBACK_LABELS[message.feedbackKind] || message.feedbackKind}` : ' cloud feedback'}
            </span>
          )}
          {message.attachmentFilename && <span className="attachment-badge">📎 {message.attachmentFilename}</span>}
          {message.usage?.totalTokens != null && (
            <span className="token-badge" title="prompt + completion tokens for this turn">
              {message.usage.totalTokens} tokens
            </span>
          )}
          {timestamp && <span className="timestamp-badge">{timestamp}</span>}
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
  const [attachedFile, setAttachedFile] = useState(null);
  const [attachError, setAttachError] = useState(null);
  const historyEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const fileInputRef = useRef(null);

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
      kind: m.kind,
      feedbackMessageId: m.feedbackMessageId,
      feedbackKind: m.feedbackKind,
      incorporationMode: m.incorporationMode,
      createdAt: m.created_at,
      usage: m.usage,
      attachmentFilename: m.attachmentFilename
    }));
    setActiveConversationId(id);
    setMessages(mapped);
    setSanitizeDraft(null);
    setSanitizeError(null);
    setPendingFeedback(deriveFeedbackFromMessages(mapped));
    setPendingCloudConfirm(null);
    setAttachedFile(null);
    setAttachError(null);
    setProvider('local');
  }

  function startNewChat() {
    setActiveConversationId(null);
    setMessages([]);
    setSanitizeDraft(null);
    setSanitizeError(null);
    setPendingFeedback(null);
    setPendingCloudConfirm(null);
    setAttachedFile(null);
    setAttachError(null);
    setProvider('local');
  }

  async function submitMessage(prompt, providerToUse, sanitizedFlag, file) {
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
        sanitized: sanitizedFlag,
        attachmentFilename: file?.name,
        createdAt: new Date().toISOString()
      }
    ]);
    const signal = startAction(sanitizedFlag ? 'sendSanitized' : 'send');

    try {
      const response = await sendMessage({
        conversationId: activeConversationId,
        prompt,
        provider: providerToUse,
        sanitized: sanitizedFlag,
        file,
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
          sanitized: sanitizedFlag,
          usage: response.usage,
          createdAt: response.respondedAt
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
    if ((!prompt && !attachedFile) || busyAction) return;
    if (provider === 'cloud') {
      // Don't clear the input yet — if the user cancels the confirmation
      // below, their draft needs to still be sitting in the compose box.
      // Unreachable with a file attached (the Cloud toggle is disabled the
      // moment a file is attached), but guarded here too since raw file
      // content must never take the cloud-confirm path.
      setPendingCloudConfirm(prompt);
      return;
    }

    setInput('');
    const file = attachedFile;
    setAttachedFile(null);
    setAttachError(null);
    submitMessage(prompt, 'local', false, file);
  }

  function handleConfirmCloudSend() {
    if (!pendingCloudConfirm || busyAction) return;
    const prompt = pendingCloudConfirm;
    setPendingCloudConfirm(null);
    setInput('');
    submitMessage(prompt, 'cloud', false);
  }

  function handleFileSelect(event) {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    const error = attachmentError(file);
    if (error) {
      setAttachError(error);
      setAttachedFile(null);
      return;
    }
    setAttachError(null);
    setAttachedFile(file);
    // Raw file content can only ever be sent locally — force the toggle off
    // Cloud the moment a file is attached, rather than leaving a stale
    // "Cloud" selection sitting there for handleSend to have to guard against.
    if (provider === 'cloud') setProvider('local');
  }

  function handleRemoveAttachment() {
    setAttachedFile(null);
    setAttachError(null);
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

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: prompt, sanitized: true, createdAt: new Date().toISOString() }
    ]);
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
          sanitized: true,
          usage: response.usage,
          createdAt: response.respondedAt
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

  // All feedback variants share the reviewed sanitize draft and confirmation
  // boundary. Only the Gemini prompt, response field, and history kind differ.
  async function requestCloudInput(variant) {
    const { actionName, apiFn, responseField, kind } = variant;
    const text = sanitizeDraft.trim();
    if (!text || busyAction) return;

    setSanitizeError(null);
    const signal = startAction(actionName);

    try {
      const response = await apiFn({ conversationId: activeConversationId, text, signal });
      const isNewConversation = !activeConversationId;
      setActiveConversationId(response.conversationId);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: text, sanitized: true, createdAt: response.requestedAt },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response[responseField],
          provider: 'cloud',
          sanitized: true,
          kind,
          usage: response.usage,
          createdAt: response.respondedAt
        }
      ]);
      setSanitizeDraft(null);
      setPendingFeedback({ messageId: response.feedbackMessageId, text: response[responseField], kind });
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

  async function handleIncorporate(mode = 'incorporate') {
    if (!pendingFeedback || busyAction) return;
    const actionName = mode === 'organize' ? 'organize' : 'incorporate';
    const signal = startAction(actionName);

    try {
      const response = await incorporateLocally({
        conversationId: activeConversationId,
        feedbackMessageId: pendingFeedback.messageId,
        mode,
        signal
      });
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.text,
          provider: 'local',
          kind: 'incorporated',
          feedbackMessageId: response.feedbackMessageId,
          feedbackKind: response.feedbackKind,
          incorporationMode: response.incorporationMode,
          usage: response.usage,
          createdAt: response.respondedAt
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
              {FEEDBACK_VARIANTS.map((variant) => (
                <button
                  key={variant.kind}
                  type="button"
                  className={variant.className}
                  onClick={() => requestCloudInput(variant)}
                  disabled={Boolean(busyAction) || !sanitizeDraft.trim()}
                >
                  {busyAction === variant.actionName ? variant.pendingLabel : variant.label}
                </button>
              ))}
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
              {FEEDBACK_LABELS[pendingFeedback.kind] || 'Cloud feedback'} (Gemini) received{' '}
              — incorporate it into a complete local answer using the real details from this conversation?
            </div>
            <div className="incorporate-bar-actions">
              <button type="button" className="cancel-button" onClick={handleDismissFeedback}>
                Dismiss
              </button>
              <button
                type="button"
                className="organize-button"
                onClick={() => handleIncorporate('organize')}
                disabled={Boolean(busyAction)}
              >
                {busyAction === 'organize' ? 'Organizing…' : 'Organize Feedback'}
              </button>
              <button
                type="button"
                className="incorporate-button"
                onClick={() => handleIncorporate('incorporate')}
                disabled={Boolean(busyAction)}
              >
                {busyAction === 'incorporate' ? 'Incorporating…' : 'Incorporate Locally'}
              </button>
            </div>
          </div>
        ) : (
          <div className="compose-area">
            {attachedFile && (
              <div className="attachment-chip">
                <span>📎 {attachedFile.name}</span>
                <button type="button" onClick={handleRemoveAttachment} aria-label="Remove attachment">
                  ×
                </button>
              </div>
            )}
            {attachError && <div className="attach-error">{attachError}</div>}
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
                  disabled={Boolean(attachedFile)}
                  title={attachedFile ? 'Raw file attachments can only be sent locally — use Sanitize for Cloud instead' : undefined}
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
              <input
                ref={fileInputRef}
                type="file"
                accept={ALLOWED_ATTACHMENT_EXTENSIONS.join(',')}
                onChange={handleFileSelect}
                className="file-input-hidden"
              />
              <button
                type="button"
                className="attach-button"
                onClick={() => fileInputRef.current?.click()}
                disabled={Boolean(busyAction)}
                title="Attach a PDF, Word, text, or markdown file for the local model to read"
              >
                📎 Attach
              </button>
              <button
                type="button"
                className="sanitize-button"
                onClick={handleSanitize}
                disabled={Boolean(busyAction) || !canSanitize}
                title="Generate a genericized draft of this conversation to review before sending it to the cloud"
              >
                {busyAction === 'sanitize' ? 'Sanitizing…' : 'Sanitize for Cloud'}
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={Boolean(busyAction) || (!input.trim() && !attachedFile)}
              >
                Send
              </button>
            </div>
          </div>
        )}
        {sanitizeError && <div className="sanitize-error">{sanitizeError}</div>}
      </div>
    </div>
  );
}

export default App;
