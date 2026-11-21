"""Model provider boundary: a protocol plus implementations (Gemini, and Fake for tests)."""

from vox_api.core.config import Settings
from vox_api.llm.base import LLMProvider
from vox_api.llm.gemini import GeminiProvider


def build_llm(settings: Settings) -> LLMProvider | None:
    """Gemini when a key is configured; None means model features are unavailable."""
    if settings.gemini_api_key is None or not settings.gemini_api_key.get_secret_value().strip():
        return None
    return GeminiProvider(
        settings.gemini_api_key.get_secret_value().strip(),
        settings.gemini_model,
        settings.gemini_embedding_model,
    )
