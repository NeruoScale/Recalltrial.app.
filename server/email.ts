import { Resend } from "resend";
import type { Trial, User } from "@shared/schema";
import { format, parseISO } from "date-fns";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function buildReminderEmail(trial: Trial, user: User, reminderType: string): { subject: string; html: string } {
  const endFormatted = format(parseISO(trial.endDate), "MMM d");
  const endFullFormatted = format(parseISO(trial.endDate), "MMMM d, yyyy");
  const cancelLink = trial.cancelUrl || trial.serviceUrl;
  const appUrl = process.env.APP_URL || "http://localhost:5000";
  const markCanceledLink = `${appUrl}/trials/${trial.id}`;

  const subject = `RecallTrial: Cancel ${trial.serviceName} before ${endFormatted}`;

  const iconHtml = trial.iconUrl
    ? `<img src="${trial.iconUrl}" alt="${trial.serviceName}" width="48" height="48" style="border-radius:8px;margin-right:12px;" />`
    : `<div style="width:48px;height:48px;border-radius:8px;background:#2563eb;color:white;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:bold;margin-right:12px;">${trial.serviceName.charAt(0)}</div>`;

  const priceInfo = trial.renewalPrice
    ? `<p style="margin:8px 0;color:#6b7280;font-size:14px;">Renewal price: <strong>${trial.renewalPrice} ${trial.currency}</strong></p>`
    : "";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;padding:20px;">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#2563eb;padding:20px 24px;">
      <h1 style="color:white;font-size:18px;margin:0;">RecallTrial Reminder</h1>
    </div>
    <div style="padding:24px;">
      <div style="display:flex;align-items:center;margin-bottom:16px;">
        ${iconHtml}
        <div>
          <h2 style="margin:0;font-size:18px;">${trial.serviceName}</h2>
          <p style="margin:4px 0 0;color:#6b7280;font-size:14px;">${trial.domain}</p>
        </div>
      </div>

      <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin:16px 0;">
        <p style="margin:0;font-size:14px;color:#92400e;">
          <strong>Your free trial ends on ${endFullFormatted}.</strong>
          ${reminderType === "ONE_DAY" ? " That's tomorrow!" : " That's in 3 days."}
        </p>
      </div>

      ${priceInfo}

      <a href="${cancelLink}" style="display:block;text-align:center;background:#2563eb;color:white;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;margin:20px 0 12px;">
        Open cancel page
      </a>

      <a href="${trial.serviceUrl}" style="display:block;text-align:center;color:#2563eb;padding:10px;font-size:14px;text-decoration:underline;">
        Open ${trial.serviceName}
      </a>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />

      <p style="font-size:13px;color:#9ca3af;text-align:center;">
        Already canceled? <a href="${markCanceledLink}" style="color:#2563eb;">Mark as canceled</a> in RecallTrial.
      </p>
    </div>

    <div style="background:#f9fafb;padding:16px 24px;text-align:center;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">RecallTrial — Operated by SKAHM LTD (UK)</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, html };
}

export async function sendReminderEmail(trial: Trial, user: User, reminderType: string): Promise<boolean> {
  const { subject, html } = buildReminderEmail(trial, user, reminderType);

  if (!resend) {
    console.log(`[Email] Would send to ${user.email}: ${subject}`);
    console.log(`[Email] Resend API key not configured — skipping actual send`);
    return true;
  }

  try {
    await resend.emails.send({
      from: "RecallTrial <reminders@recalltrial.com>",
      to: user.email,
      subject,
      html,
    });
    console.log(`[Email] Sent reminder to ${user.email}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send to ${user.email}:`, err);
    return false;
  }
}
