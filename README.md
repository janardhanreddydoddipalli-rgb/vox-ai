# Vox — voice assistant

A browser voice bot: you talk into your microphone, it transcribes live, replies out loud
with **Gemini Flash**, and saves every turn to SQLite.

Speech capture and playback use the browser's built-in Web Speech API (Chrome, Edge and
Android Chrome). The reply text is generated server-side by Google's Gemini API, so no
speech-to-text or text-to-speech key is needed — only a Gemini API key for the answers.

## Requirements

- Node.js 18+ (built and tested on Node 24)
- A microphone and speakers, in a browser with the Web Speech API
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Quick start

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000, tap **Start talking**, allow the microphone, and speak.
Your transcript appears live; the reply is spoken aloud.

For development with hot reload:

```bash
npm run dev
```

## Configuration

| Variable         | Required | Purpose                                                        |
| ---------------- | -------- | -------------------------------------------------------------- |
| `GEMINI_API_KEY` | No       | Enables Gemini replies. Without it the bot uses simple local fallback answers. |

Create `.env.local` in the project root (this file is gitignored):

```
GEMINI_API_KEY=your-key-here
```

Next.js loads `.env*` files into `process.env` automatically for Route Handlers; the key
is server-only because it has no `NEXT_PUBLIC_` prefix. The model is set as `MODEL` in
`src/app/api/chat/route.ts` (currently `gemini-3.5-flash`).

## API reference

### `GET /api/chat`

Reports which brain is live.

```json
{"engine":"gemini","model":"gemini-3.5-flash"}
```

`engine` is `"gemini"` when `GEMINI_API_KEY` is set, `"browser"` otherwise.

### `POST /api/chat`

Generates the spoken reply.

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"userText":"What is the capital of Australia?"}'
```

```json
{"reply":"The capital of Australia is Canberra.","engine":"gemini"}
```

Request body:

| Field     | Type                          | Notes                                          |
| --------- | ----------------------------- | ---------------------------------------------- |
| `userText`  | string                      | Required. What the user said.                  |
| `history`   | `{role, text}[]` (optional) | Last turns for context; only the final 8 are used. |

### `POST /api/turns`

Persists a session's turns to SQLite (`data/voicebot.db`). Requires `sessionId` and
`turns`; `mode` labels the engine used (`"gemini"` or `"browser"`).

### `GET /api/turns`

Lists past sessions with their turns and per-turn latency.

## How it works

- `src/lib/voice-engine.ts` — runs in the browser: microphone capture, live mic level,
  SpeechRecognition for transcription, speechSynthesis for playback, and the fetch to
  `/api/chat` with conversation history.
- `src/app/api/chat/route.ts` — server route that calls
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`
  with a spoken-style system instruction, and answers with short sentences.
- `src/lib/db.ts` — SQLite (better-sqlite3) schema and queries for sessions and turns.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "This browser has no Web Speech API" | Use Chrome or Edge. Firefox and Safari desktop do not ship SpeechRecognition. |
| Replies start with "I'm running without a Gemini key" | `GEMINI_API_KEY` is not set in `.env.local`, or the server was started before you added it. Restart `npm start` after editing `.env.local`. |
| `Could not find a production build` from `npm start` | Run `npm run build` first. |
| Gemini replies stop and fall back | Check the server log for a `Gemini generateContent failed` line with the HTTP status; free-tier rate limits and busy-model responses are logged there. |
| Microphone blocked | Browsers only grant mic access on `localhost` or HTTPS. |

## Verified with

- `npm run build` and `npx tsc --noEmit` pass.
- `curl http://localhost:3000/api/chat` returns `{"engine":"gemini","model":"gemini-3.5-flash"}`.
- A live POST with the body above returned a real Gemini reply ("The capital of Australia is Canberra.").
