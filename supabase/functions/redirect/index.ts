// redirect — replaces WEB_APP_URL + is.gd
// GET /functions/v1/r/<magic_token>
// Looks up the slot by magic_token and 302-redirects to the actor portal.
// The magic_token IS the short link — no external shortener needed.

import { getSupabaseAdmin } from "../_shared/supabase.ts";

const ACTOR_PORTAL_URL = Deno.env.get("ACTOR_PORTAL_URL") ??
  `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/actor-portal/index.html`;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // Path is /functions/v1/r/<token> — strip the prefix
  const token = url.pathname.split("/").at(-1);

  if (!token || token === "r") {
    return new Response("Not found", { status: 404 });
  }

  const supabase = getSupabaseAdmin();
  const { data: slot } = await supabase
    .from("slots")
    .select("magic_token, status")
    .eq("magic_token", token)
    .single();

  if (!slot) {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:40px">
        <h2>Link not found</h2>
        <p>This audition link is invalid or has expired.</p>
      </body></html>`,
      { status: 404, headers: { "Content-Type": "text/html" } },
    );
  }

  const destination = `${ACTOR_PORTAL_URL}?id=${token}`;
  return Response.redirect(destination, 302);
});
