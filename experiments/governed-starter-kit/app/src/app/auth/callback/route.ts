import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// `next` comes from the query string, so it is attacker-controlled. Accept only
// a same-origin path: one leading slash, not "//" or "/\" (protocol-relative),
// and resolved with new URL against our own origin rather than concatenated -
// `${origin}${next}` with next="@evil.example" yields a URL whose host is
// evil.example.
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/dashboard";
  }
  return next;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const target = new URL(next, origin);
      if (target.origin === origin) return NextResponse.redirect(target);
    }
  }
  return NextResponse.redirect(new URL("/login?error=auth", origin));
}
