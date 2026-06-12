import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [OrdersModule],
  controllers: [PaymentsController],
})
export class PaymentsModule {}
