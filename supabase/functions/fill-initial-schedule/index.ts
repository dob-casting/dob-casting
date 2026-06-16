// fill-initial-schedule — assigns TBIN actors to empty slots and queues invite emails
// POST /functions/v1/fill-initial-schedule
// Body: { project_id: string }

import { getSupabaseAdmin, json, cors, buildShortLink, requireAdminAuth } from "../_shared/supabase.ts";

type TBINRow = { id: string; first_name: string; last_name: string; email: string; agent: string | null; role: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);

  let body: { project_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { project_id } = body;
  if (!project_id) return json({ error: "Missing project_id" }, 400);

  const supabase = getSupabaseAdmin();

  // Look up project CC
  const { data: proj } = await supabase
    .from("projects").select("cc_email").eq("id", project_id).single();
  const cc = proj?.cc_email || null;

  // Fetch all empty slots for this project
  const { data: emptySlots, error: slotsErr } = await supabase
    .from("slots")
    .select("id, slot_date, slot_time")
    .eq("project_id", project_id)
    .eq("status", "empty")
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });

  if (slotsErr) return json({ error: slotsErr.message }, 500);
  if (!emptySlots || emptySlots.length === 0) {
    return json({ filled: 0, no_actors_available: 0, message: "No empty slots found." });
  }

  // Fetch TBIN actors for this project
  const { data: tbinRows, error: tbinErr } = await supabase
    .from("tbin_queue")
    .select("id, first_name, last_name, email, agent, role")
    .eq("project_id", project_id)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(emptySlots.length);

  if (tbinErr) return json({ error: tbinErr.message }, 500);

  const actors = (tbinRows ?? []) as TBINRow[];
  const noActors = emptySlots.length - actors.length;

  if (actors.length === 0) {
    return json({ filled: 0, no_actors_available: emptySlots.length, message: "No actors available in TBIN." });
  }

  // Remove all claimed TBIN rows at once
  await supabase.from("tbin_queue").delete().in("id", actors.map(a => a.id));

  // Pair slots with actors, generate tokens in parallel
  const pairs = emptySlots.slice(0, actors.length).map((slot, i) => ({ slot, tbin: actors[i] }));

  const assignments = await Promise.all(
    pairs.map(async ({ slot, tbin }) => {
      const token = crypto.randomUUID();
      const link  = await buildShortLink(token);
      return { slot, tbin, token, link };
    }),
  );

  // Update all slots in parallel
  await Promise.all(
    assignments.map(({ slot, tbin, token, link }) =>
      supabase.from("slots").update({
        first_name:  tbin.first_name,
        last_name:   tbin.last_name,
        email:       tbin.email,
        agent:       tbin.agent,
        role:        tbin.role,
        status:      "invite_sent",
        magic_token: token,
        short_link:  link,
      }).eq("id", slot.id)
    ),
  );

  // Build and bulk-insert all email_queue rows
  const emailRows = assignments.map(({ slot, tbin, link }) => ({
    slot_id:         slot.id,
    project_id,
    recipient_email: tbin.email,
    template_name:   "initial_invite",
    template_vars: {
      "First Name":  tbin.first_name,
      "Second Name": tbin.last_name,
      "Agent":       tbin.agent ?? "",
      "Role":        tbin.role,
      "Date":        new Date(slot.slot_date).toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
      }),
      "Time":        slot.slot_time.slice(0, 5),
      "Magic Link":  link,
    },
    cc,
    idempotency_key: `${slot.id}:initial_invite:${tbin.email}`,
  }));

  const { error: queueErr } = await supabase.from("email_queue").upsert(emailRows, {
    onConflict:       "idempotency_key",
    ignoreDuplicates: true,
  });
  if (queueErr) console.error("email_queue upsert failed:", queueErr.message);

  // Trigger email queue processing (non-blocking)
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/process-email-queue`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});

  return json({
    filled:              assignments.length,
    no_actors_available: noActors,
    email_queue_error:   queueErr?.message ?? null,
    message:             `Filled ${assignments.length} slot(s).${noActors > 0 ? ` ${noActors} slot(s) had no actors in TBIN.` : ""}${queueErr ? ` Warning: email queue failed: ${queueErr.message}` : ""}`,
  });
});
