import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { EmailEventStatus } from '../common/schemas/email-event.schema';
import { ResendWebhookService } from './resend-webhook.service';

function execResult<T>(value: T) {
  return { exec: jest.fn().mockResolvedValue(value) };
}

function sign(rawBody: Buffer, id: string, timestamp: string, secret: Buffer) {
  return createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${rawBody.toString('utf8')}`)
    .digest('base64');
}

describe('ResendWebhookService', () => {
  const secretBytes = Buffer.from('resend-webhook-secret');
  const webhookSecret = `whsec_${secretBytes.toString('base64')}`;
  let emailEventModel: any;
  let service: ResendWebhookService;

  beforeEach(() => {
    emailEventModel = {
      findOne: jest.fn().mockReturnValue(execResult(null)),
      findOneAndUpdate: jest.fn().mockReturnValue(
        execResult({
          _id: { toString: () => 'event_1' },
          status: EmailEventStatus.DELIVERED,
        }),
      ),
    };
    service = new ResendWebhookService(
      {
        get: jest.fn((key: string) =>
          key === 'RESEND_WEBHOOK_SECRET' ? webhookSecret : undefined,
        ),
      } as unknown as ConfigService,
      emailEventModel,
    );
  });

  it('rejects invalid signatures', async () => {
    const rawBody = Buffer.from(JSON.stringify({ type: 'email.delivered' }));

    await expect(
      service.handle(
        rawBody,
        {
          'svix-id': 'msg_1',
          'svix-timestamp': '123',
          'svix-signature': 'v1,invalid',
        },
        { type: 'email.delivered' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updates email event status from delivered webhook', async () => {
    const body = {
      type: 'email.delivered',
      data: {
        email_id: 'email_123',
        to: ['owner@example.com'],
        subject: 'OTP',
        created_at: '2026-06-20T10:00:00.000Z',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = sign(rawBody, 'msg_1', '123', secretBytes);

    const result = await service.handle(
      rawBody,
      {
        'svix-id': 'msg_1',
        'svix-timestamp': '123',
        'svix-signature': `v1,${signature}`,
      },
      body,
    );

    expect(result).toMatchObject({
      received: true,
      duplicate: false,
      status: EmailEventStatus.DELIVERED,
      eventType: 'email.delivered',
    });
    expect(emailEventModel.findOneAndUpdate).toHaveBeenCalledWith(
      { provider: 'RESEND', emailId: 'email_123' },
      expect.objectContaining({
        $set: expect.objectContaining({
          svixId: 'msg_1',
          status: EmailEventStatus.DELIVERED,
          to: 'owner@example.com',
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('deduplicates repeated svix events', async () => {
    const body = { type: 'email.bounced', data: { email_id: 'email_123' } };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = sign(rawBody, 'msg_1', '123', secretBytes);
    emailEventModel.findOne.mockReturnValueOnce(
      execResult({ _id: 'existing' }),
    );

    await expect(
      service.handle(
        rawBody,
        {
          'svix-id': 'msg_1',
          'svix-timestamp': '123',
          'svix-signature': `v1,${signature}`,
        },
        body,
      ),
    ).resolves.toEqual({ received: true, duplicate: true });
    expect(emailEventModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
