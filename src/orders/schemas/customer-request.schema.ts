import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CustomerRequestDocument = CustomerRequest & Document;

export enum CustomerRequestType {
  CALL_STAFF = 'CALL_STAFF',
  PAY_CASH = 'PAY_CASH',
  PAY_TRANSFER = 'PAY_TRANSFER',
  PRINT_BILL = 'PRINT_BILL',
}

export enum CustomerRequestStatus {
  PENDING = 'PENDING',
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
}

export enum CustomerPaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
}

@Schema({ timestamps: true })
export class CustomerRequest {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Table', required: true, index: true })
  tableId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TableSession', required: true, index: true })
  sessionId: Types.ObjectId;

  @Prop({ type: String, enum: CustomerRequestType, required: true, index: true })
  type: CustomerRequestType;

  @Prop({ type: String, enum: CustomerRequestStatus, default: CustomerRequestStatus.PENDING, index: true })
  status: CustomerRequestStatus;

  @Prop({ type: String, enum: CustomerPaymentMethod })
  paymentMethod?: CustomerPaymentMethod;

  @Prop()
  message?: string;

  @Prop()
  customerName?: string;

  @Prop()
  customerPhone?: string;

  @Prop()
  tableNameSnapshot?: string;

  @Prop()
  qrTokenSnapshot?: string;

  @Prop({ type: Types.ObjectId, ref: 'CustomerPayment' })
  paymentId?: Types.ObjectId;

  @Prop({ type: Object })
  billSnapshot?: Record<string, unknown>;
}

export const CustomerRequestSchema = SchemaFactory.createForClass(CustomerRequest);
