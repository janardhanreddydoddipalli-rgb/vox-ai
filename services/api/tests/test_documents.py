"""Pure helpers: PDF writer, chunking, résumé heuristics (ports of the web versions)."""

import re

from vox_api.rag.ingest import chunk_text
from vox_api.services.report_pdf import Line, build_pdf, escape_pdf_text
from vox_api.services.resume import extract_pdf_text, heuristic_parse


def test_pdf_xref_offsets_point_at_their_objects() -> None:
    pdf = build_pdf([Line("Title", 20, bold=True), *[Line(f"line {i}", 11) for i in range(200)]])
    text = pdf.decode("latin-1")
    start = int(text.rsplit("startxref\n", 1)[1].split("\n")[0])
    assert text[start:].startswith("xref")
    offsets = [int(m) for m in re.findall(r"^(\d{10}) 00000 n $", text, re.M)]
    for i, off in enumerate(offsets, start=1):
        assert text[off:].startswith(f"{i} 0 obj")
    pages = int(re.search(r"/Count (\d+)", text).group(1))  # type: ignore[union-attr]
    assert pages > 1  # 200 lines overflow one A4 page


def test_pdf_text_is_escaped_and_ascii_only() -> None:
    assert escape_pdf_text("a (b) \\ \u2018q\u2019 \u2014 हि") == "a \\(b\\) \\\\ 'q' - ??"


def test_pdf_round_trips_through_text_extraction() -> None:
    assert "Skills: Python, SQL" in extract_pdf_text(build_pdf([Line("Skills: Python, SQL", 11)]))


def test_chunking_keeps_paragraphs_and_splits_long_ones() -> None:
    long_para = " ".join(f"Sentence number {i} is here." for i in range(80))
    chunks = chunk_text(f"Short intro paragraph here.\n\n{long_para}")
    assert all(len(c) <= 900 + 40 for c in chunks)
    assert chunks[0].startswith("Short intro paragraph here.")
    assert len(chunks) >= 3
    assert chunk_text("   ") == []
    assert chunk_text("too short") == []


def test_resume_heuristic() -> None:
    parsed = heuristic_parse("Ada\nSkills: Python, SQL | Go\nProjects: Vox voice app")
    assert parsed.skills == ["Python", "SQL", "Go"]
    assert parsed.projects == [{"name": "Resume projects", "summary": "Projects: Vox voice app"}]
