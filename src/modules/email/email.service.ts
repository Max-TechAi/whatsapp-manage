import nodemailer from 'nodemailer';
import { getEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';

class EmailService {
  private transporter!: nodemailer.Transporter;

  constructor() {
    const env = getEnv();
    
    // Config SMTP options
    const smtpConfig: any = {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
    };

    if (env.SMTP_USER && env.SMTP_PASSWORD) {
      smtpConfig.auth = {
        user: env.SMTP_USER,
        pass: env.SMTP_PASSWORD,
      };
    }

    this.transporter = nodemailer.createTransport(smtpConfig);
  }

  /**
   * Test the SMTP connection on startup.
   */
  async verifySmtpConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      logger.info('📧 SMTP connection verified successfully.');
      return true;
    } catch (err: any) {
      logger.error('❌ SMTP connection failed. Check your environment variables.', {
        error: err.message,
      });
      return false;
    }
  }

  /**
   * Send account verification email.
   */
  async sendVerificationEmail(to: string, verificationLink: string): Promise<void> {
    const env = getEnv();
    const htmlContent = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
        <div style="background-color: #075e54; color: white; padding: 24px; text-align: center;">
          <h1 style="margin: 0; font-size: 24px; font-weight: 600;">Verify Your Email</h1>
        </div>
        <div style="padding: 32px; background-color: #ffffff; color: #333333; line-height: 1.6;">
          <p style="font-size: 16px; margin-top: 0;">Welcome to the WhatsApp Business Platform!</p>
          <p style="font-size: 15px;">Please confirm your email address by clicking the button below. This link is valid for 24 hours.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${verificationLink}" style="background-color: #128c7e; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 2px 5px rgba(18,140,126,0.3);">Confirm Email Address</a>
          </div>
          <p style="font-size: 13px; color: #666666;">If you did not sign up for this account, please ignore this email.</p>
          <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 24px 0;" />
          <p style="font-size: 12px; color: #999999; margin-bottom: 0;">If you're having trouble clicking the button, copy and paste the URL below into your browser:<br/>
          <a href="${verificationLink}" style="color: #128c7e; word-break: break-all;">${verificationLink}</a></p>
        </div>
      </div>
    `;

    await this.transporter.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject: 'Verify Your Email Address — WhatsApp Business Platform',
      html: htmlContent,
    });
    logger.info('Verification email sent', { to });
  }

  /**
   * Send team member invitation email.
   */
  async sendInviteEmail(to: string, inviteLink: string, orgName: string, inviterName: string): Promise<void> {
    const env = getEnv();
    const htmlContent = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
        <div style="background-color: #075e54; color: white; padding: 24px; text-align: center;">
          <h1 style="margin: 0; font-size: 24px; font-weight: 600;">You are Invited!</h1>
        </div>
        <div style="padding: 32px; background-color: #ffffff; color: #333333; line-height: 1.6;">
          <p style="font-size: 16px; margin-top: 0; font-weight: bold;">Hello,</p>
          <p style="font-size: 15px;"><strong>${inviterName}</strong> has invited you to join the organization <strong>${orgName}</strong> on the WhatsApp Business Platform.</p>
          <p style="font-size: 15px;">To accept this invitation, set up your account, and choose your password, please click the button below. This invitation link is valid for 48 hours.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${inviteLink}" style="background-color: #128c7e; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 2px 5px rgba(18,140,126,0.3);">Accept Invitation</a>
          </div>
          <p style="font-size: 13px; color: #666666;">Once you set your password, you will be logged in and can start using the dashboard.</p>
          <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 24px 0;" />
          <p style="font-size: 12px; color: #999999; margin-bottom: 0;">If you're having trouble clicking the button, copy and paste the URL below into your browser:<br/>
          <a href="${inviteLink}" style="color: #128c7e; word-break: break-all;">${inviteLink}</a></p>
        </div>
      </div>
    `;

    await this.transporter.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject: `Invitation to join ${orgName} on WhatsApp Business Platform`,
      html: htmlContent,
    });
    logger.info('Invitation email sent', { to, orgName });
  }
}

export const emailService = new EmailService();
