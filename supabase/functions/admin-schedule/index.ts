// admin-schedule — view and manage project schedule slots
// GET  /functions/v1/admin-schedule?project_id=<uuid>
// POST /functions/v1/admin-schedule
//   { action: "bulk_add_slots", project_id, slots: [{slot_date, slot_time}] }
//   { action: "add_slot",       project_id, slot_date, slot_time }
//   { action: "edit_slot",      slot_id, slot_date, slot_time }
//   { action: "remove_actor",   slot_id }

import { getSupabaseAdmin, json, cors, requireAdminAuth, buildShortLink } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);
  const supabase = getSupabaseAdmin();

  if (req.method === "GET") {
    const projectId = new URL(req.url).searchParams.get("project_id");
    if (!projectId) return json({ error: "Missing project_id" }, 400);

    const { data, error } = await supabase
      .from("slots")
      .select("id, slot_date, slot_time, first_name, last_name, email, agent, role, status, magic_token")
      .eq("project_id", projectId)
      .order("slot_date", { ascending: true })
      .order("slot_time", { ascending: true });

    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (req.method === "POST") {
    const body = await req.json();

    if (body.action === "bulk_add_slots") {
      const rows = (body.slots as { slot_date: string; slot_time: string }[]).map((s) => ({
        project_id: body.project_id,
        slot_date:  s.slot_date,
        slot_time:  s.slot_time,
      }));
      const { error } = await supabase.from("slots").insert(rows);
      if (error) return json({ error: error.message }, 500);
      return json({ inserted: rows.length });
    }

    if (body.action === "edit_slot") {
      const { error } = await supabase
        .from("slots")
        .update({ slot_date: body.slot_date, slot_time: body.slot_time })
        .eq("id", body.slot_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "add_slot") {
      const { data, error } = await supabase
        .from("slots")
        .insert({
          project_id: body.project_id,
          slot_date:  body.slot_date,
          slot_time:  body.slot_time,
        })
        .select("id")
        .single();
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    if (body.action === "remove_actor") {
      const { data: slot } = await supabase
        .from("slots")
        .select("id, project_id, first_name, last_name, email, agent, role, slot_date, slot_time")
        .eq("id", body.slot_id)
        .single();

      if (!slot || !slot.first_name) return json({ error: "Slot not found or already empty" }, 404);

      const { data: proj } = await supabase
        .from("projects").select("tbin_paused, cc_email").eq("id", slot.project_id).single();
      const cc = proj?.cc_email || null;

      const dateStr = new Date(slot.slot_date).toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
      });

      // Archive the actor
      await supabase.from("actor_archive").insert({
        project_id: slot.project_id,
        slot_date:  slot.slot_date,
        slot_time:  slot.slot_time,
        first_name: slot.first_name,
        last_name:  slot.last_name,
        email:      slot.email,
        agent:      slot.agent ?? null,
        role:       slot.role,
        reason:     "removed",
      });

      // Queue declined notification
      await supabase.from("email_queue").insert({
        slot_id:         null,
        recipient_email: slot.email,
        template_name:   "declined_notification",
        template_vars: {
          "First Name":  slot.first_name,
          "Second Name": slot.last_name,
          "Agent":       slot.agent ?? "",
          "Role":        slot.role,
          "Date":        dateStr,
          "Time":        slot.slot_time.slice(0, 5),
          "Magic Link":  "",
        },
        cc,
        idempotency_key: `${slot.id}:declined_notification:admin_remove:${Date.now()}`,
      });

      // Clear the slot
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
      }).eq("id", slot.id);

      // Auto-fill from TBIN (role-matched), unless paused
      if (!proj?.tbin_paused) {
        const { data: candidates } = await supabase
          .from("tbin_queue")
          .select("id, first_name, last_name, email, agent, role")
          .eq("project_id", slot.project_id)
          .ilike("role", slot.role?.trim() ?? "")
          .order("position", { ascending: true })
          .order("created_at", { ascending: true })
          .limit(1);

      if (candidates && candidates.length > 0) {
        const c = candidates[0] as { id: string; first_name: string; last_name: string; email: string; agent: string | null; role: string };
        await supabase.from("tbin_queue").delete().eq("id", c.id);

        const autoToken = crypto.randomUUID();
        const autoLink  = await buildShortLink(autoToken);

        await supabase.from("slots").update({
          first_name:  c.first_name,
          last_name:   c.last_name,
          email:       c.email,
          agent:       c.agent,
          role:        c.role,
          status:      "auto_booked",
          magic_token: autoToken,
          short_link:  autoLink,
        }).eq("id", slot.id);

        await supabase.from("email_queue").upsert({
          slot_id:         slot.id,
          recipient_email: c.email,
          template_name:   "initial_invite",
          template_vars: {
            "First Name":  c.first_name,
            "Second Name": c.last_name,
            "Agent":       c.agent ?? "",
            "Role":        c.role,
            "Date":        dateStr,
            "Time":        slot.slot_time.slice(0, 5),
            "Magic Link":  autoLink,
          },
          cc,
          idempotency_key: `${slot.id}:initial_invite:admin_remove:${c.email}`,
        }, { onConflict: "idempotency_key", ignoreDuplicates: true });

      }
      }

      // Trigger email queue (for declined notification and/or auto-fill invite)
      const fnUrl  = `${Deno.env.get("SUPABASE_URL")}/functions/v1/process-email-queue`;
      const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      fetch(fnUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${svcKey}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => {});

      return json({ ok: true });
    }
  }

  return json({ error: "Method not allowed" }, 405);
});
