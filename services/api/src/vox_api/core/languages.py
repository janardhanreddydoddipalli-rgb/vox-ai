"""Interview languages (mirrors apps/web src/lib/languages.ts)."""

INTERVIEW_LANGUAGES: dict[str, str] = {
    "en": "English",
    "hi": "हिन्दी",
    "ta": "தமிழ்",
    "te": "తెలుగు",
}


def language_name(code: str) -> str:
    return INTERVIEW_LANGUAGES.get(code, "English")
