import { NextResponse, type NextRequest } from "next/server";
import { middlewareAuth as auth } from "@/lib/auth-edge";

// Protect the dashboard and /api/token. /api/auth/* must stay open so sign-in
// works. Everything else the app does is a call to services/api.
const PUBLIC_PATHS = ["/api/auth"];

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const session = await auth();
  if (!session?.user?.email) {
    // API callers get JSON; people visiting a page get sent to sign-in and
    // brought back to where they were going.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const signin = new URL("/signin", req.nextUrl.origin);
    signin.searchParams.set("callbackUrl", `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(signin);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*"],
};
