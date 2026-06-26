import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import {
  TableSession,
  TableSessionSchema,
} from '../orders/schemas/table-session.schema';
import { Table, TableSchema } from '../tables/schemas/table.schema';
import { InvoicesController, PrintJobsController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { Invoice, InvoiceSchema } from './schemas/invoice.schema';
import {
  InvoiceCounter,
  InvoiceCounterSchema,
} from './schemas/invoice-counter.schema';
import { PrintJob, PrintJobSchema } from './schemas/print-job.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Invoice.name, schema: InvoiceSchema },
      { name: InvoiceCounter.name, schema: InvoiceCounterSchema },
      { name: PrintJob.name, schema: PrintJobSchema },
      { name: TableSession.name, schema: TableSessionSchema },
      { name: Table.name, schema: TableSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
  ],
  controllers: [InvoicesController, PrintJobsController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
