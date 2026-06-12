import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CustomerPaymentDocument = CustomerPayment & Document;

export enum CustomerPaymentProvider {
  PAYOS = 'PAYOS',
}

export enum CustomerPaymentStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
  FAILED = 'FAILED',
}

@Schema({ timestamps: true })
export class CustomerPayment {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Table', required: true, index: true })
  tableId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TableSession', required: true, index: true })
  sessionId: Types.ObjectId;

  @Prop({ type: String, enum: CustomerPaymentProvider, required: true, default: CustomerPaymentProvider.PAYOS })
  provider: CustomerPaymentProvider;

  @Prop({ type: String, enum: CustomerPaymentStatus, required: true, default: CustomerPaymentStatus.PENDING, index: true })
  status: CustomerPaymentStatus;

  @Prop({ required: true, index: true, unique: true })
  orderCode: number;

  @Prop()
  providerPaymentLinkId?: string;

  @Prop()
  checkoutUrl?: string;

  @Prop()
  qrCode?: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  description: string;

  @Prop()
  customerName?: string;

  @Prop()
  customerPhone?: string;

  @Prop()
  tableNameSnapshot?: string;

  @Prop({ type: Object })
  billSnapshot?: Record<string, unknown>;

  @Prop({ type: Object })
  providerResponse?: Record<string, unknown>;

  @Prop({ type: Object })
  webhookPayload?: Record<string, unknown>;

  @Prop()
  paidAt?: Date;
}

export const CustomerPaymentSchema = SchemaFactory.createForClass(CustomerPayment);

CustomerPaymentSchema.index({ tenantId: 1, sessionId: 1, status: 1 });
