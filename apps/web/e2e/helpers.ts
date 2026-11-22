import type { APIRequestContext, Page } from "@playwright/test";

// services/api, which the browser calls directly with a token from /api/token.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000").replace(
  /\/$/,
  "",
);

export async function signIn(page: Page, who: string): Promise<string> {
  const email = `${who}-${Date.now()}@example.com`;
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");
  return email;
}

type Options = Parameters<APIRequestContext["post"]>[1];

/** Calls services/api as the page's signed-in user (a fresh /api/token JWT). */
export async function apiAs(page: Page) {
  const res = await page.request.get("/api/token");
  if (!res.ok()) throw new Error(`/api/token ${res.status()}`);
  const { token } = (await res.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  const withAuth = (o: Options = {}) => ({ ...o, headers: { ...auth, ...(o.headers ?? {}) } });
  return {
    get: (path: string, o?: Options) => page.request.get(API_URL + path, withAuth(o)),
    post: (path: string, o?: Options) => page.request.post(API_URL + path, withAuth(o)),
  };
}

export function parseSse(text: string) {
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const lines = b.split("\n");
      return {
        event: lines.find((l) => l.startsWith("event: "))!.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)),
      };
    });
}
