import { Logger } from '@nestjs/common';
import axios from 'axios';
import { USER_FEATURE_KEYS, USER_FEATURE_LABELS, UserFeatureKey } from './identity.util';

export interface InviteEmailInput {
  toEmail: string;
  memberName: string;
  role: string;
  userCode: string;
  accountId: string;
  workspaceName: string;
  inviterName: string;
  inviteUrl: string;
  temporaryPassword?: string | null;
  featureAccess: Record<UserFeatureKey, boolean>;
}

export interface InviteEmailDispatchResult {
  sent: boolean;
  provider: 'resend' | 'postmark' | 'webhook' | 'preview';
  inviteUrl: string;
  emailSubject: string;
  emailPreview: string;
  error?: string;
}

const logger = new Logger('InviteEmailService');

function formatRoleLabel(role: string): string {
  if (role === 'manager') return 'Sales Manager';
  if (role === 'agent') return 'Sales User';
  if (role === 'admin') return 'Workspace Admin';
  return role;
}

export async function dispatchTeamInviteEmail(
  input: InviteEmailInput,
): Promise<InviteEmailDispatchResult> {
  const roleLabel = formatRoleLabel(input.role);
  const enabledFeatures = USER_FEATURE_KEYS.filter((k) => input.featureAccess[k]).map(
    (k) => USER_FEATURE_LABELS[k],
  );

  const emailSubject = `You're invited to ${input.workspaceName} on Leadsetu CRM (${roleLabel})`;
  const emailPreview = [
    `Hi ${input.memberName},`,
    '',
    `${input.inviterName} has invited you to join ${input.workspaceName} as a ${roleLabel}.`,
    '',
    `Workspace Account ID: #${input.accountId}`,
    `Your 10-Digit User ID: #${input.userCode}`,
    `Login Email: ${input.toEmail}`,
    ...(input.temporaryPassword
      ? [`Temporary Password: ${input.temporaryPassword}`]
      : []),
    '',
    `Assigned Modules (${enabledFeatures.length}): ${enabledFeatures.length ? enabledFeatures.join(', ') : 'Dashboard & Profile'}`,
    '',
    `Click this link to activate & sign in:`,
    input.inviteUrl,
    '',
    `This link expires in 7 days.`,
  ].join('\n');

  const htmlBody = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f8faff;border:1px solid #e2e8f0;border-radius:16px;color:#0f172a;">
      <h2 style="margin:0 0 8px;color:#0f172a;">Welcome to ${input.workspaceName} on Leadsetu CRM</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;">
        Hi <strong>${input.memberName}</strong>, ${input.inviterName} has created your <strong>${roleLabel}</strong> account.
      </p>
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:16px;font-size:13px;">
        <div><strong>Workspace Account ID:</strong> #${input.accountId}</div>
        <div><strong>Your User ID:</strong> #${input.userCode}</div>
        <div><strong>Login Email:</strong> ${input.toEmail}</div>
        ${input.temporaryPassword ? `<div><strong>Temporary Password:</strong> ${input.temporaryPassword}</div>` : ''}
      </div>
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1e293b;">Assigned CRM Features (${enabledFeatures.length}):</p>
      <p style="margin:0 0 20px;font-size:12px;color:#475569;">${enabledFeatures.length ? enabledFeatures.join(' · ') : 'Personal Dashboard & Profile'}</p>
      <a href="${input.inviteUrl}" style="display:inline-block;padding:12px 22px;background:#0057ff;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;font-size:14px;">
        Open Invite Link &amp; Sign In
      </a>
      <p style="margin:16px 0 0;font-size:11px;color:#64748b;">Or copy this URL into your browser: ${input.inviteUrl}</p>
    </div>
  `.trim();

  const fromEmail = process.env.EMAIL_FROM || 'noreply@leadsetu.in';

  if (process.env.RESEND_API_KEY) {
    try {
      await axios.post(
        'https://api.resend.com/emails',
        {
          from: fromEmail,
          to: [input.toEmail],
          subject: emailSubject,
          html: htmlBody,
          text: emailPreview,
        },
        {
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          timeout: 8000,
        },
      );
      return { sent: true, provider: 'resend', inviteUrl: input.inviteUrl, emailSubject, emailPreview };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Resend invite dispatch failed for ${input.toEmail}: ${msg}`);
      return { sent: false, provider: 'preview', inviteUrl: input.inviteUrl, emailSubject, emailPreview, error: msg };
    }
  }

  const postmarkKey =
    process.env.POSTMARK_API_KEY ||
    (process.env.EMAIL_PROVIDER === 'postmark' ? process.env.EMAIL_API_KEY : undefined);
  if (postmarkKey) {
    try {
      await axios.post(
        'https://api.postmarkapp.com/email',
        {
          From: fromEmail,
          To: input.toEmail,
          Subject: emailSubject,
          HtmlBody: htmlBody,
          TextBody: emailPreview,
        },
        {
          headers: { 'X-Postmark-Server-Token': postmarkKey },
          timeout: 8000,
        },
      );
      return { sent: true, provider: 'postmark', inviteUrl: input.inviteUrl, emailSubject, emailPreview };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Postmark invite dispatch failed for ${input.toEmail}: ${msg}`);
      return { sent: false, provider: 'preview', inviteUrl: input.inviteUrl, emailSubject, emailPreview, error: msg };
    }
  }

  const webhookUrl = process.env.EMAIL_WEBHOOK_URL || process.env.SMTP_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await axios.post(
        webhookUrl,
        { to: input.toEmail, from: fromEmail, subject: emailSubject, html: htmlBody, text: emailPreview, inviteUrl: input.inviteUrl },
        { timeout: 8000 },
      );
      return { sent: true, provider: 'webhook', inviteUrl: input.inviteUrl, emailSubject, emailPreview };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Webhook invite dispatch failed for ${input.toEmail}: ${msg}`);
      return { sent: false, provider: 'preview', inviteUrl: input.inviteUrl, emailSubject, emailPreview, error: msg };
    }
  }

  logger.log(`[INVITE EMAIL PREVIEW -> ${input.toEmail}] ${input.inviteUrl}`);
  return {
    sent: false,
    provider: 'preview',
    inviteUrl: input.inviteUrl,
    emailSubject,
    emailPreview,
  };
}
