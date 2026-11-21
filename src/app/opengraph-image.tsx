import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Vox — AI mock interviews you speak. Speak. It listens. Your report is ready.";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column",
          justifyContent: "center", padding: "0 96px", background: "#0C0F14", color: "#EDF1F5",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 32, color: "#F5B84A" }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "#F5B84A", display: "flex" }} />
          <strong>Vox</strong>
        </div>
        <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.1, marginTop: 32, letterSpacing: -2 }}>
          Speak. It listens.
        </div>
        <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.1, letterSpacing: -2 }}>
          Your report is ready.
        </div>
        <div style={{ fontSize: 32, color: "#A8B0BD", marginTop: 32 }}>
          AI mock interviews in English, Hindi, Tamil and Telugu
        </div>
      </div>
    ),
    size,
  );
}
