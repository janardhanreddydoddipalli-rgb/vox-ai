// Resume parsing: extract text from a PDF server-side (unpdf, pure JS —
// works on serverless), then ask Gemini for structured skills/projects/
// experience. Falls back to an unstructured parse when Gemini is unavailable;
// the raw text is always stored so read_resume still works.
import { extractText, getDocumentProxy } from "unpdf";
import { GEMINI_MODEL } from "@/lib/config";

export type ParsedResume = {
  skills: string[];
  projects: { name: string; summary: string }[];
  experience: { company: string; role: string; period: string | null }[];
};

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  return merged.replace(/\u0000/g, " ").trim().slice(0, 40000);
}

function geminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key || null;
}

export async function parseResumeStructure(rawText: string): Promise<ParsedResume> {
  const key = geminiKey();
  if (!key) return heuristicParse(rawText);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "Extract from this resume: skills (short names), projects (name + one-sentence summary), " +
                  "experience (company, role, period if present). Resume text:\n\n" +
                  rawText.slice(0, 12000),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              skills: { type: "array", items: { type: "string" } },
              projects: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, summary: { type: "string" } },
                  required: ["name", "summary"],
                },
              },
              experience: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    company: { type: "string" },
                    role: { type: "string" },
                    period: { type: "string", nullable: true },
                  },
                  required: ["company", "role"],
                },
              },
            },
            required: ["skills", "projects", "experience"],
          },
        },
      }),
    });
    if (!res.ok) return heuristicParse(rawText);
    const data = await res.json();
    const text: string = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(text);
    return {
      skills: Array.isArray(parsed.skills) ? parsed.skills.slice(0, 50).map(String) : [],
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.slice(0, 20).map((p: { name?: unknown; summary?: unknown }) => ({
            name: String(p.name ?? "Untitled project"),
            summary: String(p.summary ?? ""),
          }))
        : [],
      experience: Array.isArray(parsed.experience)
        ? parsed.experience.slice(0, 20).map((e: { company?: unknown; role?: unknown; period?: unknown }) => ({
            company: String(e.company ?? "Unknown"),
            role: String(e.role ?? ""),
            period: e.period == null ? null : String(e.period),
          }))
        : [],
    };
  } catch (err) {
    console.error("resume structure parse failed; falling back", err);
    return heuristicParse(rawText);
  }
}

// No-key fallback: line heuristics so the resume is still usable.
function heuristicParse(rawText: string): ParsedResume {
  const lines = rawText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const skillLine = lines.find((l) => /skill/i.test(l));
  const projectLine = lines.find((l) => /project/i.test(l));
  return {
    skills: skillLine ? skillLine.replace(/.*skills?:?/i, "").split(/[,•|]/).map((s) => s.trim()).filter(Boolean).slice(0, 30) : [],
    projects: projectLine ? [{ name: "Resume projects", summary: projectLine.slice(0, 300) }] : [],
    experience: [],
  };
}
