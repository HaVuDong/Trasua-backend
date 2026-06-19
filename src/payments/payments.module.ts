import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { BillingModule } from '../billing/billing.module';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [OrdersModule, BillingModule],
  controllers: [PaymentsController],
})
export class PaymentsModule {}
