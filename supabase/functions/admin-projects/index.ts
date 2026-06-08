// admin-projects — CRUD for projects
// GET  /functions/v1/admin-projects                     → list all projects
// GET  /functions/v1/admin-projects?action=cron_status  → check pg_cron jobs
// POST /functions/v1/admin-projects
//   { action: "create",           name }
//   { action: "rename",           id, name }
//   { action: "delete",           id }
//   { action: "set_tbin_paused",  id, paused: bool }
//   { action: "set_chase_paused", id, paused: bool }

import { getSupabaseAdmin, json, cors, requireAdminAuth } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);
  const supabase = getSupabaseAdmin();

  if (req.method === "GET") {
    const url = new URL(req.url);

    if (url.searchParams.get("action") === "cron_status") {
      const jobs = ["process-email-queue", "send-chase-emails"];
      const results = await Promise.all(
        jobs.map(async (name) => {
          const { data } = await supabase.rpc("get_cron_status", { job_name: name });
          return { name, ...((data?.[0]) ?? { found: false, schedule: null, active: false }) };
        }),
      );
      return json(results);
    }

    const { data, error } = await supabase
      .from("projects")
      .select("id, name, tbin_paused, chase_paused, cc_email, created_at")
      .is("archived_at", null)
      .order("created_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (req.method === "POST") {
    const body = await req.json();

    if (body.action === "create") {
      const { data, error } = await supabase
        .from("projects")
        .insert({ name: body.name })
        .select("id, name, tbin_paused")
        .single();
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    if (body.action === "rename") {
      const { error } = await supabase
        .from("projects")
        .update({ name: body.name })
        .eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "delete") {
      const { error } = await supabase
        .from("projects")
        .delete()
        .eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "set_tbin_paused") {
      const { error } = await supabase
        .from("projects")
        .update({ tbin_paused: body.paused })
        .eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "set_chase_paused") {
      const { error } = await supabase
        .from("projects")
        .update({ chase_paused: body.paused })
        .eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "set_cc_email") {
      const { error } = await supabase
        .from("projects")
        .update({ cc_email: body.cc_email || null })
        .eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
  }

  return json({ error: "Method not allowed" }, 405);
});
