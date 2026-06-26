import { Body, Controller, Post, Req } from '@nestjs/common';
import { ResendWebhookService } from './resend-webhook.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly resendWebhookService: ResendWebhookService) {}

  @Post('resend')
  handleResend(@Req() req: any, @Body() body: any) {
    return this.resendWebhookService.handle(
      req.rawBody,
      req.headers || {},
      body,
    );
  }
}
