import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";

// Auth.js v5. Google OAuth + email magic link (Resend). Credentials come from
// env (Vercel env settings in prod); providers activate when configured.
export const authConfig: NextAuthConfig = {
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })]
      : []),
    ...(process.env.RESEND_API_KEY
      ? [Resend({ from: process.env.EMAIL_FROM ?? "Vox <onboarding@resend.dev>" })]
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
      }
      return token;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
