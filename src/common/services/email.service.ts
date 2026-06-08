import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

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

  private isProduction() {
    return this.configService.get<string>('NODE_ENV') === 'production' || process.env.NODE_ENV === 'production';
  }

  async sendDeviceOtp(email: string, otp: string, name?: string): Promise<{ delivered: boolean; devOtp?: string }> {
    if (!email) {
      throw new ServiceUnavailableException('Tai khoan chua co email de nhan OTP');
    }

    if (!this.hasSmtpConfig()) {
      if (this.isProduction()) {
        throw new ServiceUnavailableException('SMTP chua duoc cau hinh de gui OTP');
      }

      console.warn(`[DEV OTP] ${email}: ${otp}`);
      return { delivered: false, devOtp: otp };
    }

    const port = Number(this.configService.get<string>('SMTP_PORT'));
    const transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port,
      secure: port === 465,
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });

    await transporter.sendMail({
      from: this.configService.get<string>('SMTP_FROM') || this.configService.get<string>('SMTP_USER'),
      to: email,
      subject: 'Ma OTP dang nhap TraSua POS',
      text: `Xin chao ${name || email},\n\nMa OTP dang nhap cua ban la: ${otp}\nMa co hieu luc trong 15 phut.`,
    });

    return { delivered: true };
  }
}
