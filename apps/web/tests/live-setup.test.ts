import { describe, it, expect } from "vitest";
import { liveSetupMessage, type LiveSessionConfig } from "@/voice/live-voice";

// The Live API's setup.tools is a list of Tool objects; function declarations go
// inside one Tool's functionDeclarations. Bare declarations are rejected at setup.
const config: LiveSessionConfig = {
  sessionId: "55555555-5555-4555-8555-555555555555",
  token: "auth_tokens/t",
  model: "models/live",
  systemInstruction: "You are an interviewer.",
  tools: [{ name: "get_question", description: "Next question", parameters: { type: "object", properties: {} } }],
};

describe("liveSetupMessage", () => {
  it("wraps the agent tools in one functionDeclarations tool", () => {
    expect(liveSetupMessage(config, "").setup.tools).toEqual([{ functionDeclarations: config.tools }]);
  });

  it("sends the model, system prompt and speech language", () => {
    const { setup } = liveSetupMessage(config, "hi-IN");
    expect(setup.model).toBe("models/live");
    expect(setup.systemInstruction).toEqual({ parts: [{ text: "You are an interviewer." }] });
    expect(setup.generationConfig.speechConfig.languageCode).toBe("hi");
    expect(liveSetupMessage(config, "").setup.generationConfig.speechConfig).not.toHaveProperty("languageCode");
  });
});
