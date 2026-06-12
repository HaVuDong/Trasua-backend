import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {}

  private getConfig(name: string) {
    return (this.configService.get<string>(name) || process.env[name] || '').trim();
  }

  private isTruthy(value?: string) {
    return ['true', '1', 'yes', 'on'].includes((value || '').trim().toLowerCase());
  }

  private maskEmail(email: string) {
    const [localPart, domain] = email.split('@');
    if (!localPart || !domain) return email;
    return `${localPart.slice(0, 2)}***@${domain}`;
  }

  private hasSmtpConfig() {
    return Boolean(
      this.getConfig('SMTP_HOST') &&
        this.getConfig('SMTP_PORT') &&
        this.getConfig('SMTP_USER') &&
        this.getConfig('SMTP_PASS'),
    );
  }

  private hasResendConfig() {
    return Boolean(this.getConfig('RESEND_API_KEY'));
  }

  private isProduction() {
    return this.getConfig('NODE_ENV') === 'production' || process.env.NODE_ENV === 'production';
  }

  private isDeviceOtpDisabled() {
    const disabled =
      this.isTruthy(this.getConfig('DISABLE_DEVICE_OTP')) ||
      this.isTruthy(this.getConfig('AUTH_DISABLE_DEVICE_OTP'));

    if (!disabled) return false;

    if (this.isProduction() && !this.isTruthy(this.getConfig('ALLOW_PRODUCTION_DEVICE_OTP_BYPASS'))) {
      this.logger.warn('Device OTP bypass is ignored in production. Configure Resend instead.');
      return false;
    }

    return true;
  }

  shouldSkipDeviceOtp() {
    return this.isDeviceOtpDisabled();
  }

  private buildOtpEmailContent(email: string, otp: string, name?: string) {
    return {
      subject: 'Ma OTP dang nhap TraSua POS',
      text: `Xin chao ${name || email},\n\nMa OTP dang nhap cua ban la: ${otp}\nMa co hieu luc trong 15 phut.`,
    };
  }

  private async sendViaResend(email: string, otp: string, name?: string): Promise<void> {
    const apiKey = this.getConfig('RESEND_API_KEY');
    const from = this.getConfig('RESEND_FROM') || 'onboarding@resend.dev';
    const { subject, text } = this.buildOtpEmailContent(email, otp, name);

    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({ from, to: email, subject, text });

    if (error) {
      console.error('[Resend] Failed to send OTP email:', error);
      throw new ServiceUnavailableException('Khong gui duoc OTP qua Resend: ' + (error.message || 'unknown error'));
    }

    this.logger.log(
      `OTP email accepted by Resend for ${this.maskEmail(email)}${data?.id ? ` (id: ${data.id})` : ''}`,
    );
  }

  private async sendViaSmtp(email: string, otp: string, name?: string): Promise<void> {
    const port = Number(this.getConfig('SMTP_PORT'));
    const transporter = nodemailer.createTransport({
      host: this.getConfig('SMTP_HOST'),
      port,
      secure: port === 465,
      connectionTimeout: Number(this.getConfig('SMTP_CONNECTION_TIMEOUT_MS') || 5000),
      greetingTimeout: Number(this.getConfig('SMTP_GREETING_TIMEOUT_MS') || 5000),
      socketTimeout: Number(this.getConfig('SMTP_SOCKET_TIMEOUT_MS') || 8000),
      auth: {
        user: this.getConfig('SMTP_USER'),
        pass: this.getConfig('SMTP_PASS'),
      },
    });

    const { subject, text } = this.buildOtpEmailContent(email, otp, name);

    await transporter.sendMail({
      from: this.getConfig('SMTP_FROM') || this.getConfig('SMTP_USER'),
      to: email,
      subject,
      text,
    });
  }

  async sendDeviceOtp(email: string, otp: string, name?: string): Promise<{ delivered: boolean; devOtp?: string }> {
    if (!email) {
      throw new ServiceUnavailableException('Tai khoan chua co email de nhan OTP');
    }

    // Priority: Resend API works on Render because it uses HTTPS instead of blocked SMTP ports.
    if (this.hasResendConfig()) {
      await this.sendViaResend(email, otp, name);
      return { delivered: true };
    }

    if (this.isProduction()) {
      throw new ServiceUnavailableException(
        'RESEND_API_KEY chua duoc cau hinh. Production deploy phai dung Resend API de gui OTP.',
      );
    }

    // Local fallback only. Production deploys must fail loudly when Resend is missing.
    if (this.hasSmtpConfig()) {
      try {
        await this.sendViaSmtp(email, otp, name);
        return { delivered: true };
      } catch (err: any) {
        console.warn(`[SMTP] Failed in dev, falling back to devOtp: ${err.message || err}`);
        console.warn(`[DEV OTP] ${email}: ${otp}`);
        return { delivered: false, devOtp: otp };
      }
    }

    console.warn(`[DEV OTP] ${email}: ${otp}`);
    return { delivered: false, devOtp: otp };
  }
}
