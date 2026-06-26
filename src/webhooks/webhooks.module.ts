import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EmailEvent,
  EmailEventSchema,
} from '../common/schemas/email-event.schema';
import { ResendWebhookService } from './resend-webhook.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailEvent.name, schema: EmailEventSchema },
    ]),
  ],
  controllers: [WebhooksController],
  providers: [ResendWebhookService],
})
export class WebhooksModule {}
