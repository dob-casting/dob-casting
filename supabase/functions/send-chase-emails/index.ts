// send-chase-emails — daily chase email scheduler
// POST /functions/v1/send-chase-emails
//
// Queues chase emails (template "chase", Gmail label "dob-chase") for slots
// whose status is not "confirmed". Only runs on UK working days (Mon-Fri,
// 8am-6pm, excluding England & Wales bank holidays). At most 5 emails are
// queued per invocation to avoid overwhelming the inbox.
//
// Chase starts the next working day after the initial invite was sent.
// Chasing stops 48 hours before the appointment.
// One chase per slot per calendar day (enforced via idempotency_key).
//
// Called every minute by pg_cron.

import { getSupabaseAdmin, json, cors } from "../_shared/supabase.ts";

const MAX_PER_RUN = 5;
const STATUSES_TO_CHASE = ["invite_sent", "auto_booked", "rescheduled"];

// ─── UK timezone helpers ──────────────────────────────────────────────────────

// Returns the date string (YYYY-MM-DD) for a given Date in the Europe/London timezone.
function ukDateStr(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Returns the current hour (0-23) in Europe/London time.
function ukHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  return parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
}

// Returns 0=Sun, 1=Mon, ..., 6=Sat for a YYYY-MM-DD date string.
// Uses noon UTC so the result is stable regardless of BST/GMT.
function weekdayOfDateStr(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

// Returns the UTC Date corresponding to a specific UK local hour on a given
// YYYY-MM-DD date (handles both GMT and BST automatically).
function ukHourToDate(dateStr: string, targetUkHour: number): Date {
  const d = new Date(`${dateStr}T${String(targetUkHour).padStart(2, "0")}:00:00Z`);
  const actual = ukHour(d);
  if (actual !== targetUkHour) {
    d.setTime(d.getTime() + (targetUkHour - actual) * 60 * 60 * 1000);
  }
  return d;
}

// Returns the number of working hours (Mon-Fri, 08:00-18:00 UK, excluding bank
// holidays) that elapsed between two timestamps.
function workingHoursElapsed(from: Date, to: Date, bankHolidays: Set<string>): number {
  if (from >= to) return 0;
  let total = 0;
  // Walk day by day from the UK date of 'from' to the UK date of 'to'.
  const d = new Date(`${ukDateStr(from)}T12:00:00Z`);
  const lastDay = new Date(`${ukDateStr(to)}T12:00:00Z`);
  while (d <= lastDay) {
    const dateStr = ukDateStr(d);
    const wd = weekdayOfDateStr(dateStr);
    if (wd >= 1 && wd <= 5 && !bankHolidays.has(dateStr)) {
      const windowStart = ukHourToDate(dateStr, 8);
      const windowEnd   = ukHourToDate(dateStr, 18);
      const overlapStart = Math.max(from.getTime(), windowStart.getTime());
      const overlapEnd   = Math.min(to.getTime(),   windowEnd.getTime());
      if (overlapEnd > overlapStart) {
        total += (overlapEnd - overlapStart) / (60 * 60 * 1000);
      }
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return total;
}

// ─── Bank holidays ────────────────────────────────────────────────────────────

async function fetchBankHolidays(): Promise<Set<string>> {
  try {
    const res = await fetch("https://www.gov.uk/bank-holidays.json");
    if (!res.ok) return new Set();
    const data = await res.json();
    const events = (data["england-and-wales"]?.events ?? []) as { date: string }[];
    return new Set(events.map((e) => e.date));
  } catch {
    return new Set();
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();

  const now = new Date();
  const todayUK = ukDateStr(now);

  // 1. Working hours gate (Mon-Fri, 08:00-17:59 UK time)
  const wd = weekdayOfDateStr(todayUK);
  const hour = ukHour(now);
  if (wd < 1 || wd > 5 || hour < 8 || hour >= 18) {
    return json({ skipped: "outside working hours" });
  }

  // 2. Bank holiday check
  const bankHolidays = await fetchBankHolidays();
  if (bankHolidays.has(todayUK)) {
    return json({ skipped: "bank holiday" });
  }

  const supabase = getSupabaseAdmin();

  // 3. Query unconfirmed slots that have an actor assigned.
  //    Use slot_date >= todayUK as a coarse pre-filter; precise 48h check happens in JS.
  const { data: slots, error: slotsErr } = await supabase
    .from("slots")
    .select(`
      id, project_id, first_name, last_name, email, role, agent,
      slot_date, slot_time, short_link,
      projects ( cc_email, chase_paused )
    `)
    .in("status", STATUSES_TO_CHASE)
    .not("email", "is", null)
    .gte("slot_date", todayUK);

  if (slotsErr) return json({ error: slotsErr.message }, 500);
  if (!slots || slots.length === 0) return json({ queued: 0 });

  const slotIds = slots.map((s) => s.id as string);

  // 4. Find when the first email was sent for each slot (i.e. the invite).
  const { data: inviteRows } = await supabase
    .from("email_queue")
    .select("slot_id, sent_at")
    .in("slot_id", slotIds)
    .eq("status", "sent")
    .order("sent_at", { ascending: true });

  // Keep only the most recent invite per slot.
  const inviteSentAt: Record<string, string> = {};
  for (const row of inviteRows ?? []) {
    const sid = row.slot_id as string;
    if (!inviteSentAt[sid]) inviteSentAt[sid] = row.sent_at as string;
  }

  // 5. Get slot IDs that have already been chased today.
  const { data: chasedRows } = await supabase
    .from("email_queue")
    .select("idempotency_key")
    .like("idempotency_key", `chase-%-${todayUK}`);

  const chasedToday = new Set<string>(
    (chasedRows ?? []).map((r) => {
      // idempotency_key = "chase-{uuid}-YYYY-MM-DD"
      const key = r.idempotency_key as string;
      return key.slice("chase-".length, key.length - `-${todayUK}`.length);
    }),
  );

  // 6. Filter candidates
  const cutoffMs = now.getTime() + 48 * 60 * 60 * 1000;

  const candidates = slots.filter((slot) => {
    // Skip slots from projects with chase paused.
    const proj = slot.projects as { cc_email: string | null; chase_paused: boolean } | null;
    if (proj?.chase_paused) return false;
    // Precise 48h check: appointment must be more than 48h away.
    const appointmentMs = new Date(`${slot.slot_date}T${slot.slot_time}Z`).getTime();
    if (appointmentMs <= cutoffMs) return false;

    // Skip if already chased today.
    if (chasedToday.has(slot.id as string)) return false;

    // Don't chase on the same day the invite was sent (wait until the next working day).
    // If no invite is found in the queue (pre-existing booking), chase immediately.
    const inviteAt = inviteSentAt[slot.id as string];
    if (inviteAt && ukDateStr(new Date(inviteAt)) === todayUK) return false;

    return true;
  });

  if (candidates.length === 0) return json({ queued: 0 });

  // 7. Take first MAX_PER_RUN and insert into email_queue.
  const batch = candidates.slice(0, MAX_PER_RUN);

  const rows = batch.map((slot) => {
    const project = slot.projects as { cc_email: string | null; chase_paused: boolean } | null;
    const dateStr = slot.slot_date as string;
    const timeStr = (slot.slot_time as string).slice(0, 5); // HH:MM

    const formattedDate = new Date(dateStr).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    return {
      slot_id:          slot.id,
      project_id:       slot.project_id,
      recipient_email:  slot.email,
      template_name:    "chase",
      template_vars:    {
        "First Name":  slot.first_name ?? "",
        "Second Name": slot.last_name ?? "",
        "Role":        slot.role ?? "",
        "Agent":       slot.agent ?? "",
        "Date":        formattedDate,
        "Time":        timeStr,
        "Magic Link":  slot.short_link ?? "",
      },
      status:           "pending",
      idempotency_key:  `chase-${slot.id}-${todayUK}`,
      cc:               project?.cc_email ?? null,
    };
  });

  const { error: upsertErr } = await supabase
    .from("email_queue")
    .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });

  if (upsertErr) return json({ error: upsertErr.message }, 500);

  return json({ queued: batch.length });
});
