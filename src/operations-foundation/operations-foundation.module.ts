import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CashierShift,
  CashierShiftSchema,
} from '../cashier/schemas/cashier-shift.schema';
import {
  CashMovement,
  CashMovementSchema,
} from '../cashier/schemas/cash-movement.schema';
import {
  InventoryAdjustment,
  InventoryAdjustmentSchema,
} from '../inventory/schemas/inventory-adjustment.schema';
import { Invoice, InvoiceSchema } from '../invoices/schemas/invoice.schema';
import {
  InvoiceCounter,
  InvoiceCounterSchema,
} from '../invoices/schemas/invoice-counter.schema';
import { PrintJob, PrintJobSchema } from '../invoices/schemas/print-job.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashierShift.name, schema: CashierShiftSchema },
      { name: CashMovement.name, schema: CashMovementSchema },
      { name: Invoice.name, schema: InvoiceSchema },
      { name: InvoiceCounter.name, schema: InvoiceCounterSchema },
      { name: PrintJob.name, schema: PrintJobSchema },
      { name: InventoryAdjustment.name, schema: InventoryAdjustmentSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class OperationsFoundationModule {}
