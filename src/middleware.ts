import { NextResponse, type NextRequest } from "next/server";
import { middlewareAuth as auth } from "@/lib/auth-edge";

// Protect the dashboard and every API route except /api/health.
// /api/auth/* must stay open so sign-in works.
const PUBLIC_PATHS = ["/api/health", "/api/auth"];

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*"],
};
