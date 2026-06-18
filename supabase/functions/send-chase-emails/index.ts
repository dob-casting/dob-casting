// send-chase-emails — DEPRECATED
// Auto chase has been replaced by manual chase in the admin portal.
// This function is kept as a no-op so existing pg_cron jobs do not error.
// Drop the cron job via: SELECT cron.unschedule('send-chase-emails');

import { json, cors } from "../_shared/supabase.ts";

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return cors();
  return json({ skipped: "auto chase removed, use manual chase in admin portal" });
});
