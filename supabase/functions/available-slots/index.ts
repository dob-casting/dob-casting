// available-slots — replaces getAvailableSlots
// GET /functions/v1/available-slots?token=<uuid>
// Returns all empty slots in the actor's project.
// Returns stable UUIDs (not row numbers), fixing the GAS bug where
// row insertions/deletions broke slot references.

import { getSupabaseAdmin, json, cors, formatDateTime } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return json({ error: "Missing token" }, 400);

  const supabase = getSupabaseAdmin();

  // Find the actor's current slot to get the project_id
  const { data: currentSlot } = await supabase
    .from("slots")
    .select("id, project_id")
    .eq("magic_token", token)
    .single();

  if (!currentSlot) return json({ error: "Token not found" }, 404);

  // Return all empty slots in the same project, excluding the actor's current slot
  const { data: slots } = await supabase
    .from("slots")
    .select("id, slot_date, slot_time")
    .eq("project_id", currentSlot.project_id)
    .eq("status", "empty")
    .neq("id", currentSlot.id)
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });

  const result = (slots ?? []).map((s) => ({
    id: s.id,
    display: formatDateTime(s.slot_date, s.slot_time),
  }));

  return json(result);
});
