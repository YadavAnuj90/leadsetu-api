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
  companyName?: string;
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

export interface PasswordResetEmailInput {
  toEmail: string;
  memberName: string;
  workspaceName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface EmailDispatchResult {
  sent: boolean;
  provider: 'resend' | 'postmark' | 'webhook' | 'preview';
  error?: string;
}

const logger = new Logger('AuthEmailService');

function formatRoleLabel(role: string): string {
  if (role === 'manager') return 'Sales Manager';
  if (role === 'agent') return 'Sales User';
  if (role === 'admin') return 'Workspace Admin';
  return role;
}

async function dispatchTransactionalEmail(params: {
  toEmail: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  actionUrl: string;
  logLabel: string;
}): Promise<EmailDispatchResult> {
  const fromEmail = process.env.EMAIL_FROM || 'noreply@leadsetu.in';

  if (process.env.RESEND_API_KEY) {
    try {
      await axios.post(
        'https://api.resend.com/emails',
        {
          from: fromEmail,
          to: [params.toEmail],
          subject: params.subject,
          html: params.htmlBody,
          text: params.textBody,
        },
        {
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          timeout: 8000,
        },
      );
      return { sent: true, provider: 'resend' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Resend ${params.logLabel} dispatch failed for ${params.toEmail}: ${msg}`);
      return { sent: false, provider: 'preview', error: msg };
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
          To: params.toEmail,
          Subject: params.subject,
          HtmlBody: params.htmlBody,
          TextBody: params.textBody,
        },
        {
          headers: { 'X-Postmark-Server-Token': postmarkKey },
          timeout: 8000,
        },
      );
      return { sent: true, provider: 'postmark' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Postmark ${params.logLabel} dispatch failed for ${params.toEmail}: ${msg}`);
      return { sent: false, provider: 'preview', error: msg };
    }
  }

  const webhookUrl = process.env.EMAIL_WEBHOOK_URL || process.env.SMTP_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await axios.post(
        webhookUrl,
        {
          to: params.toEmail,
          from: fromEmail,
          subject: params.subject,
          html: params.htmlBody,
          text: params.textBody,
          actionUrl: params.actionUrl,
        },
        { timeout: 8000 },
      );
      return { sent: true, provider: 'webhook' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Webhook ${params.logLabel} dispatch failed for ${params.toEmail}: ${msg}`);
      return { sent: false, provider: 'preview', error: msg };
    }
  }

  logger.log(`[${params.logLabel.toUpperCase()} PREVIEW -> ${params.toEmail}] ${params.actionUrl}`);
  return { sent: false, provider: 'preview' };
}

export async function dispatchTeamInviteEmail(
  input: InviteEmailInput,
): Promise<InviteEmailDispatchResult> {
  const roleLabel = formatRoleLabel(input.role);
  const enabledFeatures = USER_FEATURE_KEYS.filter((k) => input.featureAccess[k]).map(
    (k) => USER_FEATURE_LABELS[k],
  );

  // Send company name in invitations; fall back to admin/inviter name only when no company name is configured.
  const companyLabel = input.companyName?.trim() || '';
  const senderDisplayName =
    companyLabel || input.inviterName?.trim() || 'Leadsetu CRM';

  const emailSubject = `You're invited to ${senderDisplayName} on Leadsetu CRM (${roleLabel})`;
  const emailPreview = [
    `Hi ${input.memberName},`,
    '',
    `${senderDisplayName} has invited you to join Leadsetu CRM as a ${roleLabel}.`,
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
      <h2 style="margin:0 0 8px;color:#0f172a;">Welcome to ${senderDisplayName} on Leadsetu CRM</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;">
        Hi <strong>${input.memberName}</strong>, <strong>${senderDisplayName}</strong> has created your <strong>${roleLabel}</strong> account and invited you to Leadsetu CRM.
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

  const dispatch = await dispatchTransactionalEmail({
    toEmail: input.toEmail,
    subject: emailSubject,
    htmlBody,
    textBody: emailPreview,
    actionUrl: input.inviteUrl,
    logLabel: 'invite email',
  });

  return {
    sent: dispatch.sent,
    provider: dispatch.provider,
    inviteUrl: input.inviteUrl,
    emailSubject,
    emailPreview,
    error: dispatch.error,
  };
}

export async function dispatchPasswordResetEmail(
  input: PasswordResetEmailInput,
): Promise<EmailDispatchResult> {
  const emailSubject = `Reset your Leadsetu CRM password (${input.workspaceName})`;
  const textBody = [
    `Hi ${input.memberName},`,
    '',
    `We received a request to reset your Leadsetu CRM password for ${input.workspaceName}.`,
    '',
    `Reset your password using this one-time link (expires in ${input.expiresInMinutes} minutes):`,
    input.resetUrl,
    '',
    `If you did not request this, you can safely ignore this email.`,
  ].join('\n');

  const htmlBody = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f8faff;border:1px solid #e2e8f0;border-radius:16px;color:#0f172a;">
      <h2 style="margin:0 0 8px;color:#0f172a;">Reset Your Leadsetu CRM Password</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;">
        Hi <strong>${input.memberName}</strong>, we received a password reset request for your account in <strong>${input.workspaceName}</strong>.
      </p>
      <a href="${input.resetUrl}" style="display:inline-block;padding:12px 22px;background:#0057ff;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;font-size:14px;">
        Reset Password
      </a>
      <p style="margin:16px 0 6px;font-size:12px;color:#475569;">
        This one-time link expires in <strong>${input.expiresInMinutes} minutes</strong>.
      </p>
      <p style="margin:0;font-size:11px;color:#64748b;">
        Or paste this link into your browser: ${input.resetUrl}<br/>
        If you didn&apos;t request a password reset, no action is needed.
      </p>
    </div>
  `.trim();

  return dispatchTransactionalEmail({
    toEmail: input.toEmail,
    subject: emailSubject,
    htmlBody,
    textBody,
    actionUrl: input.resetUrl,
    logLabel: 'password reset',
  });
}
