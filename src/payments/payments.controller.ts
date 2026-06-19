import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CreatePayosPaymentDto } from '../orders/dto/create-payos-payment.dto';
import { OrdersService } from '../orders/orders.service';
import { BillingService } from '../billing/billing.service';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly billingService: BillingService,
  ) {}

  @Post('payos/create')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  createPayosPayment(@Body() dto: CreatePayosPaymentDto) {
    return this.ordersService.createPayosPayment(dto.tenantId, dto);
  }

  @Get(':paymentId/status')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  getPaymentStatus(
    @Param('paymentId') paymentId: string,
    @Query('tenantId') tenantId: string,
    @Query('sessionId') sessionId: string,
  ) {
    return this.ordersService.getCustomerPaymentStatus(paymentId, tenantId, sessionId);
  }

  @Post('payos/webhook')
  async handlePayosWebhook(@Body() body: Record<string, unknown>) {
    const saasResult = await this.billingService.handlePayosWebhookIfSaas(body);
    if (saasResult.handled) return saasResult.response;
    return this.ordersService.handlePayosWebhook(body);
  }
}
