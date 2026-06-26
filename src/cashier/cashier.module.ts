import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CashMovement,
  CashMovementSchema,
} from './schemas/cash-movement.schema';
import {
  CashierShift,
  CashierShiftSchema,
} from './schemas/cashier-shift.schema';
import { CashierController } from './cashier.controller';
import { CashierService } from './cashier.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashierShift.name, schema: CashierShiftSchema },
      { name: CashMovement.name, schema: CashMovementSchema },
    ]),
  ],
  controllers: [CashierController],
  providers: [CashierService],
  exports: [CashierService],
})
export class CashierModule {}
