import NextAuthDefault from "next-auth";
import { authConfig } from "@/lib/auth";

// Auth.js route handlers: GET and POST on /api/auth/[...nextauth].
const { handlers } = NextAuthDefault(authConfig);

export const GET = handlers.GET;
export const POST = handlers.POST;
