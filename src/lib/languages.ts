// Interview language support (Phase 6): the chosen language drives the
// spoken questions, the live/browser speech synthesis, and the final report.

export const INTERVIEW_LANGUAGES = [
  { code: "en", label: "English", speechTag: "en-US" },
  { code: "hi", label: "हिन्दी (Hindi)", speechTag: "hi-IN" },
  { code: "ta", label: "தமிழ் (Tamil)", speechTag: "ta-IN" },
  { code: "te", label: "తెలుగు (Telugu)", speechTag: "te-IN" },
] as const;

export type LanguageCode = (typeof INTERVIEW_LANGUAGES)[number]["code"];

export function isLanguageCode(v: string): v is LanguageCode {
  return INTERVIEW_LANGUAGES.some((l) => l.code === v);
}

export function languageName(code: string): string {
  return INTERVIEW_LANGUAGES.find((l) => l.code === code)?.label.split(" ")[0] ?? "English";
}

// BCP-47 tag for SpeechRecognition / SpeechSynthesis.
export function speechTag(code: string): string {
  return INTERVIEW_LANGUAGES.find((l) => l.code === code)?.speechTag ?? "en-US";
}

// Directive appended to the interviewer prompt so questions, follow-ups and
// the spoken report all come out in the chosen language.
export function languageDirective(code: string): string {
  const name = languageName(code);
  return `\n\nLANGUAGE: Conduct this entire interview in ${name}. Ask every question and follow-up in ${name}, and write the final report summary, strengths, gaps and better sample answers in ${name}. Keep technical terms in English where that is the industry norm.`;
}
