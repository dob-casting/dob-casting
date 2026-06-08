// actor-view — returns actor details for the given magic_token
// GET /functions/v1/actor-view?token=<uuid>

import { getSupabaseAdmin, json, cors, formatDateTime } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return json({ error: "Missing token" }, 400);

  const supabase = getSupabaseAdmin();
  const { data: slot, error } = await supabase
    .from("slots")
    .select("role, slot_date, slot_time, status, first_name, last_name")
    .eq("magic_token", token)
    .single();

  if (error || !slot || !slot.first_name) {
    return json(null, 404);
  }

  return json({
    name:     `${slot.first_name} ${slot.last_name}`,
    role:     slot.role,
    datetime: formatDateTime(slot.slot_date, slot.slot_time),
    status:   slot.status,
  });
});
