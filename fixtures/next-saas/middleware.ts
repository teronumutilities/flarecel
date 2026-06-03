import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Auth check stub — replace with real auth logic.
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"]
};
