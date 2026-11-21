export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL
  ? `https://${process.env.NEXT_PUBLIC_SITE_URL.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
  : "http://localhost:3000";

export const siteConfig = {
  name: "Vox",
  tagline: "Speak. It listens. Your report is ready.",
  description:
    "Vox is an AI mock-interview voice assistant: a real-time spoken interview with follow-up questions and a scored report — in English, Hindi, Tamil and Telugu.",
};
