# Device testing (Phase 6)

Recorded by hand during Phase 6, before M0 (from the original README). The numbers are anecdotal, not a measured baseline (see `docs/metrics.md`).


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

## How to reproduce

1. `pnpm build && pnpm start`, open the site over HTTPS (or localhost).
2. Start a new interview with a language other than English and confirm the first
   spoken question is in that language.
3. On the chat page, check the provider pill ("Gemini Live" / "Browser speech") and the
   per-turn latency pill.
4. To force the fallback, temporarily revoke the key (503 from `/api/voice/session`) —
   the page should announce the fallback and continue with browser speech.
