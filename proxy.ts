import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { RESERVED_SLUGS } from "@/lib/config/urls";

/** Bare paths that existed before org-scoped routing (legacy bookmarks, auth redirects). */
const LEGACY_PATHS = [
  "/dashboard",
  "/automations",
  "/runs",
  "/sessions",
  "/integrations",
  "/settings",
];

/**
 * Collection routes where cookie-based fast redirect is safe.
 * Resource routes (e.g. /runs/:id, /sessions/:id) must fall through
 * to legacy-redirect pages that resolve the owning org from the DB.
 */
const COLLECTION_PATHS = new Set([
  "/dashboard",
  "/automations",
  "/automations/new",
  "/runs",
  "/sessions",
  "/sessions/new",
  "/integrations",
  "/settings",
]);

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;

  // Protect /onboarding
  if (pathname === "/onboarding" || pathname.startsWith("/onboarding/")) {
    if (!sessionCookie) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    return NextResponse.next();
  }

  // Legacy path redirect: bare /dashboard, /sessions/*, /runs/*, etc.
  // These no longer have pages — redirect to org-scoped equivalents.
  const legacyMatch = LEGACY_PATHS.find(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (legacyMatch) {
    if (!sessionCookie) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("returnTo", pathname);
      return NextResponse.redirect(loginUrl);
    }
    // Only use cookie fast-path for collection routes (e.g. /dashboard, /sessions).
    // Resource routes (e.g. /sessions/:id, /runs/:id) must fall through to the
    // legacy-redirect pages that resolve the owning org from the DB row.
    // Settings subpaths are all collection routes (no resource IDs).
    const orgSlug = request.cookies.get("polaris_org_slug")?.value;
    const isCollectionRoute = COLLECTION_PATHS.has(pathname)
      || pathname.startsWith("/settings/");
    if (orgSlug && isCollectionRoute) {
      const url = request.nextUrl.clone();
      url.pathname = `/${orgSlug}${pathname}`;
      return NextResponse.redirect(url);
    }
    // No cookie or resource URL — fall through to the legacy-redirect pages
    return NextResponse.next();
  }

  // Org-scoped path: /:orgSlug/* (any first segment not in RESERVED_SLUGS)
  const firstSegment = pathname.split("/")[1];
  if (firstSegment && !RESERVED_SLUGS.has(firstSegment)) {
    // Protect org-scoped dashboard routes
    if (!sessionCookie) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("returnTo", pathname);
      return NextResponse.redirect(loginUrl);
    }
    // Set the org slug cookie here so it's available for legacy redirects.
    // If the slug is invalid the layout will notFound(), and the browser won't
    // store the cookie from a non-2xx response (Set-Cookie on 404 is ignored).
    const response = NextResponse.next();
    response.cookies.set("polaris_org_slug", firstSegment, {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365, // 1 year
    });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - /api/* (API routes)
     * - /_next/* (Next.js internals)
     * - /login (auth page)
     * - Static files (favicon, etc.)
     */
    "/((?!api|_next|login|favicon\\.ico).*)",
  ],
};
