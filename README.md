# ChatBDG

A personal chat web app for Bible study lesson prep, sermon/communion meditation drafting, church governance writing, and general assistant use — shared by Ben Gillihan (owner) and his son Titus. Runs on a Mac mini behind a Cloudflare Tunnel, routing to a local Ollama model by default and optionally to Gemini for a second opinion.

This document exists for whoever (human or AI agent) touches this code next. It explains not just what the code does but **why** it's built this way — several of these decisions look arbitrary until you know the incident or constraint behind them.

---

## 1. What this is, and what it deliberately is not

ChatBDG is a fork of an internal enterprise app (ChatAPS, built for American Power Systems) with everything APS-specific stripped out: no Entra ID, no OpenAI Tier-2 routing, no audit-log compliance machinery, no Electron shell. What's left is the pattern that mattered — a chat UI plus an OpenAI-compatible client — rebuilt as a plain web app for personal, single-family use.

It is **not**:
- A multi-tenant SaaS product (it has exactly two users, hardcoded by email, not a role system)
- An enterprise app with compliance requirements (no audit trail, no data retention policy beyond "SQLite on the Mac mini")
- Something with its own login system (see §5 — Cloudflare Access is the *entire* auth boundary)

Keep this scope in mind before adding generalized abstractions (a permissions system, a multi-tenant schema, configurable auth providers) — they'd solve problems this app doesn't have.

## Quick start (running locally)

```sh
cp .env.example .env   # then fill in OWNER_EMAIL, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, etc. — see §11
npm install
npm run build
npm start               # serves the built app + API on http://localhost:3000
```

For frontend development, run the API and the Vite dev server side by side — `vite.config.js` proxies `/api` to `:3000`:

```sh
npm start      # Express API + static server on :3000
npm run dev    # Vite dev server on :5173, proxies /api to :3000
```

