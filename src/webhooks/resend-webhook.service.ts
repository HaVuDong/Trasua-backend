import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, timingSafeEqual } from 'crypto';
import { Model } from 'mongoose';
import {
  EmailEvent,
  EmailEventDocument,
  EmailEventStatus,
  EmailProvider,
} from '../common/schemas/email-event.schema';

@Injectable()
export class ResendWebhookService {
  constructor(
    private readonly configService: ConfigService,
    @InjectModel(EmailEvent.name)
    private readonly emailEventModel: Model<EmailEventDocument>,
  ) {}

  async handle(
    rawBody: Buffer | undefined,
    headers: Record<string, unknown>,
    body: any,
  ) {
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException(
        'Raw body is required for Resend webhook verification',
      );
    }

    const svixId = this.getHeader(headers, 'svix-id');
    this.verifySignature(rawBody, headers);

    const existing = await this.emailEventModel
      .findOne({ provider: EmailProvider.RESEND, svixId })
      .exec();
    if (existing) return { received: true, duplicate: true };

    const eventType = String(body?.type || body?.eventType || '');
    const data = body?.data || {};
    const emailId = this.getString(
      data.email_id || data.emailId || data.id || body?.email_id,
    );
    const to = this.extractRecipient(data.to || body?.to);
    const subject = this.getString(data.subject || body?.subject);
    const status = this.mapStatus(eventType);
    const lastEventAt = this.parseEventDate(
      data.created_at || body?.created_at,
    );

    const update: any = {
      $set: {
        provider: EmailProvider.RESEND,
        svixId,
        eventType,
        status,
        lastEventAt,
        providerPayload: body,
      },
      $setOnInsert: {
        provider: EmailProvider.RESEND,
        to: to || 'unknown',
        purpose: 'resend_webhook',
      },
    };
    if (emailId) update.$set.emailId = emailId;
    if (to) update.$set.to = to;
    if (subject) update.$set.subject = subject;

    const query = emailId
      ? { provider: EmailProvider.RESEND, emailId }
      : { provider: EmailProvider.RESEND, svixId };
    const event = await this.emailEventModel
      .findOneAndUpdate(query, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      })
      .exec();

    return {
      received: true,
      duplicate: false,
      emailEventId: event?._id?.toString?.(),
      status,
      eventType,
    };
  }

  verifySignature(rawBody: Buffer, headers: Record<string, unknown>) {
    const secret =
      this.configService.get<string>('RESEND_WEBHOOK_SECRET') ||
      process.env.RESEND_WEBHOOK_SECRET ||
      '';
    if (!secret.trim()) {
      throw new ServiceUnavailableException(
        'RESEND_WEBHOOK_SECRET is not configured',
      );
    }

    const svixId = this.getHeader(headers, 'svix-id');
    const svixTimestamp = this.getHeader(headers, 'svix-timestamp');
    const svixSignature = this.getHeader(headers, 'svix-signature');
    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new BadRequestException('Missing Resend webhook signature headers');
    }

    const payload = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
    const secretBytes = this.decodeSvixSecret(secret);
    const expected = createHmac('sha256', secretBytes)
      .update(payload)
      .digest('base64');
    const signatures = this.parseSvixSignatures(svixSignature);
    const valid = signatures.some((signature) =>
      this.safeEqual(signature, expected),
    );
    if (!valid)
      throw new BadRequestException('Invalid Resend webhook signature');
  }

  private decodeSvixSecret(secret: string) {
    const trimmed = secret.trim();
    if (trimmed.startsWith('whsec_')) {
      return Buffer.from(trimmed.slice('whsec_'.length), 'base64');
    }
    return Buffer.from(trimmed, 'utf8');
  }

  private parseSvixSignatures(header: string) {
    return header.split(' ').flatMap((part) => {
      const [version, signature] = part.split(',');
      return version === 'v1' && signature ? [signature] : [];
    });
  }

  private safeEqual(a: string, b: string) {
    const aBuffer = Buffer.from(a);
    const bBuffer = Buffer.from(b);
    return (
      aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer)
    );
  }

  private getHeader(headers: Record<string, unknown>, name: string) {
    const value = headers[name] || headers[name.toLowerCase()];
    if (Array.isArray(value)) return String(value[0] || '');
    return typeof value === 'string' ? value : '';
  }

  private getString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private extractRecipient(value: unknown) {
    if (Array.isArray(value)) {
      return value
        .map((entry) => String(entry))
        .filter(Boolean)
        .join(',');
    }
    return this.getString(value);
  }

  private parseEventDate(value: unknown) {
    const raw = this.getString(value);
    const parsed = raw ? new Date(raw) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private mapStatus(eventType: string): EmailEventStatus {
    const normalized = eventType.toLowerCase();
    if (normalized.includes('delivered')) return EmailEventStatus.DELIVERED;
    if (normalized.includes('bounce')) return EmailEventStatus.BOUNCED;
    if (normalized.includes('complain')) return EmailEventStatus.COMPLAINED;
    if (normalized.includes('fail')) return EmailEventStatus.FAILED;
    return EmailEventStatus.ACCEPTED;
  }
}
