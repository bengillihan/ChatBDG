# ChatBDG

A personal chat web app for Bible study lesson prep, sermon/communion meditation drafting, and church governance writing. Talks to a local Ollama model over its OpenAI-compatible API — nothing leaves the machine it runs on except the chat UI traffic itself.

## Requirements

- Node.js 22.5+ (uses the built-in `node:sqlite` module — no native build step, no Xcode Command Line Tools required)
- [Ollama](https://ollama.com) running locally with a `qwen3-church` model available (`ollama list` to check)

## Setup

```sh
cp .env.example .env
npm install
npm run build
npm start
```

The app serves on `http://localhost:3000` by default (see `.env`).

## Development

Run the API and the Vite dev server side by side:

```sh
npm start      # Express API + static server on :3000
npm run dev    # Vite dev server on :5173, proxies /api to :3000
```

## Configuration

All config lives in `.env`:

| Variable | Description |
| --- | --- |
| `PORT` | Port the app listens on (default `3000`, matches the Cloudflare Tunnel config) |
| `OLLAMA_BASE_URL` | Ollama's OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1` |
| `OLLAMA_MODEL` | Model name to call, e.g. `qwen3-church` |
| `DATABASE_PATH` | SQLite file path for conversation history |

The default system prompt lives in `server/systemPrompt.js` — edit it directly to change tone, theological framing, or formatting conventions.

## Deployment

Intended to run behind an existing Cloudflare Tunnel with Cloudflare Access gating the hostname (one-time-PIN login) — the app itself has no login screen or auth check, since Access is expected to gate all traffic before it reaches this server.