Requires Node.js 22.5+ (see §8 for why) and a running Ollama instance with the `qwen3-church` model available (`ollama list` to check, or build it from the repo's `Modelfile`: `ollama create qwen3-church -f Modelfile`).

**Deployed as a `launchd` service**, not a manually-started process — see §6. To pick up code changes on the Mac mini: `npm run build`, then `launchctl kickstart -k gui/$(id -u)/com.bengillihan.chatbdg` (or bootout + bootstrap the plist again).

## 2. Architecture at a glance

One Node process (`server/index.js` → `server/app.js`) does two jobs: serves the built React SPA as static files, and exposes a small JSON API under `/api/*`. There is no separate frontend server, no reverse-proxy-within-the-app, no session store.

```
Browser (Cloudflare Access already verified the user at the edge)
   │  Cf-Access-Jwt-Assertion header on every request
   ▼
Cloudflare Tunnel → 127.0.0.1:3000 (loopback only — see §6)
   │
   ▼
Express app (server/app.js)
   ├─ identifyRequest middleware — verifies the JWT, sets req.userEmail
   ├─ /api/chat, /api/sanitize, /api/cloud-feedback, /api/incorporate
   ├─ /api/conversations, /api/conversations/:id, /api/health
   └─ static file serving of dist/ (the built React app)
   │
   ├─→ server/ollamaClient.js  → local Ollama (qwen3-church model)
   ├─→ server/geminiClient.js  → Gemini API (optional, opt-in per message)
   └─→ server/db.js            → SQLite (node:sqlite, file on disk)
```

The frontend (`src/App.jsx`) never talks to Ollama or Gemini directly and never sees provider credentials — it only calls the `/api/*` endpoints via `src/lib/api.js`. All provider selection, prompt assembly, and privacy logic lives server-side, on purpose: a client-side mistake should never be the only thing standing between a request and Gemini.

## 3. Directory map

```
server/
  index.js              thin entry point — loads .env, calls createApp(), binds to 127.0.0.1
  app.js                the actual Express app (exported as createApp() so tests can import
                         it without binding a real port — mirrors the app.js/server.js split
                         the original ChatAPS backend used)
  app.test.js           vitest + supertest suite — see §12
  config.js             validateConfig() — required env vars, fails fast at boot
  db.js                 SQLite schema, migrations, and all query/insert helpers
  ollamaClient.js        local model client (OpenAI-compatible, via the `openai` SDK)
  geminiClient.js         cloud model client (`@google/genai`)
  cfAccessAuth.js        Cloudflare Access JWT verification (JWKS-based) — see §5
  systemPrompt.js         owner's personal system prompt + the sanitized/identity-note variants
  sharedSystemPrompt.js   non-owner (Titus's) system prompt — same framework, no personal specifics
  sanitizePrompt.js       instructs the local model how to genericize a conversation
  cloudFeedbackPrompt.js  instructs Gemini to critique, not answer, a sanitized draft
  incorporatePrompt.js    instructs the local model to fold cloud feedback into the real conversation
src/
  App.jsx                the entire UI (single component tree, no router)
  App.css / index.css     styling
  lib/api.js              thin fetch wrappers for every /api endpoint
  main.jsx                React bootstrap
Modelfile                 the qwen3-church Ollama model definition (see §9)
```

There is intentionally no `src/components/` split, no state management library, no CSS framework, no test harness for the frontend. The app is small enough that one file per concern (one API module, one Express app file, one React component) is more legible than the abstraction overhead of splitting further. Don't add a component library or Redux/Zustand-style store unless the UI actually grows enough to need it.

## 4. The four ways a message can go out, and why they're different endpoints

This is the part most worth understanding before changing anything, because the whole privacy model depends on these staying separate.

### `POST /api/chat` — plain send (Local or Cloud toggle)
Rebuilds the full conversation history from SQLite (filtered — see §8), prepends a system prompt (owner's personal one or Titus's shared one, see §7), and sends it to whichever provider the UI toggle selected. **If `provider: 'cloud'`, this sends your entire conversation history and personal system prompt to Gemini.** The frontend now gates this behind an explicit confirmation dialog (`pendingCloudConfirm` in `App.jsx`) that states exactly that, because early on this was silently happening on every Cloud-toggle send with no disclosure.

### `POST /api/sanitize` — preview only, never persisted, always local
Takes a conversation's history (or raw text), asks the **local** model to rewrite it with names replaced by numbered placeholders (`Person 1`, `Person 2`, ...) rather than role descriptions. Returns the draft for the user to review/edit. This call is hardcoded to `sendOllamaChat` — it must never be reachable via Gemini, regardless of what the UI's Local/Cloud toggle is set to, because the entire point is producing something *safe* to later send to the cloud.

Numbered placeholders were a deliberate rewrite from an earlier "role description" approach (e.g. "a fellow elder") after review flagged that role descriptions are still identifying in a small church/family — "the chairman of elders" narrows things down to one person. Numbers carry no identifying signal at all.

### `POST /api/cloud-feedback` — the sanitized draft, sent to Gemini for critique
Only reachable with text the user has already seen via `/api/sanitize` and (optionally) edited. Uses `CLOUD_FEEDBACK_SYSTEM_PROMPT`, which explicitly instructs Gemini to critique the thinking, not answer as a fresh question — this is a second real use case beyond "get an answer": get an outside perspective on a sanitized version of a genuinely sensitive situation. The resulting assistant message is tagged `kind: 'cloud_feedback'`.

### `POST /api/incorporate` — fold the cloud feedback back into the real conversation, locally only
Takes `{ conversationId, feedbackMessageId }` — **not** raw feedback text (see §8 on why). Looks up the stored feedback message server-side, loads the conversation's original *unsanitized* messages, and asks the **local** model to produce a final answer using real names/specifics while incorporating the outside critique. This call never touches Gemini and never reads the Local/Cloud toggle at all — there's no `provider` field anywhere in this route, so a UI bug in the toggle literally cannot leak anything here.

**A past bug worth knowing about**: a user once typed "incorporate feedback locally" as a plain chat message and got a plausible-looking response — but that just went through `/api/chat` with whatever the toggle happened to be set to, using only the visible (possibly sanitized) conversation state, not real incorporation. The fix wasn't better prompt engineering; it was making the *button* impossible to lose track of (see §10) so there's never a reason to type it as free text.

## 5. Identity: Cloudflare Access is the entire auth boundary, verified cryptographically

There is no login screen, no session cookie, no password anywhere in this codebase. Identity comes from Cloudflare Access, which gates the tunnel hostname before any request reaches this server.

**The mistake to never repeat**: an earlier version trusted the `Cf-Access-Authenticated-User-Email` header directly. That header is attacker-controlled if anything can reach the origin without Access rewriting it — which means a real Access-authenticated user (Titus) could, via dev tools, set that header to the owner's email and get treated as the owner. `server/cfAccessAuth.js` fixes this by verifying the **signed** `Cf-Access-Jwt-Assertion` JWT against Cloudflare's published JWKS (`https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`), checking signature, `iss`, and `aud` (the specific Access application's AUD tag), and reading `email` only from the verified payload. The plaintext header is no longer read anywhere in the app.

The critical invariant in `identifyRequest` (`server/app.js`): if a `Cf-Access-Jwt-Assertion` header is present but fails verification, that's a hard `401` — **never** a silent fallback to a default identity. Only the true *absence* of any Access header (local development, not going through the tunnel) uses `DEFAULT_LOCAL_USER_EMAIL || OWNER_EMAIL`. If you ever change this logic, preserve that distinction — "invalid token" and "no token" must not be treated the same way, or the exact vulnerability this fixed comes back.

## 6. Network exposure

`server/index.js` binds to `127.0.0.1` explicitly (`app.listen(port, '127.0.0.1', ...)`), not the default (all interfaces). Without this, anyone on the local network could reach ChatBDG directly and bypass Cloudflare Access entirely — Access only protects the tunnel hostname, not the raw port. Never remove the explicit host argument from that `listen` call.

The app runs as a `launchd` service (`~/Library/LaunchAgents/com.bengillihan.chatbdg.plist`, `RunAtLoad` + `KeepAlive`, logs to `~/chatbdg/logs/`) so it survives reboots without a terminal session open. The plist sets `Umask: 63` (octal `077`) so any file the service creates — `.env`, the SQLite files — defaults to `0600`, since this machine stores real church personnel/discipline history and is also used for daily personal computing.

## 7. Two-tier system prompt, not a role system

`OWNER_EMAIL` in `.env` designates the owner. `systemPromptFor(userEmail)` in `server/app.js` is the entire "authorization" model for prompt selection: owner → `DEFAULT_SYSTEM_PROMPT` (personal — names his wife, son, employer, church, retirement date), anyone else → `SHARED_SYSTEM_PROMPT` (same theological framework and writing-style conventions, but with every personal specific removed). This is deliberately not a general role/permission system — there are two people who will ever use this app, and a two-way `===` check is the right amount of complexity for that. Don't build this out into roles/scopes/RBAC unless a third real user with different needs shows up.

**A leak this fixed**: the sanitized/cloud-feedback paths use `SANITIZED_SYSTEM_PROMPT`, not `DEFAULT_SYSTEM_PROMPT` — if they used the owner's personal prompt, the system prompt itself would re-identify the owner (name, family, employer, church) on every cloud send regardless of how well the *message* was scrubbed. Any new endpoint that talks to Gemini needs to make this same choice deliberately, not inherit `DEFAULT_SYSTEM_PROMPT` by default.

## 8. Database design choices

`server/db.js` uses `node:sqlite` (Node's built-in module), not `better-sqlite3`. This was a direct substitution after `better-sqlite3`'s native build step failed on this machine (no Xcode Command Line Tools installed, and installing them wasn't something to do without asking). `node:sqlite` requires Node 22.5+ and has no native compilation step at all — this is why `package.json` pins `"engines": { "node": ">=22.5.0" }`.

Schema notes, each tied to a specific reason:

- **`sanitized` (boolean) and `kind` (`'cloud_feedback' | 'incorporated' | null`)** on `messages` — lets the UI show what happened to any message after the fact (a "sanitized" tag, a "cloud feedback" tag, an "incorporated cloud feedback" tag) without guessing from content.
- **`status` (`'pending' | 'complete' | 'failed'`)** — the user's turn is inserted as `'pending'` *before* the provider call, then flipped to `'complete'` or `'failed'` after. Without this, a failed provider call left an orphaned user message with no reply, and a retry would duplicate it into future context. `forContext()` in `app.js` filters out anything not `'complete'` when rebuilding history for the LLM — **any new code path that rebuilds context from `getMessages()` must apply this same filter**, or a failed turn silently reappears.
- **`seq` (integer, per-conversation monotonic counter)** — `created_at` timestamps alone weren't reliable enough to guarantee ordering (millisecond collisions are possible); `getMessages()` orders by `seq`, computed as `MAX(seq)+1` inside the same transaction as the insert. Safe without locking because `DatabaseSync` is synchronous and single-writer — there's no async gap another call could land in.
- **CHECK constraints** on `role`/`provider`/`sanitized`/`kind`/`status` are in the base `CREATE TABLE`, so they only fully apply to a database created after this schema existed — SQLite's `ALTER TABLE ADD COLUMN` can't retroactively add a CHECK constraint to existing columns. Migration blocks in `initDatabase()` are guarded by `pragma_table_info` existence checks and are no-ops on a fresh database.
- **`user_email` on `conversations` + `userOwnsConversation()`/`getConversationOwner()`** — every conversation-scoped route checks ownership, and "doesn't exist" and "belongs to someone else" deliberately collapse into the same `404`. Never add a route that checks existence without also checking ownership — that's exactly how one user could enumerate another's conversation IDs.
- **`/api/incorporate` takes `feedbackMessageId`, not raw feedback text** — an earlier version took `{ conversationId, cloudFeedback: <string> }` directly from the client, meaning a modified client could feed arbitrary "feedback" into the local model's context under the guise of incorporation. Now the server looks up the actual stored message by ID and verifies it's really a `kind: 'cloud_feedback'` row belonging to that conversation.

## 9. Provider clients

**Ollama** (`server/ollamaClient.js`): talks to Ollama's OpenAI-compatible endpoint via the `openai` npm SDK, pointed at `OLLAMA_BASE_URL` with a throwaway API key (Ollama doesn't check it). Model is `qwen3-church` — a custom Ollama model (see `Modelfile`) built `FROM qwen3:14b` with `temperature 0.6`, `top_p 0.95`, `top_k 20` (Qwen3's recommended *thinking-mode* sampling params; note a single static Modelfile can't switch between thinking/non-thinking parameter sets, so if that distinction ever matters, it'd need a second model variant, not a config flag).

**Gemini** (`server/geminiClient.js`): uses `@google/genai`, not the older `@google/generative-ai` — the latter reached end-of-life in November 2025. If you ever see code or a suggestion referencing `@google/generative-ai`, `GoogleGenerativeAI`, or `model.generateContent(prompt)` (the old single-string call shape), that's the deprecated SDK; the current shape is `ai.models.generateContent({ model, contents, config })`. `GEMINI_MODEL` defaults to `gemini-3.1-flash-lite` — the `-pro` variant exists but needs billing enabled on the Google Cloud project (hit a `RESOURCE_EXHAUSTED` free-tier quota of zero when first tried); `isQuotaError()` translates that into a clear message instead of a raw API error string.

Both clients have a 120s timeout and an output-token cap (`max_tokens`/`maxOutputTokens`) — without these, a hung request or a runaway generation could tie up a request indefinitely.

## 10. Frontend state model

`src/App.jsx` has no router, no global state library — everything is `useState` in one component. A few patterns worth understanding before extending it:

- **One shared `busyAction` state**, not a separate boolean per action. Before this consolidation, "Send to Cloud," "Get Cloud Feedback," and a plain send could race against each other and double-fire on the same draft. Every action button disables whenever `busyAction` is non-null, not just its own flag.
- **`AbortController` per action**, stored in a ref, wired through `src/lib/api.js`'s `signal` passthrough. "Cancel"/"Dismiss" buttons call `.abort()` before clearing state — this is real cancellation of the in-flight fetch, not just a UI state reset.
- **Mutually exclusive panels**, chosen by an if/else-if chain: the sanitize-review panel, the raw-cloud-send confirmation bar, the incorporate bar, and the normal compose row are never shown at the same time. This is what guarantees, structurally, that a user can't type a plain message while a cloud-feedback exchange is still pending resolution.
- **The "Incorporate Locally" button's visibility is derived from message history, not tracked as an independent flag.** `deriveFeedbackFromMessages()` checks whether the *last* message in the conversation has `kind === 'cloud_feedback'`; if so, the button reappears with the right `feedbackMessageId` reconstructed from real data. This was a direct fix for a bug where reopening a conversation (or a page refresh) silently lost track of an unincorporated feedback reply, even though it was still sitting right there in the database — the earlier version just nulled a `pendingFeedback` flag unconditionally on every load. `App.jsx` also persists the active conversation ID to `localStorage` (`chatbdg:lastConversationId`) so a real browser refresh restores the same conversation instead of dropping to an empty "new chat" view; if the saved ID 404s (deleted, or belongs to a different user's session on a shared browser), it just falls back cleanly rather than erroring, since ownership is still enforced server-side regardless of what's in `localStorage`.
- **The Local/Cloud toggle always resets to Local** after any send (success or failure) and whenever a new chat starts or a conversation is reopened — cloud is never the silent ambient default beyond the one message that explicitly used it.

## 11. Configuration reference

All in `.env` (see `.env.example` for the annotated version; `.env` itself is gitignored):

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no (default 3000) | Must match the Cloudflare Tunnel's configured origin port |
| `OLLAMA_BASE_URL` | yes | Ollama's OpenAI-compatible endpoint |
| `OLLAMA_MODEL` | yes | `qwen3-church` |
| `DATABASE_PATH` | yes | SQLite file path |
| `OWNER_EMAIL` | yes | Determines who gets the personal vs. shared system prompt, and who owns pre-migration conversations |
| `DEFAULT_LOCAL_USER_EMAIL` | no | Identity used ONLY when no Access JWT is present at all (local dev); defaults to `OWNER_EMAIL` |
| `CF_ACCESS_TEAM_DOMAIN` | yes | Your Zero Trust team domain — used to fetch Cloudflare's JWKS for JWT verification |
| `CF_ACCESS_AUD` | yes | The specific Access application's Audience tag — without this, a token valid for some *other* Access app under the same team could be replayed against this one |
| `GEMINI_API_KEY` | no | Only needed to use the Cloud toggle/Get Cloud Feedback at all |
| `GEMINI_MODEL` | no (default `gemini-3.1-flash-lite`) | See §9 on why not `-pro` by default |

`config.js`'s `validateConfig()` fails fast at boot if any required var is missing — this is deliberate; a service silently running with, say, no `CF_ACCESS_AUD` would silently disable audience-scoping in JWT verification, which is exactly the kind of misconfiguration that should be loud, not quiet.

## 12. Testing

`server/app.test.js` (vitest + supertest) mocks `ollamaClient.js`, `geminiClient.js`, and `cfAccessAuth.js` and exercises the real Express app (via `createApp()`, no port binding). It's specifically a **privacy/security boundary** test suite, not general coverage — it asserts things like "sanitized cloud sends never contain prior history or the personal system prompt," "incorporate never calls Gemini," "a forged Access token gets a hard 401 and never falls back to a default identity," and "a spoofed plaintext email header alongside a real-but-different verified token doesn't work." If you add a new endpoint that touches conversation history or a provider client, add a test here proving what it does and doesn't send, following the existing pattern (`vi.hoisted` mocks + inspecting `mock.calls[n][0]`).

**Known gap**: there is no frontend test harness (no jsdom/React Testing Library set up). Frontend-only behaviors — the toggle reset, the derived-from-history button visibility, the AbortController wiring — are verified by direct reasoning through the code and by exercising the underlying API behavior live, not by an automated frontend test. This is a real gap, not an oversight to ignore if the frontend grows more complex.

Run tests: `npm test`. Run the build: `npm run build`. There's no CI configured — verification in this project has consistently meant restarting the real `launchd` service and hitting it with real `curl` requests (including simulated Access headers for multi-user testing) rather than trusting mocks alone for anything security-relevant.

## 13. Known limitations / explicitly deferred

- **Shared infrastructure across users**: both the owner and Titus share the same Ollama compute and the same Gemini API key/quota. This is intentional (two family members, not worth per-user quota tracking) but means heavy simultaneous use could contend for local model resources, and all Gemini spend is attributed to one shared key regardless of who triggered it.
- **A real end-to-end Access login has not been tested from this environment** — JWT verification logic is covered by mocked tests and live-verified to *reject* forged/invalid tokens, but no interactive Cloudflare Access login has been completed here to confirm the full success path in production. Worth doing once as a real login, by each user, after any change to `cfAccessAuth.js`.
- **No automated reboot test** — the `launchd` service is registered and verified running (`launchctl list`), but nobody has actually rebooted the Mac mini to confirm `RunAtLoad` behaves as expected across a full restart, not just a login.
- **No frontend test harness** (§12).
- **No streaming** — responses arrive as a single complete payload, not token-by-token. Both provider clients support streaming upstream; it was never wired up, since it wasn't a priority for the conversational volume this app sees.

## 14. Quick invariant checklist for future changes

If you're an agent picking this codebase back up, these are the things that are easy to accidentally break:

1. Never let a sanitized/cloud-feedback/incorporate code path use `DEFAULT_SYSTEM_PROMPT` or full conversation history without deliberately deciding to (§4, §7).
2. Never add a conversation-scoped route that checks existence without also checking `userOwnsConversation()` (§8).
3. Never treat "Access JWT present but invalid" the same as "no Access JWT at all" — the first must be a hard rejection (§5).
4. Never trust `Cf-Access-Authenticated-User-Email` for anything — it's not read anywhere in the app on purpose (§5).
5. Any new code that rebuilds LLM context from `getMessages()` needs the same `status !== 'failed'` filtering `forContext()` already does (§8).
6. Keep `app.listen` bound to `127.0.0.1` explicitly (§6).
7. If you add a new action that mutates conversation state from the frontend, route it through the shared `busyAction`/`AbortController` pattern rather than its own independent loading flag (§10).
