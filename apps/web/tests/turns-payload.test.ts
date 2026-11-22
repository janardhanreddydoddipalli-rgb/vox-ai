import { describe, it, expect } from "vitest";
import { turnsBody, turnsPath } from "@/lib/turns-payload";

describe("playground turns payload", () => {
  it("saves live-voice sessions as gemini (the API's engines are gemini | browser)", () => {
    // The playground used to send the voice mode ("live"), which the turns
    // schema rejects, so live-mode history was never saved.
    expect(JSON.parse(turnsBody("live", [])).mode).toBe("gemini");
    expect(JSON.parse(turnsBody("browser", [])).mode).toBe("browser");
    expect(JSON.parse(turnsBody(null, [])).mode).toBe("browser");
  });

  it("sends snake_case turns with every latency stage", () => {
    const body = JSON.parse(
      turnsBody("browser", [{ role: "assistant", text: "Hi", latencyMs: 420, sttMs: 10, firstTokenMs: 200, totalLlmMs: 380, ttsStartMs: 400 }]),
    );
    expect(body.turns).toEqual([
      { role: "assistant", text: "Hi", latency_ms: 420, stt_ms: 10, first_token_ms: 200, total_llm_ms: 380, tts_start_ms: 400 },
    ]);
    expect(turnsPath("s 1")).toBe("/v1/sessions/s%201/turns");
  });
});
