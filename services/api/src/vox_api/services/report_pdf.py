"""Minimal, dependency-free PDF writer for interview reports (port of apps/web report.pdf route).

Core PDF text operators only, Helvetica and Helvetica-Bold, A4. Text is
sanitised to printable ASCII, so non-Latin scripts render as "?" (known gap,
docs/backlog.md).
"""

import re
from dataclasses import dataclass

from vox_api.models import Interview, InterviewQa

PAGE_W, PAGE_H, MARGIN = 595, 842, 56


@dataclass(frozen=True)
class Line:
    text: str
    size: int
    bold: bool = False
    gap: int = 0


def escape_pdf_text(s: str) -> str:
    s = re.sub(r"[\u2018\u2019]", "'", s)
    s = re.sub(r"[\u201c\u201d]", '"', s)
    s = re.sub(r"[\u2013\u2014]", "-", s)
    s = re.sub(r"[^\x20-\x7E]", "?", s)
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def wrap(text: str, size: int, width: float) -> list[str]:
    chars_per_line = int(width // (size * 0.5))
    lines: list[str] = []
    line = ""
    for w in re.split(r"\s+", text):
        if len((line + " " + w).strip()) > chars_per_line:
            lines.append(line.strip())
            line = w
        else:
            line += " " + w
    if line.strip():
        lines.append(line.strip())
    return lines or [""]


def build_pdf(lines: list[Line]) -> bytes:
    usable_w = PAGE_W - MARGIN * 2
    pages: list[list[str]] = []
    current: list[str] = []
    y = PAGE_H - MARGIN
    for ln in lines:
        wrapped = wrap(ln.text, ln.size, usable_w)
        for i, text in enumerate(wrapped):
            line_h = ln.size + 6
            if y - line_h < MARGIN:
                pages.append(current)
                current = []
                y = PAGE_H - MARGIN
            font = "/F2" if ln.bold and i == 0 else "/F1"
            current.append(f"BT {font} {ln.size} Tf {MARGIN} {y} Td ({escape_pdf_text(text)}) Tj ET")
            y -= line_h + ln.gap
    if current or not pages:
        pages.append(current)

    first_page_obj = 4
    page_ids = [first_page_obj + i * 2 for i in range(len(pages))]
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{' '.join(f'{pid} 0 R' for pid in page_ids)}] /Count {len(pages)} >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    bold_font_obj = first_page_obj + len(pages) * 2
    for i, content in enumerate(pages):
        content_id = first_page_obj + i * 2 + 1
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources << /Font << /F1 3 0 R /F2 {bold_font_obj} 0 R >> >> /Contents {content_id} 0 R >>"
        )
        stream = "\n".join(content)
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
    objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")

    pdf = "%PDF-1.4\n"
    offsets: list[int] = []
    for i, body in enumerate(objects):
        offsets.append(len(pdf))
        pdf += f"{i + 1} 0 obj\n{body}\nendobj\n"
    xref_start = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    pdf += "".join(f"{off:010d} 00000 n \n" for off in offsets)
    pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF"
    return pdf.encode("latin-1")


def report_pdf(interview: Interview, qa: list[InterviewQa]) -> bytes:
    report = interview.report or {}
    per_question = report.get("perQuestion") or []
    lines = [
        Line("Vox Interview Report", 20, bold=True, gap=6),
        Line(
            f"{interview.role} - {interview.level} - {interview.created_at.strftime('%a %b %d %Y')}",
            11,
            gap=14,
        ),
        Line(f"Overall score: {float(report.get('overall', 0)):.1f} / 10", 14, bold=True, gap=10),
        Line(str(report.get("summary", "")), 11, gap=14),
        Line("Strengths", 14, bold=True, gap=6),
        *(Line(f"- {s}", 11, gap=2) for s in report.get("strengths", [])),
        Line("Gaps", 14, bold=True, gap=6),
        *(Line(f"- {g}", 11, gap=2) for g in report.get("gaps", [])),
        Line("", 11),
        Line("Question by question", 14, bold=True, gap=10),
    ]
    for i, q in enumerate(qa):
        score = (q.evaluation or {}).get("score", "-")
        lines += [
            Line(f"Q{i + 1}. {q.question_text}", 12, bold=True, gap=4),
            Line(f"Answer: {q.answer_text}", 10, gap=2),
            Line(f"Score: {score} / 10", 10, gap=2),
        ]
        better = per_question[i].get("better_answer") if i < len(per_question) else None
        lines.append(Line(f"Better answer: {better}", 10, gap=10) if better else Line("", 10, gap=10))
    return build_pdf(lines)
