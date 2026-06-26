import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PrintJobDocument = PrintJob & Document;

export enum PrintJobStatus {
  REQUESTED = 'REQUESTED',
  PRINTING = 'PRINTING',
  PRINTED = 'PRINTED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum PrintJobType {
  BILL = 'BILL',
  RECEIPT = 'RECEIPT',
  KITCHEN_TICKET = 'KITCHEN_TICKET',
}

export const OPEN_PRINT_JOB_STATUSES = [
  PrintJobStatus.REQUESTED,
  PrintJobStatus.PRINTING,
] as const;

@Schema({ timestamps: true })
export class PrintJob {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Invoice', required: true, index: true })
  invoiceId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'TableSession',
    required: true,
    index: true,
  })
  sessionId: Types.ObjectId;

  @Prop({ type: String, enum: PrintJobType, required: true, index: true })
  type: PrintJobType;

  @Prop({
    type: String,
    enum: PrintJobStatus,
    required: true,
    default: PrintJobStatus.REQUESTED,
    index: true,
  })
  status: PrintJobStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  requestedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  handledBy?: Types.ObjectId;

  @Prop()
  errorMessage?: string;
}

export const PrintJobSchema = SchemaFactory.createForClass(PrintJob);

PrintJobSchema.index(
  { tenantId: 1, invoiceId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [PrintJobStatus.REQUESTED, PrintJobStatus.PRINTING] },
    },
  },
);
PrintJobSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
