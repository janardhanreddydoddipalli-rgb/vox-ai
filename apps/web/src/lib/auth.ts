import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { upsertUserViaApi, upsertViaApiEnabled } from "./api-internal";

const e2eEnabled = process.env.E2E_TEST_AUTH === "1";

// Auth.js v5, Google OAuth only (docs/adr/0002-google-only-auth.md): email
// magic links need a database adapter in the web app, which the architecture
// forbids. Credentials come from env (Vercel env settings in prod).
// E2E_TEST_AUTH=1 adds a credentials provider used only by the Playwright run.
export const authConfig: NextAuthConfig = {
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })]
      : []),
    ...(e2eEnabled
      ? [
          Credentials({
            name: "Test sign-in",
            credentials: { email: { label: "Email", type: "email" } },
            authorize(credentials) {
              const email = String(credentials?.email ?? "").trim();
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
              return { id: email, email, name: email.split("@")[0] };
            },
          }),
        ]
      : []),
  ],
  session: { strategy: "jwt" },
  pages: {},
  callbacks: {
    // Keep a users row in sync with the signed-in identity.
    async jwt({ token, user, profile }) {
      if (user?.email) {
        token.email = user.email;
        token.name = token.name ?? user.name ?? profile?.name ?? null;
        token.picture = token.picture ?? user.image ?? profile?.picture ?? null;
        // M2 (off by default): resolve the stable user id through services/api
        // at sign-in. Non-fatal while the web app still owns its own DB access.
        if (upsertViaApiEnabled()) {
          try {
            token.userId = await upsertUserViaApi({ email: user.email, name: token.name, image: token.picture });
          } catch (err) {
            console.error("[auth] user upsert via API failed:", err instanceof Error ? err.message : "unknown");
          }
        }
      }
      return token;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
