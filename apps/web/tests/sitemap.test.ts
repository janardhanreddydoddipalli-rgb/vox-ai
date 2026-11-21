import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import sitemap from "@/app/sitemap";

// Every sitemap entry must be a real, public App Router page: a sitemap that
// points crawlers at 404s (or at sign-in-only pages) hurts indexing.
const APP_DIR = path.resolve(__dirname, "../src/app");

describe("sitemap", () => {
  it("lists only pages that exist", () => {
    for (const { url } of sitemap()) {
      const route = new URL(url).pathname.replace(/\/$/, "");
      const page = path.join(APP_DIR, route, "page.tsx");
      expect(existsSync(page), `${route || "/"} has no page.tsx`).toBe(true);
    }
  });

  it("never lists the old playground or signed-in areas", () => {
    const paths = sitemap().map(({ url }) => new URL(url).pathname);
    for (const hidden of ["/playground", "/dashboard", "/settings", "/debug"]) {
      expect(paths.some((p) => p.startsWith(hidden))).toBe(false);
    }
  });
});
