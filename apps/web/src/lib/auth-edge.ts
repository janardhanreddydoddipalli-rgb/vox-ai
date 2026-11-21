import NextAuthDefault from "next-auth";
import { authConfig } from "./auth";

// Edge-safe instance for middleware: JWT session strategy reads only the
// cookie, no database access.
export const { auth: middlewareAuth } = NextAuthDefault(authConfig);
