import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TableSessionDocument = TableSession & Document;

export enum TableSessionStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum TableSessionPaymentStatus {
  UNPAID = 'UNPAID',
  REQUESTED = 'REQUESTED',
  PAID = 'PAID',
}

export enum TableSessionPaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  MANUAL = 'MANUAL',
}

@Schema({ timestamps: true })
export class TableSession {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Table', required: true, index: true })
  tableId: Types.ObjectId;

  @Prop({ type: String, enum: TableSessionStatus, default: TableSessionStatus.OPEN, index: true })
  status: TableSessionStatus;

  @Prop({ required: true })
  qrCodeTokenSnapshot: string;

  @Prop({ required: true, default: Date.now })
  openedAt: Date;

  @Prop()
  closedAt?: Date;

  @Prop({ required: true, default: Date.now })
  lastActivityAt: Date;

  @Prop()
  customerName?: string;

  @Prop()
  customerPhone?: string;

  @Prop({ type: String, enum: TableSessionPaymentStatus, default: TableSessionPaymentStatus.UNPAID, index: true })
  paymentStatus: TableSessionPaymentStatus;

  @Prop()
  paidAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  paidBy?: Types.ObjectId;

  @Prop({ default: 0 })
  totalPaidAmount: number;

  @Prop({ type: String, enum: TableSessionPaymentMethod })
  paymentMethod?: TableSessionPaymentMethod;
}

export const TableSessionSchema = SchemaFactory.createForClass(TableSession);

TableSessionSchema.index(
  { tenantId: 1, tableId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: TableSessionStatus.OPEN },
  },
);
