// BCE Comics Pod — Admin Notification Edge Function
// Triggered by the client after a new user registers via Google OAuth.
//
// Deploy:
//   supabase functions deploy notify-admin
//
// Required environment variables (set in Supabase Dashboard → Edge Functions → Secrets):
//   ADMIN_EMAIL      — address to receive the notification
//   RESEND_API_KEY   — API key from https://resend.com (free tier: 100 emails/day)
//   FROM_EMAIL       — verified sender address (default: noreply@bcecomics.app)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://stojr.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const ADMIN_EMAIL   = Deno.env.get("ADMIN_EMAIL")    ?? "";
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
  const FROM_EMAIL    = Deno.env.get("FROM_EMAIL")     ?? "noreply@bcecomics.app";

  if (!ADMIN_EMAIL) {
    // Not configured — silently succeed so client code never sees an error
    return new Response(JSON.stringify({ ok: true, skipped: "ADMIN_EMAIL not set" }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "RESEND_API_KEY not set" }), {
      status: 503,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let payload: { username?: string; email?: string; registered_at?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400, headers: CORS_HEADERS });
  }

  const { username = "Unknown", email = "—", registered_at = new Date().toISOString() } = payload;
  const registeredFormatted = new Date(registered_at).toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const emailBody = {
    from:    FROM_EMAIL,
    to:      ADMIN_EMAIL,
    subject: `BCE Comics: New user — ${username}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#16161e;color:#f0f3ff;border-radius:8px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#e8352a,#ff9f2a,#ffd234);padding:20px 24px">
          <h1 style="font-size:24px;font-weight:900;letter-spacing:2px;margin:0;color:#000">BCE COMICS POD</h1>
          <p style="font-size:12px;letter-spacing:3px;text-transform:uppercase;margin:4px 0 0;color:rgba(0,0,0,.7)">Epic Database</p>
        </div>
        <div style="padding:24px">
          <h2 style="font-size:20px;margin:0 0 16px;color:#ffd234">New User Registered</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #2e2e3e;color:#9a9abf;font-size:13px;width:120px">Username</td>
              <td style="padding:8px 0;border-bottom:1px solid #2e2e3e;font-weight:700">${escHtml(username)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #2e2e3e;color:#9a9abf;font-size:13px">Email</td>
              <td style="padding:8px 0;border-bottom:1px solid #2e2e3e">${escHtml(email)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#9a9abf;font-size:13px">Registered</td>
              <td style="padding:8px 0">${escHtml(registeredFormatted)} (AEST)</td>
            </tr>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#7a7a9a">
            This notification was sent automatically by the BCE Comics Pod Epic Database.
          </p>
        </div>
      </div>
    `,
  };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(emailBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Resend error:", errText);
      return new Response(JSON.stringify({ ok: false, error: errText }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    return new Response(JSON.stringify({ ok: true, id: data.id }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
