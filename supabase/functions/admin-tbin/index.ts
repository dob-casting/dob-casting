// admin-tbin — manage the TBIN queue (project-specific)
// GET  /functions/v1/admin-tbin?project_id=<uuid>  → list queue for project
// POST /functions/v1/admin-tbin
//   { action: "add",      project_id, first_name, last_name, email, agent, role }
//   { action: "bulk_add", project_id, actors: [{first_name, last_name, email, agent, role}] }
//   { action: "remove",   id }

import { getSupabaseAdmin, json, cors, requireAdminAuth, buildShortLink } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);
  const supabase = getSupabaseAdmin();

  if (req.method === "GET") {
    const projectId = new URL(req.url).searchParams.get("project_id");
    if (!projectId) return json({ error: "Missing project_id" }, 400);

    const { data, error } = await supabase
      .from("tbin_queue")
      .select("id, first_name, last_name, email, agent, role, position, created_at")
      .eq("project_id", projectId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (req.method === "POST") {
    const body = await req.json();

    if (body.action === "add") {
      const { project_id, first_name, last_name, email, role } = body;
      const agent = body.agent || null;
      if (!project_id || !first_name || !last_name || !email || !role) {
        return json({ error: "Missing fields" }, 400);
      }
      const { error } = await supabase.from("tbin_queue").insert({
        project_id, first_name, last_name, email, agent, role,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "bulk_add") {
      const { project_id, actors } = body as {
        project_id: string;
        actors: { first_name: string; last_name: string; email: string; agent?: string | null; role: string }[];
      };
      if (!project_id || !actors?.length) return json({ error: "Missing fields" }, 400);

      const rows = actors.map(a => ({
        project_id,
        first_name: a.first_name,
        last_name:  a.last_name,
        email:      a.email,
        agent:      a.agent || null,
        role:       a.role,
      }));

      const { error } = await supabase.from("tbin_queue").insert(rows);
      if (error) return json({ error: error.message }, 500);
      return json({ inserted: rows.length });
    }

    if (body.action === "remove") {
      const { error } = await supabase.from("tbin_queue").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "book") {
      const { tbin_id, slot_id } = body;
      if (!tbin_id || !slot_id) return json({ error: "Missing tbin_id or slot_id" }, 400);

      const { data: entry } = await supabase
        .from("tbin_queue")
        .select("id, first_name, last_name, email, agent, role, project_id")
        .eq("id", tbin_id)
        .single();
      if (!entry) return json({ error: "TBIN entry not found" }, 404);

      const { data: slot } = await supabase
        .from("slots")
        .select("id, project_id, slot_date, slot_time, status")
        .eq("id", slot_id)
        .single();
      if (!slot) return json({ error: "Slot not found" }, 404);
      if (slot.project_id !== entry.project_id) return json({ error: "Slot is in a different project" }, 400);
      if (slot.status !== "empty") return json({ error: "Slot is not empty" }, 409);

      const { data: proj } = await supabase
        .from("projects").select("cc_email").eq("id", entry.project_id).single();
      const cc = proj?.cc_email || null;

      const token = crypto.randomUUID();
      const link  = await buildShortLink(token);

      const { error: updateErr } = await supabase.from("slots").update({
        first_name:  entry.first_name,
        last_name:   entry.last_name,
        email:       entry.email,
        agent:       entry.agent,
        role:        entry.role,
        status:      "auto_booked",
        magic_token: token,
        short_link:  link,
      }).eq("id", slot.id);
      if (updateErr) return json({ error: updateErr.message }, 500);

      await supabase.from("tbin_queue").delete().eq("id", tbin_id);

      const dateStr = new Date(slot.slot_date).toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
      });

      {
        await supabase.from("email_queue").upsert({
          slot_id:         slot.id,
          project_id:      entry.project_id,
          recipient_email: entry.email,
          template_name:   "initial_invite",
          template_vars: {
            "First Name":  entry.first_name,
            "Second Name": entry.last_name,
            "Agent":       entry.agent ?? "",
            "Role":        entry.role,
            "Date":        dateStr,
            "Time":        slot.slot_time.slice(0, 5),
            "Magic Link":  link,
          },
          cc,
          idempotency_key: `${slot.id}:initial_invite:manual_book:${entry.email}`,
        }, { onConflict: "idempotency_key", ignoreDuplicates: true });
      }

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
