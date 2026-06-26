import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Resend } from 'resend';
import {
  EmailEvent,
  EmailEventDocument,
  EmailEventStatus,
  EmailProvider,
} from '../schemas/email-event.schema';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @InjectModel(EmailEvent.name)
    private readonly emailEventModel?: Model<EmailEventDocument>,
  ) {}

  private getConfig(name: string) {
    return (
      this.configService.get<string>(name) ||
      process.env[name] ||
      ''
    ).trim();
  }

  private isTruthy(value?: string) {
    return ['true', '1', 'yes', 'on'].includes(
      (value || '').trim().toLowerCase(),
    );
  }

  private maskEmail(email: string) {
    const [localPart, domain] = email.split('@');
    if (!localPart || !domain) return email;
    return `${localPart.slice(0, 2)}***@${domain}`;
  }

  private hasResendConfig() {
    return Boolean(
      this.getConfig('RESEND_API_KEY') && this.getConfig('RESEND_FROM'),
    );
  }

  private isProduction() {
    return (
      this.getConfig('NODE_ENV') === 'production' ||
      process.env.NODE_ENV === 'production'
    );
  }

  private isDeviceOtpDisabled() {
    const disabled =
      this.isTruthy(this.getConfig('DISABLE_DEVICE_OTP')) ||
      this.isTruthy(this.getConfig('AUTH_DISABLE_DEVICE_OTP'));

    if (!disabled) return false;

    if (
      this.isProduction() &&
      !this.isTruthy(this.getConfig('ALLOW_PRODUCTION_DEVICE_OTP_BYPASS'))
    ) {
      this.logger.warn(
        'Device OTP bypass is ignored in production. Configure Resend instead.',
      );
      return false;
    }

    return true;
  }

  shouldSkipDeviceOtp() {
    return this.isDeviceOtpDisabled();
  }

  private buildOtpEmailContent(
    email: string,
    otp: string,
    name?: string,
    purpose: 'device' | 'signup' = 'device',
  ) {
    if (purpose === 'signup') {
      return {
        subject: 'Ma OTP dang ky cua hang TraSua POS',
        text: `Xin chao ${name || email},\n\nMa OTP xac minh dang ky cua hang cua ban la: ${otp}\nMa co hieu luc trong 15 phut.`,
      };
    }

    return {
      subject: 'Ma OTP dang nhap TraSua POS',
      text: `Xin chao ${name || email},\n\nMa OTP dang nhap cua ban la: ${otp}\nMa co hieu luc trong 15 phut.`,
    };
  }

  private async sendViaResend(
    email: string,
    otp: string,
    name?: string,
    purpose: 'device' | 'signup' = 'device',
    metadata: { tenantId?: string; userId?: string } = {},
  ): Promise<void> {
    const apiKey = this.getConfig('RESEND_API_KEY');
    const from = this.getConfig('RESEND_FROM');
    if (!apiKey || !from) {
      throw new ServiceUnavailableException(
        'RESEND_API_KEY va RESEND_FROM la bat buoc de gui OTP.',
      );
    }

    const { subject, text } = this.buildOtpEmailContent(
      email,
      otp,
      name,
      purpose,
    );

    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to: email,
      subject,
      text,
    });

    if (error) {
      console.error('[Resend] Failed to send OTP email:', error);
      throw new ServiceUnavailableException(
        'Khong gui duoc OTP qua Resend: ' + (error.message || 'unknown error'),
      );
    }

    this.logger.log(
      `OTP email accepted by Resend for ${this.maskEmail(email)}${data?.id ? ` (id: ${data.id})` : ''}`,
    );

    await this.recordAcceptedEmail({
      emailId: data?.id,
      to: email,
      subject,
      purpose,
      tenantId: metadata.tenantId,
      userId: metadata.userId,
    });
  }

  private async recordAcceptedEmail(event: {
    emailId?: string;
    to: string;
    subject: string;
    purpose: string;
    tenantId?: string;
    userId?: string;
  }) {
    if (!this.emailEventModel || !event.emailId) return;

    try {
      await this.emailEventModel
        .findOneAndUpdate(
          { provider: EmailProvider.RESEND, emailId: event.emailId },
          {
            $set: {
              provider: EmailProvider.RESEND,
              emailId: event.emailId,
              to: event.to,
              subject: event.subject,
              purpose: event.purpose,
              status: EmailEventStatus.ACCEPTED,
              eventType: 'email.accepted',
              lastEventAt: new Date(),
              tenantId:
                event.tenantId && Types.ObjectId.isValid(event.tenantId)
                  ? new Types.ObjectId(event.tenantId)
                  : undefined,
              userId:
                event.userId && Types.ObjectId.isValid(event.userId)
                  ? new Types.ObjectId(event.userId)
                  : undefined,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Unable to record Resend email event ${event.emailId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async sendDeviceOtp(
    email: string,
    otp: string,
    name?: string,
  ): Promise<{ delivered: boolean; devOtp?: string }> {
    if (!email) {
      throw new ServiceUnavailableException(
        'Tai khoan chua co email de nhan OTP',
      );
    }

    if (this.hasResendConfig()) {
      await this.sendViaResend(email, otp, name);
      return { delivered: true };
    }

    throw new ServiceUnavailableException(
      'RESEND_API_KEY hoac RESEND_FROM chua duoc cau hinh. He thong chi gui OTP qua Resend.',
    );
  }

  async sendSignupOtp(
    email: string,
    otp: string,
    name?: string,
  ): Promise<{ delivered: boolean; devOtp?: string }> {
    if (!email) {
      throw new ServiceUnavailableException(
        'Email dang ky la bat buoc de nhan OTP',
      );
    }

    if (this.hasResendConfig()) {
      await this.sendViaResend(email, otp, name, 'signup');
      return { delivered: true };
    }

    throw new ServiceUnavailableException(
      'RESEND_API_KEY hoac RESEND_FROM chua duoc cau hinh. He thong chi gui OTP qua Resend.',
    );
  }
}
