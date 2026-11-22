// The stable users.id from services/api, resolved at sign-in (lib/auth.ts) and
// exposed as session.user.id. Not the OAuth account id (token.sub).
import "next-auth/jwt";

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
  }
}
