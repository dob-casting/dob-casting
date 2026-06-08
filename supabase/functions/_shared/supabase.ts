import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

export function getProjectUrl(): string {
  return Deno.env.get("SUPABASE_URL")!;
}

// Build the magic link for an actor.
// If ACTOR_PORTAL_URL is set (e.g. https://dob-casting.github.io/dob-casting/actor.html),
// the link goes directly there. Otherwise falls back to the Supabase redirect function.
export function buildShortLink(magicToken: string): Promise<string> {
  const actorPortalUrl = Deno.env.get("ACTOR_PORTAL_URL");
  if (actorPortalUrl) {
    return Promise.resolve(`${actorPortalUrl}?id=${magicToken}`);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  return Promise.resolve(`${supabaseUrl}/functions/v1/r/${magicToken}`);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function cors(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export function requireAdminAuth(req: Request): boolean {
  const adminSecret = Deno.env.get("ADMIN_SECRET");
  if (!adminSecret) return false;
  const auth = req.headers.get("Authorization") ?? "";
  return auth === `Bearer ${adminSecret}`;
}

// Format a date + time for display in emails and the actor portal.
export function formatDateTime(date: string, time: string): string {
  // date: "2025-05-12", time: "14:30:00"
  const d = new Date(`${date}T${time}Z`);
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }) + " at " + d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}
