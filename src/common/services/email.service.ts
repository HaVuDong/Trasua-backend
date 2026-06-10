import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  constructor(private readonly configService: ConfigService) {}

  private hasSmtpConfig() {
    return Boolean(
      this.configService.get<string>('SMTP_HOST') &&
        this.configService.get<string>('SMTP_PORT') &&
        this.configService.get<string>('SMTP_USER') &&
        this.configService.get<string>('SMTP_PASS'),
    );
  }

  private hasResendConfig() {
    return Boolean(this.configService.get<string>('RESEND_API_KEY'));
  }

  private isProduction() {
    return this.configService.get<string>('NODE_ENV') === 'production' || process.env.NODE_ENV === 'production';
  }

  private isDeviceOtpDisabled() {
    return (
      this.configService.get<string>('DISABLE_DEVICE_OTP') === 'true' ||
      this.configService.get<string>('AUTH_DISABLE_DEVICE_OTP') === 'true'
    );
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
    const apiKey = this.configService.get<string>('RESEND_API_KEY')!;
    const from = this.configService.get<string>('RESEND_FROM') || 'onboarding@resend.dev';
    const { subject, text } = this.buildOtpEmailContent(email, otp, name);

    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({ from, to: email, subject, text });

    if (error) {
      console.error('[Resend] Failed to send OTP email:', error);
      throw new ServiceUnavailableException('Khong gui duoc OTP qua Resend: ' + (error.message || 'unknown error'));
    }
  }

  private async sendViaSmtp(email: string, otp: string, name?: string): Promise<void> {
    const port = Number(this.configService.get<string>('SMTP_PORT'));
    const transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port,
      secure: port === 465,
      connectionTimeout: Number(this.configService.get<string>('SMTP_CONNECTION_TIMEOUT_MS') || 5000),
      greetingTimeout: Number(this.configService.get<string>('SMTP_GREETING_TIMEOUT_MS') || 5000),
      socketTimeout: Number(this.configService.get<string>('SMTP_SOCKET_TIMEOUT_MS') || 8000),
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });

    const { subject, text } = this.buildOtpEmailContent(email, otp, name);

    await transporter.sendMail({
      from: this.configService.get<string>('SMTP_FROM') || this.configService.get<string>('SMTP_USER'),
      to: email,
      subject,
      text,
    });
  }

  async sendDeviceOtp(email: string, otp: string, name?: string): Promise<{ delivered: boolean; devOtp?: string }> {
    if (!email) {
      throw new ServiceUnavailableException('Tai khoan chua co email de nhan OTP');
    }

    // 1. Priority: Resend API (works on all platforms, no port restrictions)
    if (this.hasResendConfig()) {
      await this.sendViaResend(email, otp, name);
      return { delivered: true };
    }

    // 2. Fallback: SMTP (works locally or on platforms that don't block SMTP ports)
    if (this.hasSmtpConfig()) {
      if (this.isProduction()) {
        // In production without Resend, SMTP may timeout on Render — attempt anyway
        try {
          await this.sendViaSmtp(email, otp, name);
          return { delivered: true };
        } catch (err: any) {
          console.error('[SMTP] Failed in production:', err.message || err);
          throw new ServiceUnavailableException(
            'Khong gui duoc OTP qua SMTP. Hay cau hinh RESEND_API_KEY de gui email qua Resend API.',
          );
        }
      }

      // Non-production with SMTP: attempt send, fallback to devOtp on failure
      try {
        await this.sendViaSmtp(email, otp, name);
        return { delivered: true };
      } catch (err: any) {
        console.warn(`[SMTP] Failed in dev, falling back to devOtp: ${err.message || err}`);
        console.warn(`[DEV OTP] ${email}: ${otp}`);
        return { delivered: false, devOtp: otp };
      }
    }

    // 3. No email provider configured
    if (this.isProduction()) {
      throw new ServiceUnavailableException('SMTP chua duoc cau hinh de gui OTP');
    }

    console.warn(`[DEV OTP] ${email}: ${otp}`);
    return { delivered: false, devOtp: otp };
  }
}
