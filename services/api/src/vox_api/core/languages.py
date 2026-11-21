"""Interview languages (mirrors apps/web src/lib/languages.ts)."""

INTERVIEW_LANGUAGES: dict[str, str] = {
    "en": "English",
    "hi": "हिन्दी",
    "ta": "தமிழ்",
    "te": "తెలుగు",
}


def language_name(code: str) -> str:
    return INTERVIEW_LANGUAGES.get(code, "English")


def language_directive(code: str) -> str:
    name = language_name(code)
    return (
        f"\n\nLANGUAGE: Conduct this entire interview in {name}. Ask every question and follow-up in {name}, "
        f"and write the final report summary, strengths, gaps and better sample answers in {name}. "
        "Keep technical terms in English where that is the industry norm."
    )
