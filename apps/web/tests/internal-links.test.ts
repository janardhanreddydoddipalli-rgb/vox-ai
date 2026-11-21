import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Every static internal link (href="/...") in the app must point at a real
// App Router page, so the UI never ships a link to a 404 (as /terms did).
// Template hrefs (`/interview/${id}`) are skipped: their routes are dynamic.
const APP_DIR = path.resolve(__dirname, "../src/app");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

const links = tsxFiles(path.resolve(__dirname, "../src")).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/href=\{?["'](\/[^"'#?]*)/g)].map((m) => ({
    file: path.relative(APP_DIR, file),
    route: m[1].replace(/\/$/, ""),
  })),
);

describe("internal links", () => {
  it("finds links to check", () => {
    expect(links.length).toBeGreaterThan(10);
  });

  it.each(links)("$file → $route has a page", ({ route }) => {
    expect(existsSync(path.join(APP_DIR, route, "page.tsx"))).toBe(true);
  });
});
