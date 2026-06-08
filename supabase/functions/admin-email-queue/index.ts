// admin-email-queue — view recent email queue entries
// GET /functions/v1/admin-email-queue

import { getSupabaseAdmin, json, cors, requireAdminAuth } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_queue")
    .select("id, recipient_email, template_name, status, attempts, last_error, created_at, sent_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return json({ error: error.message }, 500);
  return json(data);
});
