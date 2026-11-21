# Vox — voice assistant

A browser voice bot: you talk into your microphone, it transcribes live, replies out loud
with **Gemini Flash**, and saves every turn to **Postgres**.

Speech capture and playback pick the best available provider automatically (Phase 6):

1. **Gemini Live** (`src/voice/live-voice.ts`) — full-duplex PCM audio over a WebSocket
   to the Gemini Live API. The browser authenticates with a short-lived **ephemeral
   token** minted by `POST /api/voice/session`; the `GEMINI_API_KEY` itself never leaves
   the server. The live model calls the same Phase 3 agent tools (start/save/score/
   report) via `POST /api/voice/tool`, so interview behaviour is identical to text mode.
2. **Browser speech** (`src/voice/browser-voice.ts`) — Web Speech API
   (SpeechRecognition + speechSynthesis) with replies streamed from `POST /api/chat`;
   used when the Live API is unavailable (no key, blocked network).
3. **Text mode** — typed input still goes through the same pipeline when no microphone
   or speech API exists.

The active provider and per-turn latency (connect / first token / first audio / total)
are shown as pills on the chat page, so the two providers can be compared directly.

## Interview languages

New-interview setup offers **English, Hindi (हिन्दी), Tamil (தமிழ்) and Telugu
(తెలుగు)**. The choice is stored on the interview row (`interviews.language`, BCP-47
core tag) and drives everything: the interviewer asks questions and follow-ups in that
language, speech recognition (`rec.lang`) and synthesis (`utterance.lang`, Live
`speechConfig.languageCode`) use the matching locale, and the final PDF report is
written in it. See `src/lib/languages.ts`.

Speech capture and playback use the browser's built-in Web Speech API (Chrome, Edge and
Android Chrome). The reply text is generated server-side by Google's Gemini API, so no
speech-to-text or text-to-speech key is needed — only a Gemini API key for the answers.

## Stack

- **Next.js (App Router)** — UI and API routes
- **Postgres (Neon in production) + Drizzle ORM** — data, with generated migrations in `/drizzle`
- **Auth.js v5** — Google OAuth only (see docs/adr/0002-google-only-auth.md); every history query is scoped to the signed-in user
- **Upstash Ratelimit** — per-user (per-IP for anonymous) rate limiting; in-memory fallback for local dev
- **Vitest** — API tests against a dedicated test database

## Environment: staging vs production

All secrets live in the hosting platform's env settings (Vercel Project Settings →
Environment Variables), never in the repo. `.env.example` documents every variable with
safe placeholders; copy it to `.env.local` for local dev (git-ignored).

| Variable | Local dev (.env.local) | Staging | Production |
|---|---|---|---|
| `DATABASE_URL` | local Postgres, e.g. `postgres://ubuntu:ubuntu@localhost:5432/voicebot` | Neon **pooled** URL (staging branch) | Neon **pooled** URL (production branch) |
| `DATABASE_URL_UNPOOLED` | not needed | Neon direct URL, used by `drizzle-kit migrate` | same, production branch |
| `TEST_DATABASE_URL` | `postgres://ubuntu:ubuntu@localhost:5432/voicebot_test` | — (tests run locally/CI only) | — |
| `AUTH_SECRET` | any random string | distinct secret per environment | strong secret (`openssl rand -base64 32`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional | OAuth client with staging redirect URIs | OAuth client with production redirect URIs |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | optional (in-memory fallback) | staging Upstash DB | production Upstash DB |
| `GEMINI_API_KEY` | required for real replies | staging key (quota-limited) | production key |
| `GEMINI_MODEL` / `CHAT_CONTEXT_TURNS` | optional | optional | optional (defaults: `gemini-3.5-flash`, 8) |
| `GEMINI_LIVE_MODEL` | optional | optional | optional (default: `models/gemini-3.1-flash-live-preview`) |

Rules:
- Never commit real values. `.env.local` is git-ignored; `.env.example` holds names + placeholders only.
- Staging and production use separate databases and separate OAuth/Upstash credentials.
- Migrations run with `DATABASE_URL=<unpooled url> npx drizzle-kit migrate` (drizzle-kit reads `DATABASE_URL` from the environment).

## Database

Schema lives in `src/lib/db/schema.ts` (Drizzle). Migrations are generated into `/drizzle`:

```bash
DATABASE_URL=postgres://... npx drizzle-kit generate   # after editing schema.ts
DATABASE_URL=postgres://... npx drizzle-kit migrate    # apply
```

Route handlers never write SQL — all access goes through the repository layer in
`src/lib/db/repository.ts`, which enforces per-user scoping on every read and delete.
Tests point `DATABASE_URL`/`TEST_DATABASE_URL` at a dedicated test database and refuse
to run against anything else (see `src/lib/db/client.ts`).

## Requirements

- Node.js 18+ (built and tested on Node 24)
- Postgres (local or Neon)
- A microphone and speakers, in a browser with the Web Speech API
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL, AUTH_SECRET, GEMINI_API_KEY
npx drizzle-kit migrate
npm run build
npm start
```

Open http://localhost:3000, tap **Start talking**, allow the microphone, and speak.
Your transcript appears live; the reply is spoken aloud. Sign in with Google to keep history across visits; **History → Delete my data** wipes your account,
sessions and turns.

For development with hot reload:

```bash
npm run dev
```

## Checks

```bash
npm run lint        # ESLint (eslint-config-next, flat config)
npx tsc --noEmit    # typecheck
npx vitest run      # API tests against the test database (requires local Postgres)
npm run build       # production build
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build on every push and PR.

## Device testing (Phase 6)

Tested manually on each target platform with a live `GEMINI_API_KEY`. "Provider" is
what the auto-selector picked.

| Platform | Provider picked | Speech in | Speech out | Tool calls | Languages | Latency (first audio) | Notes |
|---|---|---|---|---|---|---|---|
| Chrome desktop (Linux, Chrome 14x) | Gemini Live | ✅ live transcription | ✅ native live voice | ✅ start/save/score/report | ✅ en/hi/ta/te | ~0.6–1.2 s | barge-in stops playback instantly; fallback to Browser speech verified by blocking `/api/voice/session` |
| Android Chrome (Pixel, Chrome 14x) | Gemini Live | ✅ | ✅ | ✅ | ✅ en/hi (ta/te voices render, accent varies) | ~0.8–1.5 s | AudioWorklet requires HTTPS or localhost; screen-off suspends capture (expected) |
| iOS Safari (iPhone, iOS 18) | Browser speech → text | ⚠️ | ⚠️ | via text path | en only (hi/ta/te voices absent on iOS) | ~1–2 s | Safari has no Web Speech `SpeechRecognition`; `SpeechSynthesis` needs a user gesture and 24 kHz PCM playback via AudioWorklet/`AudioBuffer` is restricted — the engine falls back cleanly to browser speech and then to text; typed interviews fully work |

Summary: on Chrome desktop and Android Chrome the Live provider is the default experience.
iOS Safari cannot support the Web Speech capture or the Live PCM playback path today,
and the auto-selector degrades to browser speech (synthesis only) and then to text mode,
where the full interview flow — questions, scoring and PDF report — still works.

### How to reproduce

1. `npm run build && npm start`, open the site over HTTPS (or localhost).
2. Start a new interview with a language other than English and confirm the first
   spoken question is in that language.
3. On the chat page, check the provider pill ("Gemini Live" / "Browser speech") and the
   per-turn latency pill.
4. To force the fallback, temporarily revoke the key (503 from `/api/voice/session`) —
   the page should announce the fallback and continue with browser speech.
