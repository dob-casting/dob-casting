// admin-gmail-test — diagnose Gmail OAuth scopes and draft availability
// GET /functions/v1/admin-gmail-test
// Returns: token scopes, list of first 10 drafts, and whether each template label was found.

import { json, cors, requireAdminAuth } from "../_shared/supabase.ts";

const DRAFT_LABELS: Record<string, string> = {
  initial_invite:          "dob-invite",
  declined_notification:   "dob-declined",
  reschedule_confirmation: "dob-reschedule",
};

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     Deno.env.get("GMAIL_CLIENT_ID")!,
      client_secret: Deno.env.get("GMAIL_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GMAIL_REFRESH_TOKEN")!,
      grant_type:    "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);

  // Get access token
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return json({ error: "Token refresh failed", detail: String(err) });
  }

  // Check what scopes the token has
  const tokenInfoRes = await fetch(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`,
  );
  const tokenInfo = await tokenInfoRes.json();

  // List first 10 drafts to see what's available
  const draftsRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=10",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const draftsStatus = draftsRes.status;
  const draftsData = draftsRes.ok ? await draftsRes.json() : { error: await draftsRes.text() };

  // For each draft, get its subject line
  const draftDetails: { id: string; subject: string; snippet: string }[] = [];
  if (draftsData.drafts) {
    await Promise.all(
      (draftsData.drafts as { id: string }[]).map(async (d) => {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}?format=metadata&metadataHeaders=Subject`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!r.ok) return;
        const data = await r.json();
        const headers: { name: string; value: string }[] = data.message?.payload?.headers ?? [];
        const subject = headers.find(h => h.name === "Subject")?.value ?? "(no subject)";
        draftDetails.push({ id: d.id, subject, snippet: data.message?.snippet ?? "" });
      }),
    );
  }

  // Check each template label
  const templateResults: Record<string, { label: string; found: boolean; subject?: string }> = {};
  await Promise.all(
    Object.entries(DRAFT_LABELS).map(async ([templateName, label]) => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/drafts?q=${encodeURIComponent(`label:${label}`)}&maxResults=1`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!r.ok) {
        templateResults[templateName] = { label, found: false };
        return;
      }
      const data = await r.json();
      const drafts = (data.drafts as { id: string }[]) ?? [];
      if (drafts.length === 0) {
        templateResults[templateName] = { label, found: false };
        return;
      }
      // Get subject of found draft
      const dr = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${drafts[0].id}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (dr.ok) {
        const dd = await dr.json();
        const headers: { name: string; value: string }[] = dd.message?.payload?.headers ?? [];
        const subject = headers.find(h => h.name === "Subject")?.value ?? "(no subject)";
        templateResults[templateName] = { label, found: true, subject };
      } else {
        templateResults[templateName] = { label, found: true };
      }
    }),
  );

  return json({
    token_scopes: tokenInfo.scope ?? tokenInfo.error ?? "unknown",
    drafts_api_status: draftsStatus,
    all_drafts: draftDetails,
    templates: templateResults,
    instructions: {
      "1_create_labels": "In Gmail: Settings → Labels → Create: dob-invite, dob-declined, dob-reschedule",
      "2_label_drafts": "Open each draft → apply the matching label",
      "3_scopes_needed": "gmail.readonly or gmail.modify (if scope missing, re-authorize OAuth)",
    },
  });
});
