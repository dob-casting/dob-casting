// admin-projects — CRUD for projects
// GET  /functions/v1/admin-projects                     → list all projects
// GET  /functions/v1/admin-projects?action=cron_status  → check pg_cron jobs
// POST /functions/v1/admin-projects
//   { action: "create",           name }
//   { action: "rename",           id, name }
//   { action: "delete",           id }
//   { action: "set_tbin_paused",  id, paused: bool }
//   { action: "set_chase_paused", id, paused: bool }
//   { action: "set_templates",    id, tpl_invite, tpl_decline, tpl_reschedule, tpl_chase }

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
      .select("id, name, tbin_paused, chase_paused, cc_email, tpl_invite, tpl_decline, tpl_reschedule, tpl_chase, created_at")
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

      // Seed default email templates for the new project
      const pid = data.id;
      const defaults = [
        {
          project_id: pid,
          name: "initial_invite",
          subject: "Audition for {{First Name}} {{Second Name}}",
          html_body: `<p>Hello,</p>
<p>Thank you so much for submitting {{First Name}} {{Second Name}} for the upcoming auditions.</p>
<p>We would like to see {{First Name}} as follows:</p>
<p><strong>ROLE:</strong> {{Role}}</p>
<p>Please note that audition times for this project can be rescheduled via the link at the bottom of this email.</p>
<p><strong>{{Date}}</strong><br>at<br><strong>{{Time}}</strong></p>
<p><strong>Going to:</strong><br>[Venue name and address]</p>
<p><strong>TO PREPARE</strong><br>[Preparation instructions]</p>
<p>I would appreciate it if you could confirm whether {{First Name}} will be able to make it by clicking on the appropriate link below:</p>
<p>{{Magic Link}}</p>
<p>Best wishes,</p>
<p>Dan</p>`,
        },
        {
          project_id: pid,
          name: "chase",
          subject: "Reminder: Audition for {{First Name}} {{Second Name}}",
          html_body: `<p>Hello,</p>
<p>Just a gentle reminder regarding the audition for {{First Name}} {{Second Name}}.</p>
<p><strong>ROLE:</strong> {{Role}}</p>
<p><strong>{{Date}}</strong> at <strong>{{Time}}</strong></p>
<p>Could you please confirm whether {{First Name}} will be attending by clicking on the appropriate link below:</p>
<p>{{Magic Link}}</p>
<p>Best wishes,</p>
<p>Dan</p>`,
        },
        {
          project_id: pid,
          name: "declined_notification",
          subject: "Audition Update: {{First Name}} {{Second Name}}",
          html_body: `<p>Hello,</p>
<p>This is to let you know that {{First Name}} {{Second Name}} has unfortunately declined the audition.</p>
<p><strong>ROLE:</strong> {{Role}}</p>
<p><strong>{{Date}}</strong> at <strong>{{Time}}</strong></p>
<p>Best wishes,</p>
<p>Dan</p>`,
        },
        {
          project_id: pid,
          name: "reschedule_confirmation",
          subject: "Audition Rescheduled: {{First Name}} {{Second Name}}",
          html_body: `<p>Hello,</p>
<p>This is to confirm that the audition for {{First Name}} {{Second Name}} has been rescheduled.</p>
<p><strong>ROLE:</strong> {{Role}}</p>
<p>The new audition time is:</p>
<p><strong>{{Date}}</strong><br>at<br><strong>{{Time}}</strong></p>
<p>{{Magic Link}}</p>
<p>Best wishes,</p>
<p>Dan</p>`,
        },
      ];
      const { error: tmplErr } = await supabase.from("email_templates").insert(defaults);
      if (tmplErr) console.error("Failed to seed default templates:", tmplErr.message);

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

    if (body.action === "set_templates") {
      const { error } = await supabase
        .from("projects")
        .update({
          tpl_invite:     body.tpl_invite     || null,
          tpl_decline:    body.tpl_decline    || null,
          tpl_reschedule: body.tpl_reschedule || null,
          tpl_chase:      body.tpl_chase      || null,
        })
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
