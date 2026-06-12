import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreatePayosPaymentDto } from '../orders/dto/create-payos-payment.dto';
import { OrdersService } from '../orders/orders.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('payos/create')
  createPayosPayment(@Body() dto: CreatePayosPaymentDto) {
    return this.ordersService.createPayosPayment(dto.tenantId, dto);
  }

  @Get(':paymentId/status')
  getPaymentStatus(@Param('paymentId') paymentId: string) {
    return this.ordersService.getCustomerPaymentStatus(paymentId);
  }

  @Post('payos/webhook')
  handlePayosWebhook(@Body() body: Record<string, unknown>) {
    return this.ordersService.handlePayosWebhook(body);
  }
}
