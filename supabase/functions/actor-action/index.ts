// actor-action — confirm, decline, or reschedule an audition slot
// POST /functions/v1/actor-action
// Body: { token: string, action: "confirm"|"decline"|"reschedule", new_slot_id?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSupabaseAdmin, json, cors, buildShortLink, formatDateTime } from "../_shared/supabase.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Slot = {
  id: string; project_id: string;
  first_name: string; last_name: string; email: string; agent: string | null;
  role: string; slot_date: string; slot_time: string; status: string; magic_token: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { token?: string; action?: string; new_slot_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { token, action, new_slot_id } = body;
  if (!token || !action) return json({ error: "Missing token or action" }, 400);

  const supabase = getSupabaseAdmin();

  const { data: slot, error: slotErr } = await supabase
    .from("slots")
    .select("id, project_id, first_name, last_name, email, agent, role, slot_date, slot_time, status, magic_token")
    .eq("magic_token", token)
    .single();

  const s = slot as Slot | null;
  if (slotErr || !s || !s.first_name) {
    return json({ error: "Slot not found or already cleared" }, 404);
  }

  // ─── CONFIRM ────────────────────────────────────────────────────────────────
  if (action === "confirm") {
    const { error } = await supabase
      .from("slots")
      .update({ status: "confirmed" })
      .eq("id", s.id);

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, message: "Your audition has been confirmed. See you there!" });
  }

  // Look up project CC for emails
  const { data: proj } = await supabase
    .from("projects").select("cc_email").eq("id", s.project_id).single();
  const cc = proj?.cc_email || null;

  // ─── DECLINE ────────────────────────────────────────────────────────────────
  if (action === "decline") {
    const dateStr = new Date(s.slot_date).toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });

    // 1. Archive
    await supabase.from("actor_archive").insert({
      project_id: s.project_id,
      slot_date:  s.slot_date,
      slot_time:  s.slot_time,
      first_name: s.first_name,
      last_name:  s.last_name,
      email:      s.email,
      agent:      s.agent ?? null,
      role:       s.role,
      reason:     "declined",
    });

    // 2. Queue declined notification
    await supabase.from("email_queue").insert({
      slot_id:         null,
      recipient_email: s.email,
      template_name:   "declined_notification",
      template_vars: {
        "First Name":  s.first_name,
        "Second Name": s.last_name,
        "Agent":       s.agent ?? "",
        "Role":        s.role,
        "Date":        dateStr,
        "Time":        s.slot_time.slice(0, 5),
        "Magic Link":  "",
      },
      cc,
      idempotency_key: `${s.id}:declined_notification:${Date.now()}`,
    });

    // 3. Clear the slot
    const newToken = crypto.randomUUID();
    await supabase.from("slots").update({
      first_name:  null,
      last_name:   null,
      email:       null,
      agent:       null,
      role:        null,
      status:      "empty",
      magic_token: newToken,
      short_link:  null,
    }).eq("id", s.id);

    // 4. Auto-fill from TBIN
    await fillFromTBIN(supabase, s.id, s.project_id, s.role, s.slot_date, s.slot_time, cc);

    triggerEmailQueue();
    return json({ ok: true, message: "You've been removed from the schedule. Thank you for letting us know." });
  }

  // ─── RESCHEDULE ─────────────────────────────────────────────────────────────
  if (action === "reschedule") {
    if (!new_slot_id) return json({ error: "Missing new_slot_id" }, 400);

    const { data: newSlot, error: newSlotErr } = await supabase
      .from("slots")
      .select("id, project_id, slot_date, slot_time, status")
      .eq("id", new_slot_id)
      .single();

    if (newSlotErr || !newSlot) return json({ error: "Target slot not found" }, 404);
    if (newSlot.project_id !== s.project_id) return json({ error: "Slot is in a different project" }, 400);
    if (newSlot.status !== "empty") return json({ error: "That slot has just been taken. Please choose another." }, 409);

    const newToken     = crypto.randomUUID();
    const newShortLink = await buildShortLink(newToken);

    const { error: moveErr } = await supabase.from("slots").update({
      first_name:  s.first_name,
      last_name:   s.last_name,
      email:       s.email,
      agent:       s.agent,
      role:        s.role,
      status:      "rescheduled",
      magic_token: newToken,
      short_link:  newShortLink,
    }).eq("id", newSlot.id);

    if (moveErr) return json({ error: moveErr.message }, 500);

    // Clear old slot
    const clearedToken = crypto.randomUUID();
    await supabase.from("slots").update({
      first_name:  null,
      last_name:   null,
      email:       null,
      agent:       null,
      role:        null,
      status:      "empty",
      magic_token: clearedToken,
      short_link:  null,
    }).eq("id", s.id);

    // Queue reschedule confirmation
    const dateStr = new Date(newSlot.slot_date).toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });

    await supabase.from("email_queue").insert({
      slot_id:         newSlot.id,
      recipient_email: s.email,
      template_name:   "reschedule_confirmation",
      template_vars: {
        "First Name":  s.first_name,
        "Second Name": s.last_name,
        "Agent":       s.agent ?? "",
        "Role":        s.role,
        "Date":        dateStr,
        "Time":        newSlot.slot_time.slice(0, 5),
        "Magic Link":  newShortLink,
      },
      cc,
      idempotency_key: `${newSlot.id}:reschedule_confirmation:${Date.now()}`,
    });

    await fillFromTBIN(supabase, s.id, s.project_id, s.role, s.slot_date, s.slot_time, cc);
    triggerEmailQueue();

    return json({
      ok: true,
      message: `Rescheduled! Your new audition time is ${formatDateTime(newSlot.slot_date, newSlot.slot_time)}. A confirmation email is on its way.`,
    });
  }

  return json({ error: "Unknown action" }, 400);
});

// ─── fillFromTBIN ────────────────────────────────────────────────────────────

async function fillFromTBIN(
  supabase: SupabaseClient,
  slotId: string,
  projectId: string,
  role: string,
  slotDate: string,
  slotTime: string,
  cc: string | null,
) {
  const { data: proj } = await supabase
    .from("projects").select("tbin_paused").eq("id", projectId).single();
  if (proj?.tbin_paused) return;

  const { data: candidates } = await supabase
    .from("tbin_queue")
    .select("id, first_name, last_name, email, agent, role")
    .eq("project_id", projectId)
    .ilike("role", role.trim())
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);

  if (!candidates || candidates.length === 0) return;
  const c = candidates[0] as { id: string; first_name: string; last_name: string; email: string; agent: string | null; role: string };

  await supabase.from("tbin_queue").delete().eq("id", c.id);

  const newToken     = crypto.randomUUID();
  const newShortLink = await buildShortLink(newToken);

  await supabase.from("slots").update({
    first_name:  c.first_name,
    last_name:   c.last_name,
    email:       c.email,
    agent:       c.agent,
    role:        c.role,
    status:      "auto_booked",
    magic_token: newToken,
    short_link:  newShortLink,
  }).eq("id", slotId);

  const dateStr = new Date(slotDate).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

  await supabase.from("email_queue").upsert({
    slot_id:         slotId,
    recipient_email: c.email,
    template_name:   "initial_invite",
    template_vars: {
      "First Name":  c.first_name,
      "Second Name": c.last_name,
      "Agent":       c.agent ?? "",
      "Role":        c.role,
      "Date":        dateStr,
      "Time":        slotTime.slice(0, 5),
      "Magic Link":  newShortLink,
    },
    cc,
    idempotency_key: `${slotId}:initial_invite:auto:${c.email}`,
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
}

function triggerEmailQueue() {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/process-email-queue`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});
}
