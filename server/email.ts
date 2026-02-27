import { Resend } from "resend";
import type { Trial, User } from "@shared/schema";
import { format, parseISO } from "date-fns";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function getFromEmail(): string {
  return process.env.FROM_EMAIL || "RecallTrial <onboarding@resend.dev>";
}

function getReplyToEmail(): string | undefined {
  return process.env.REPLY_TO_EMAIL || undefined;
}

function buildReminderEmail(trial: Trial, user: User, reminderType: string): { subject: string; html: string } {
  const daysMap: Record<string, number> = {
    "THREE_DAYS": 3,
    "TWO_DAYS": 2,
    "ONE_DAY": 1,
    "TWENTY_FOUR_HOURS": 1,
  };
  const daysRemaining = daysMap[reminderType] || 1;
  const endFullFormatted = format(parseISO(trial.endDate), "MMM d, yyyy 'at' 11:59 PM");
  const cancelLink = trial.cancelUrl || trial.serviceUrl;

  const subject = `[RecallTrial] ${trial.serviceName} renews in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}`;

  const priceInfo = trial.renewalPrice
    ? `<p style="margin:16px 0;font-size:16px;color:#374151;">Renewal amount: <strong>${trial.renewalPrice} ${trial.currency}</strong></p>`
    : "";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#ffffff;padding:20px;color:#111827;line-height:1.5;">
  <div style="max-width:500px;margin:0 auto;">
    <h1 style="font-size:20px;font-weight:700;margin-bottom:24px;">Reminder: ${trial.serviceName} renews in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}</h1>
    
    <p style="margin-bottom:8px;">Your ${trial.serviceName} subscription renews on:</p>
    <p style="font-size:18px;font-weight:600;margin-bottom:16px;">${endFullFormatted}</p>

    ${priceInfo}

    <p style="margin-top:24px;margin-bottom:24px;">If you don’t want to be charged, cancel before this date.</p>

    <a href="${cancelLink}" style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;">
      Cancel Subscription
    </a>

    <div style="margin-top:48px;padding-top:24px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px;">
      <p style="margin-bottom:8px;">You’re receiving this because you added this trial to RecallTrial.</p>
      <p>We never access your inbox without your permission.</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, html };
}

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendReminderEmail(trial: Trial, user: User, reminderType: string): Promise<EmailSendResult> {
  const { subject, html } = buildReminderEmail(trial, user, reminderType);

  if (!resend) {
    console.log(`[Email] Would send to ${user.email}: ${subject}`);
    console.log(`[Email] Resend API key not configured — skipping actual send`);
    return { success: true, messageId: "console-only" };
  }

  const fromEmail = getFromEmail();
  const replyTo = getReplyToEmail();

  try {
    const sendOptions: any = {
      from: fromEmail,
      to: user.email,
      subject,
      html,
    };
    if (replyTo) {
      sendOptions.replyTo = replyTo;
    }

    const result = await resend.emails.send(sendOptions);
    if (result?.error) {
      const errorMessage = result.error.message || JSON.stringify(result.error);
      console.error(`[Email] Resend rejected send to ${user.email}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
    const messageId = result?.data?.id || undefined;
    console.log(`[Email] Sent reminder to ${user.email}: ${subject} (id: ${messageId})`);
    return { success: true, messageId };
  } catch (err: any) {
    const errorMessage = err?.message || String(err);
    console.error(`[Email] Failed to send to ${user.email}:`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

export async function sendTestEmail(to: string, subject?: string, message?: string): Promise<EmailSendResult & { usedFromEmail: string; usedReplyToEmail: string | null }> {
  const fromEmail = getFromEmail();
  const replyTo = getReplyToEmail();

  if (!resend) {
    console.log(`[Email] Test email skipped — Resend API key not configured`);
    return {
      success: false,
      error: "Resend API key not configured",
      usedFromEmail: fromEmail,
      usedReplyToEmail: replyTo || null,
    };
  }

  const emailSubject = subject || "RecallTrial Test Email";
  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;padding:20px;">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#2563eb;padding:20px 24px;">
      <h1 style="color:white;font-size:18px;margin:0;">RecallTrial Test</h1>
    </div>
    <div style="padding:24px;">
      <p style="font-size:16px;color:#111827;">${message || "If you see this, Resend email delivery is working."}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
      <p style="font-size:13px;color:#9ca3af;">From: ${fromEmail}</p>
      ${replyTo ? `<p style="font-size:13px;color:#9ca3af;">Reply-To: ${replyTo}</p>` : ""}
    </div>
  </div>
</body>
</html>`;

  try {
    const sendOptions: any = {
      from: fromEmail,
      to,
      subject: emailSubject,
      html: emailHtml,
    };
    if (replyTo) {
      sendOptions.replyTo = replyTo;
    }

    const result = await resend.emails.send(sendOptions);
    if (result?.error) {
      const errorMessage = result.error.message || JSON.stringify(result.error);
      console.error(`[Email] Resend rejected test email:`, errorMessage);
      return { success: false, error: errorMessage, usedFromEmail: fromEmail, usedReplyToEmail: replyTo || null };
    }
    const messageId = result?.data?.id || undefined;
    console.log(`[Email] Resend test email queued (id: ${messageId})`);
    return { success: true, messageId, usedFromEmail: fromEmail, usedReplyToEmail: replyTo || null };
  } catch (err: any) {
    const errorMessage = err?.message || String(err);
    console.error(`[Email] Resend test email failed:`, errorMessage);
    return { success: false, error: errorMessage, usedFromEmail: fromEmail, usedReplyToEmail: replyTo || null };
  }
}
