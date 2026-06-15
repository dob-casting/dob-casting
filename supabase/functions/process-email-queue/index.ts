// process-email-queue — self-healing email engine
// POST /functions/v1/process-email-queue
//
// Templates are read from Gmail drafts labelled:
//   dob-invite       → initial_invite
//   dob-declined     → declined_notification
//   dob-reschedule   → reschedule_confirmation
//
// Falls back to the email_templates DB table if no labelled draft is found.
//
// Called after fill-initial-schedule, after actor-action, and every minute by pg_cron.

import { getSupabaseAdmin, json, cors } from "../_shared/supabase.ts";

const MAX_ATTEMPTS = 5;
const BATCH_SIZE   = 20;


// ─── Gmail OAuth2 ─────────────────────────────────────────────────────────────

async function getGmailAccessToken(): Promise<string> {
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
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token as string;
}

// ─── Gmail draft template fetching ───────────────────────────────────────────

function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "==".slice(0, (4 - (base64.length % 4)) % 4);
  return atob(padded);
}

function extractHtmlFromPayload(payload: Record<string, unknown>): string {
  const mimeType = payload.mimeType as string | undefined;
  const body = payload.body as Record<string, unknown> | undefined;
  const parts = payload.parts as Record<string, unknown>[] | undefined;

  if (mimeType === "text/html" && body?.data) {
    return base64UrlDecode(body.data as string);
  }
  if (parts) {
    // Look for text/html in parts
    for (const part of parts) {
      if (part.mimeType === "text/html" && (part.body as Record<string, unknown>)?.data) {
        return base64UrlDecode(((part.body as Record<string, unknown>).data) as string);
      }
      if ((part.mimeType as string)?.startsWith("multipart/")) {
        const nested = extractHtmlFromPayload(part);
        if (nested) return nested;
      }
    }
    // Fall back to plain text wrapped in <pre>
    for (const part of parts) {
      if (part.mimeType === "text/plain" && (part.body as Record<string, unknown>)?.data) {
        const text = base64UrlDecode(((part.body as Record<string, unknown>).data) as string);
        return `<pre style="white-space:pre-wrap;font-family:sans-serif">${text}</pre>`;
      }
    }
  }
  if (body?.data) return base64UrlDecode(body.data as string);
  return "";
}

// Fetches all Gmail drafts and returns a map of subject -> { id, subject }.
// Results are cached for the lifetime of the invocation.
let _draftCache: { id: string; subject: string }[] | null = null;

async function listAllDrafts(accessToken: string): Promise<{ id: string; subject: string }[]> {
  if (_draftCache) return _draftCache;

  const allDrafts: { id: string; messageId: string }[] = [];
  let pageToken: string | undefined;

  // Paginate through all drafts
  do {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) break;
    const data = await res.json();
    for (const d of (data.drafts ?? []) as { id: string; message: { id: string } }[]) {
      allDrafts.push({ id: d.id, messageId: d.message.id });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  // Fetch subject header for each draft in parallel
  const results = await Promise.all(
    allDrafts.map(async (d) => {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) return null;
      const data = await res.json();
      const headers = (data.message?.payload?.headers ?? []) as { name: string; value: string }[];
      const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
      return { id: d.id, subject };
    }),
  );

  _draftCache = results.filter((r): r is { id: string; subject: string } => r !== null);
  return _draftCache;
}

// Normalise dashes, whitespace and case for fuzzy subject matching.
// Gmail often converts hyphens to en/em dashes in draft subjects.
function normalise(s: string): string {
  return s
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\uFE58\uFE63\uFF0D\u002D]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function getDraftTemplate(
  accessToken: string,
  templateName: string,
): Promise<{ subject: string; htmlBody: string } | null> {
  if (!templateName) return null;

  try {
    const drafts = await listAllDrafts(accessToken);
    const target = normalise(templateName);
    const match = drafts.find((d) => normalise(d.subject) === target);
    if (!match) return null;

    // Fetch full content of the matched draft
    const draftRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${match.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!draftRes.ok) return null;

    const draftData = await draftRes.json();
    const payload = draftData.message?.payload as Record<string, unknown> | undefined;
    if (!payload) return null;

    const htmlBody = extractHtmlFromPayload(payload);
    return { subject: match.subject, htmlBody };
  } catch {
    return null;
  }
}

