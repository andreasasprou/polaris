import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const protectedPaths = ["/dashboard", "/automations", "/integrations", "/settings", "/onboarding"];

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;


  // Protect authenticated routes
  if (protectedPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (!sessionCookie) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  // Redirect authenticated users away from login
  if (pathname === "/login") {
    if (sessionCookie) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/automations/:path*",
    "/integrations/:path*",
    "/settings/:path*",
    "/onboarding/:path*",
    "/login",
  ],
};
