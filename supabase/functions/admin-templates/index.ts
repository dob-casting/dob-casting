// admin-templates — read and update email templates (per project)
// GET  /functions/v1/admin-templates?project_id=xxx   → list templates for project
// POST /functions/v1/admin-templates                  → { project_id, name, subject, html_body }

import { getSupabaseAdmin, json, cors, requireAdminAuth } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);
  const supabase = getSupabaseAdmin();

  if (req.method === "GET") {
    const url = new URL(req.url);
    const project_id = url.searchParams.get("project_id");
    if (!project_id) return json({ error: "project_id is required" }, 400);

    const { data, error } = await supabase
      .from("email_templates")
      .select("name, subject, html_body, updated_at")
      .eq("project_id", project_id);
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (req.method === "POST") {
    const body = await req.json();
    const { project_id, name, subject, html_body } = body;
    if (!project_id || !name || !subject || !html_body) {
      return json({ error: "project_id, name, subject, and html_body are all required" }, 400);
    }

    const { error } = await supabase
      .from("email_templates")
      .upsert(
        { project_id, name, subject, html_body, updated_at: new Date().toISOString() },
        { onConflict: "project_id,name" },
      );

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
});