// ─── Send one email via Gmail API ─────────────────────────────────────────────

async function sendGmailEmail(
  accessToken: string,
  to: string,
  subject: string,
  htmlBody: string,
  fromName: string,
  fromEmail: string,
  cc?: string | null,
): Promise<void> {
  const headers = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${to}`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  headers.push(
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
  );
  const message = [...headers, ``, htmlBody].join("\r\n");

  const encoded = btoa(unescape(encodeURIComponent(message)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });

  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
}

// ─── Template rendering ───────────────────────────────────────────────────────

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars[key.trim()] ?? "");
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  const supabase = getSupabaseAdmin();
  const fromName  = Deno.env.get("EMAIL_DISPLAY_NAME") ?? "Debbie O'Brien Casting";
  const fromEmail = Deno.env.get("GMAIL_FROM_EMAIL")!;

  // Claim a batch of pending or failed rows
  const { data: rows, error: fetchErr } = await supabase
    .from("email_queue")
    .select("id, slot_id, recipient_email, template_name, template_vars, attempts, cc")
    .in("status", ["pending", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) return json({ error: fetchErr.message }, 500);
  if (!rows || rows.length === 0) return json({ processed: 0, sent: 0, failed: 0 });

  // Mark all claimed rows as 'sending'
  const ids = rows.map((r) => r.id);
  await supabase
    .from("email_queue")
    .update({ status: "sending", last_attempt_at: new Date().toISOString() })
    .in("id", ids);

  // Get Gmail access token
  let accessToken: string;
  try {
    accessToken = await getGmailAccessToken();
  } catch (err) {
    await Promise.all(rows.map((row) =>
      supabase.from("email_queue")
        .update({ status: "failed", last_error: String(err), attempts: row.attempts + 1 })
        .eq("id", row.id)
    ));
    return json({ error: "Gmail token refresh failed", detail: String(err) }, 500);
  }

  // Fetch templates — try Gmail drafts first, fall back to DB
  const templateNames = [...new Set(rows.map((r) => r.template_name as string))];
  const templateMap: Record<string, { subject: string; html_body: string }> = {};

  // Try Gmail drafts in parallel
  await Promise.all(
    templateNames.map(async (name) => {
      const draft = await getDraftTemplate(accessToken, name);
      if (draft) templateMap[name] = { subject: draft.subject, html_body: draft.htmlBody };
    }),
  );


  // Send all emails in parallel
  const results = await Promise.allSettled(
    rows.map(async (row) => {
      const tmpl = templateMap[row.template_name as string];
      if (!tmpl) throw new Error(`Template not found: ${row.template_name}`);

      const vars = row.template_vars as Record<string, string>;
      // Use the configured subject line (from template_name) with placeholders rendered
      const subject  = renderTemplate(row.template_name as string, vars);
      const htmlBody = renderTemplate(tmpl.html_body, vars);

      await sendGmailEmail(accessToken, row.recipient_email as string, subject, htmlBody, fromName, fromEmail, row.cc as string | null);
      return row.id;
    }),
  );

  // Update each row
  await Promise.all(results.map(async (result, i) => {
    const row = rows[i];
    const newAttempts = (row.attempts as number) + 1;

    if (result.status === "fulfilled") {
      await supabase.from("email_queue")
        .update({ status: "sent", sent_at: new Date().toISOString(), attempts: newAttempts })
        .eq("id", row.id);
    } else {
      const isDead = newAttempts >= MAX_ATTEMPTS;
      await supabase.from("email_queue")
        .update({
          status: isDead ? "dead" : "failed",
          last_error: String(result.reason),
          attempts: newAttempts,
        })
        .eq("id", row.id);
    }
  }));

  const sent   = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  return json({ processed: rows.length, sent, failed });
});
