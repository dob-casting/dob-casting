// admin-templates — read and update email templates
// GET  /functions/v1/admin-templates           → list all templates
// POST /functions/v1/admin-templates           → { name, subject, html_body }

import { getSupabaseAdmin, json, cors, requireAdminAuth } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);
  const supabase = getSupabaseAdmin();

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("email_templates")
      .select("name, subject, html_body, updated_at");
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (req.method === "POST") {
    const { name, subject, html_body } = await req.json();
    if (!name || !subject || !html_body) return json({ error: "Missing fields" }, 400);

    const { error } = await supabase
      .from("email_templates")
      .upsert({ name, subject, html_body, updated_at: new Date().toISOString() })
      .eq("name", name);

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
});
