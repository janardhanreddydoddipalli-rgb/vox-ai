"use client";

import { useState } from "react";
import { apiFetch, problemDetail } from "@/lib/api-browser";

// The PDF comes from services/api, which needs the bearer token, so a plain
// link can't fetch it: download it here and hand the browser a blob URL.
export default function PdfButton({ interviewId }: { interviewId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function download() {
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch(`/v1/interviews/${encodeURIComponent(interviewId)}/report.pdf`);
      if (!res.ok) throw new Error(await problemDetail(res, "Could not download the PDF"));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `vox-interview-${interviewId.slice(0, 8)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download the PDF");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-secondary" type="button" onClick={download} disabled={busy}>
        {busy ? "Preparing PDF…" : "Download PDF"}
      </button>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </>
  );
}
