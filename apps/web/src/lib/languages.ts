// Interview languages offered in setup. services/api turns the chosen code into
// the interviewer's language directive and the report language.

export const INTERVIEW_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "ta", label: "தமிழ் (Tamil)" },
  { code: "te", label: "తెలుగు (Telugu)" },
] as const;

export type LanguageCode = (typeof INTERVIEW_LANGUAGES)[number]["code"];

export function isLanguageCode(v: string): v is LanguageCode {
  return INTERVIEW_LANGUAGES.some((l) => l.code === v);
}
