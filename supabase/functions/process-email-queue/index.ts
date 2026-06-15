// process-email-queue — email sending engine
// POST /functions/v1/process-email-queue
//
// Templates (subject + html_body) are loaded from the email_templates DB table.
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

// ─── Send one email via Gmail API ─────────────────────────────────────────────

async function sendGmailEmail(
  accessToken: string,
  to: string,
  subject: string,
  htmlBody: string,
  fromName: string,
  fromEmail: string,
  cc?: string | null,
): Promise<string> {
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
  const result = await res.json();
  return result.id ?? "unknown";
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

  // 1. Claim a batch of pending or failed rows
  const { data: rows, error: fetchErr } = await supabase
    .from("email_queue")
    .select("id, slot_id, recipient_email, template_name, template_vars, attempts, cc")
    .in("status", ["pending", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error("Failed to fetch queue:", fetchErr.message);
    return json({ error: fetchErr.message }, 500);
  }
  if (!rows || rows.length === 0) return json({ processed: 0, sent: 0, failed: 0 });

  console.log(`Claimed ${rows.length} email(s) for processing`);

  // 2. Mark all claimed rows as 'sending'
  const ids = rows.map((r) => r.id);
  await supabase
    .from("email_queue")
    .update({ status: "sending", last_attempt_at: new Date().toISOString() })
    .in("id", ids);

  // 3. Get Gmail access token
  let accessToken: string;
  try {
    accessToken = await getGmailAccessToken();
    console.log("Gmail access token refreshed");
  } catch (err) {
    console.error("Gmail token refresh failed:", String(err));
    await Promise.all(rows.map((row) =>
      supabase.from("email_queue")
        .update({ status: "failed", last_error: String(err), attempts: row.attempts + 1 })
        .eq("id", row.id)
    ));
    return json({ error: "Gmail token refresh failed", detail: String(err) }, 500);
  }

  // 4. Load templates from DB
  const templateNames = [...new Set(rows.map((r) => r.template_name as string))];
  const { data: dbTemplates, error: tmplErr } = await supabase
    .from("email_templates")
    .select("name, subject, html_body")
    .in("name", templateNames);

  if (tmplErr) {
    console.error("Failed to load templates:", tmplErr.message);
    await Promise.all(rows.map((row) =>
      supabase.from("email_queue")
        .update({ status: "failed", last_error: `Template load failed: ${tmplErr.message}`, attempts: row.attempts + 1 })
        .eq("id", row.id)
    ));
    return json({ error: "Template load failed", detail: tmplErr.message }, 500);
  }

  const templateMap: Record<string, { subject: string; html_body: string }> = {};
  for (const t of dbTemplates ?? []) {
    if (!t.subject || !t.html_body) {
      console.warn(`Template "${t.name}": missing subject or html_body, skipping`);
      continue;
    }
    console.log(`Template "${t.name}": loaded (subject: "${t.subject}")`);
    templateMap[t.name] = { subject: t.subject, html_body: t.html_body };
  }

  const missing = templateNames.filter((n) => !templateMap[n]);
  if (missing.length > 0) {
    console.error(`Missing templates: ${missing.join(", ")}`);
  }

  // 5. Send all emails in parallel
  const results = await Promise.allSettled(
    rows.map(async (row) => {
      const tmpl = templateMap[row.template_name as string];
      if (!tmpl) throw new Error(`Template not found: ${row.template_name}. Create it in the admin portal.`);

      const vars = row.template_vars as Record<string, string>;
      const subject  = renderTemplate(tmpl.subject, vars);
      const htmlBody = renderTemplate(tmpl.html_body, vars);

      console.log(`Sending: to=${row.recipient_email} template=${row.template_name} subject="${subject}"`);
      const msgId = await sendGmailEmail(accessToken, row.recipient_email as string, subject, htmlBody, fromName, fromEmail, row.cc as string | null);
      console.log(`Sent: to=${row.recipient_email} msgId=${msgId}`);
      return row.id;
    }),
  );

  // 6. Update each row
  await Promise.all(results.map(async (result, i) => {
    const row = rows[i];
    const newAttempts = (row.attempts as number) + 1;

    if (result.status === "fulfilled") {
      await supabase.from("email_queue")
        .update({ status: "sent", sent_at: new Date().toISOString(), attempts: newAttempts })
        .eq("id", row.id);
    } else {
      const isDead = newAttempts >= MAX_ATTEMPTS;
      console.error(`Failed row ${row.id} (attempt ${newAttempts}): ${result.reason}`);
      if (isDead) console.error(`Row ${row.id} marked as dead after ${newAttempts} attempts`);
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
  console.log(`Batch complete: ${sent} sent, ${failed} failed out of ${rows.length}`);
  return json({ processed: rows.length, sent, failed });
});
