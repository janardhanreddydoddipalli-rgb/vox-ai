import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { upsertUserByEmail, getInterview, listInterviewQa } from "@/lib/db";

// Minimal, dependency-free PDF writer: one page per chunk of report content
// using only core PDF text operators. Text is Latin-1 sanitized.
function escapePdfText(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

type Line = { text: string; size: number; bold?: boolean; gap?: number };

function wrap(text: string, size: number, width: number): string[] {
  const charsPerLine = Math.floor(width / (size * 0.5));
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > charsPerLine) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.length ? lines : [""];
}

function buildPdf(lines: Line[]): Uint8Array {
  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 56;
  const usableW = PAGE_W - MARGIN * 2;
  // Lay out lines into pages.
  const pages: string[][] = [];
  let current: string[] = [];
  let y = PAGE_H - MARGIN;
  for (const l of lines) {
    const wrapped = wrap(l.text, l.size, usableW);
    for (let i = 0; i < wrapped.length; i++) {
      const lineH = l.size + 6;
      if (y - lineH < MARGIN) {
        pages.push(current);
        current = [];
        y = PAGE_H - MARGIN;
      }
      const font = l.bold && i === 0 ? "/F2" : "/F1";
      current.push(`BT ${font} ${l.size} Tf ${MARGIN} ${y} Td (${escapePdfText(wrapped[i])}) Tj ET`);
      y -= lineH + (l.gap ?? 0);
    }
  }
  if (current.length || pages.length === 0) pages.push(current);

  const objects: string[] = [];
  const pageIds: number[] = [];
  const firstPageObj = 4;
  pages.forEach((_, i) => pageIds.push(firstPageObj + i * 2));

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((content, i) => {
    const contentId = firstPageObj + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 ${firstPageObj + pages.length * 2} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const stream = content.join("\n");
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  // Bold font object last.
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const iv = await getInterview(id, user.id);
  if (!iv || !iv.report) return NextResponse.json({ error: "Report not found" }, { status: 404 });
  const qa = await listInterviewQa(id);

  const report = iv.report;
  const lines: Line[] = [
    { text: "Vox Interview Report", size: 20, bold: true, gap: 6 },
    { text: `${iv.role} - ${iv.level} - ${new Date(iv.createdAt).toDateString()}`, size: 11, gap: 14 },
    { text: `Overall score: ${report.overall.toFixed(1)} / 10`, size: 14, bold: true, gap: 10 },
    { text: report.summary, size: 11, gap: 14 },
    { text: "Strengths", size: 14, bold: true, gap: 6 },
    ...report.strengths.map((s) => ({ text: `- ${s}`, size: 11, gap: 2 })),
    { text: "Gaps", size: 14, bold: true, gap: 6 },
    ...report.gaps.map((g) => ({ text: `- ${g}`, size: 11, gap: 2 })),
    { text: "", size: 11 },
    { text: "Question by question", size: 14, bold: true, gap: 10 },
  ];
  qa.forEach((q, i) => {
    lines.push({ text: `Q${i + 1}. ${q.questionText}`, size: 12, bold: true, gap: 4 });
    lines.push({ text: `Answer: ${q.answerText}`, size: 10, gap: 2 });
    lines.push({ text: `Score: ${q.evaluation?.score ?? "-"} / 10`, size: 10, gap: 2 });
    const better = report.perQuestion?.[i]?.better_answer;
    if (better) lines.push({ text: `Better answer: ${better}`, size: 10, gap: 10 });
    else lines.push({ text: "", size: 10, gap: 10 });
  });

  const pdf = buildPdf(lines);
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="vox-interview-${id.slice(0, 8)}.pdf"`,
    },
  });
}
