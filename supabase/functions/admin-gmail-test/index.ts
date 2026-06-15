// admin-gmail-test — verify Gmail OAuth and send a test email
// GET  /functions/v1/admin-gmail-test                    → check token + scopes
// POST /functions/v1/admin-gmail-test  { recipient }     → send a test email

import { json, cors, requireAdminAuth } from "../_shared/supabase.ts";

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
  return (await res.json()).access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();
  if (!requireAdminAuth(req)) return json({ error: "Unauthorized" }, 401);

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }

  // GET — verify token works
  if (req.method === "GET") {
    const infoRes = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`,
    );
    const info = await infoRes.json();
    return json({ ok: true, scopes: info.scope ?? "unknown" });
  }

  // POST — send a test email
  if (req.method === "POST") {
    const { recipient } = await req.json();
    if (!recipient) return json({ error: "Missing recipient" }, 400);

    const fromName  = Deno.env.get("EMAIL_DISPLAY_NAME") ?? "Debbie O'Brien Casting";
    const fromEmail = Deno.env.get("GMAIL_FROM_EMAIL")!;

    const message = [
      `From: ${fromName} <${fromEmail}>`,
      `To: ${recipient}`,
      `Subject: Test Email - Audition System`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      `<p>This is a test email from the audition system.</p><p>If you can read this, Gmail sending is working correctly.</p>`,
    ].join("\r\n");

    const encoded = btoa(unescape(encodeURIComponent(message)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: encoded }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Gmail test send failed: ${errText}`);
      return json({ ok: false, error: `Send failed (${res.status}): ${errText}` }, 500);
    }

    const result = await res.json();
    console.log(`Test email sent to ${recipient}, messageId=${result.id}`);
    return json({ ok: true, messageId: result.id });
  }

  return json({ error: "Method not allowed" }, 405);
});
