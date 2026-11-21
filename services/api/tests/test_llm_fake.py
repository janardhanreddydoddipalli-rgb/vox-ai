import math

from vox_api.llm.base import LLMProvider, Message
from vox_api.llm.fake import FakeProvider
from vox_api.models.memory import EMBEDDING_DIMENSIONS

MSGS = [Message("user", "What is connection pooling?")]


def test_fake_satisfies_the_provider_protocol() -> None:
    assert isinstance(FakeProvider(), LLMProvider)


async def test_generate_uses_scripted_replies_then_echoes() -> None:
    llm = FakeProvider(replies=["Scripted answer."])
    first = await llm.generate(MSGS, system="Be brief.")
    second = await llm.generate(MSGS)
    assert first.text == "Scripted answer."
    assert second.text == "echo: What is connection pooling?"
    assert first.tokens_in > 0
    assert first.tokens_out > 0
    assert len(llm.calls) == 2


async def test_stream_yields_the_reply_in_order() -> None:
    chunks = [c async for c in FakeProvider(replies=["one two three"]).stream(MSGS)]
    assert "".join(c.text for c in chunks) == "one two three"
    assert len(chunks) == 3
    assert chunks[-1].tokens_out == 3  # usage arrives on the last chunk


async def test_embeddings_are_deterministic_unit_vectors_of_the_right_size() -> None:
    llm = FakeProvider()
    [a1, b1] = await llm.embed(["alpha", "beta"], task="RETRIEVAL_DOCUMENT")
    [a2] = await llm.embed(["alpha"], task="RETRIEVAL_DOCUMENT")
    [a_query] = await llm.embed(["alpha"], task="RETRIEVAL_QUERY")
    assert len(a1) == EMBEDDING_DIMENSIONS
    assert math.isclose(math.sqrt(sum(x * x for x in a1)), 1.0, rel_tol=1e-9)
    assert a1 == a2
    assert a1 != b1
    assert a1 != a_query  # task type changes the vector, as with the real API
