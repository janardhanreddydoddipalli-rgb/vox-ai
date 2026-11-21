# Vox — voice assistant

A browser voice bot: you talk into your microphone, it transcribes live, replies out loud
with **Gemini Flash**, and saves every turn to **Postgres**.

Speech capture and playback use the browser's built-in Web Speech API (Chrome, Edge and
Android Chrome). The reply text is generated server-side by Google's Gemini API, so no
speech-to-text or text-to-speech key is needed — only a Gemini API key for the answers.

## Stack

- **Next.js (App Router)** — UI and API routes
- **Postgres (Neon in production) + Drizzle ORM** — data, with generated migrations in `/drizzle`
- **Auth.js v5** — Google OAuth + email magic link (Resend); every history query is scoped to the signed-in user
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
| `RESEND_API_KEY` / `EMAIL_FROM` | optional | Resend staging key | Resend production key |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | optional (in-memory fallback) | staging Upstash DB | production Upstash DB |
| `GEMINI_API_KEY` | required for real replies | staging key (quota-limited) | production key |
| `GEMINI_MODEL` / `CHAT_CONTEXT_TURNS` | optional | optional | optional (defaults: `gemini-3.5-flash`, 8) |

Rules:
- Never commit real values. `.env.local` is git-ignored; `.env.example` holds names + placeholders only.
- Staging and production use separate databases and separate OAuth/Resend/Upstash credentials.
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
Your transcript appears live; the reply is spoken aloud. Sign in (Google or email magic
link) to keep history across visits; **History → Delete my data** wipes your account,
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
