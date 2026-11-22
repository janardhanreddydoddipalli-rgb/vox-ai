import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { upsertUserViaApi } from "./api-internal";

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
    // The users row lives in services/api: resolve its id at sign-in (and once
    // for sessions started before it was kept in the token). A failure fails
    // sign-in: without the id the app can't call the API.
    async jwt({ token, user, profile }) {
      if (user?.email) {
        token.email = user.email;
        token.name = token.name ?? user.name ?? profile?.name ?? null;
        token.picture = token.picture ?? user.image ?? profile?.picture ?? null;
      }
      if (token.email && !token.userId) {
        token.userId = await upsertUserViaApi({ email: token.email, name: token.name, image: token.picture });
      }
      return token;
    },
    // session.user.id is the users.id from services/api, never the OAuth account id.
    session({ session, token }) {
      session.user.id = token.userId ?? "";
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/** The signed-in user's users.id (services/api), or null when signed out. */
export async function currentUserId(): Promise<string | null> {
  return (await auth())?.user?.id || null;
}
