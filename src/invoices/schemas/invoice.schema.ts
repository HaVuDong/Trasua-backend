import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  integerVndValidator,
  INTEGER_VND_MESSAGE,
} from '../../common/domain/money';
import { PaymentMethod } from '../../common/domain/payment-method';

export type InvoiceDocument = Invoice & Document;

export enum InvoiceStatus {
  ISSUED = 'ISSUED',
  VOIDED = 'VOIDED',
}

export enum InvoicePaymentStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

@Schema({ _id: false })
export class InvoiceCustomerSnapshot {
  @Prop()
  name?: string;

  @Prop()
  phone?: string;
}

@Schema({ _id: false })
export class InvoiceItemSnapshot {
  @Prop({ type: Types.ObjectId, ref: 'MenuItem' })
  itemId?: Types.ObjectId;

  @Prop({ required: true })
  nameSnapshot: string;

  @Prop({ required: true, default: 1 })
  quantity: number;

  @Prop({
    required: true,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  unitPrice: number;

  @Prop({
    required: true,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  lineTotal: number;

  @Prop()
  note?: string;
}

@Schema({ timestamps: true })
export class Invoice {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true, index: true })
  invoiceNumber: string;

  @Prop({
    type: String,
    enum: InvoiceStatus,
    required: true,
    default: InvoiceStatus.ISSUED,
    index: true,
  })
  status: InvoiceStatus;

  @Prop({
    type: Types.ObjectId,
    ref: 'TableSession',
    required: true,
    index: true,
  })
  sessionId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Table', required: true, index: true })
  tableId: Types.ObjectId;

  @Prop({ type: [Types.ObjectId], ref: 'Order', default: [] })
  orderIds: Types.ObjectId[];

  @Prop({ type: InvoiceCustomerSnapshot, default: () => ({}) })
  customerSnapshot?: InvoiceCustomerSnapshot;

  @Prop({ type: [InvoiceItemSnapshot], default: [] })
  itemSnapshot: InvoiceItemSnapshot[];

  @Prop({
    required: true,
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  subtotal: number;

  @Prop({
    required: true,
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  discount: number;

  @Prop({
    required: true,
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  vat: number;

  @Prop({
    required: true,
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  serviceCharge: number;

  @Prop({
    required: true,
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  finalAmount: number;

  @Prop({ type: String, enum: PaymentMethod })
  paymentMethod?: PaymentMethod;

  @Prop({
    type: String,
    enum: InvoicePaymentStatus,
    required: true,
    default: InvoicePaymentStatus.PENDING,
    index: true,
  })
  paymentStatus: InvoicePaymentStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  issuedBy: Types.ObjectId;

  @Prop({ required: true, default: Date.now })
  issuedAt: Date;

  @Prop()
  voidedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  voidedBy?: Types.ObjectId;

  @Prop()
  voidReason?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;
}

export const InvoiceSchema = SchemaFactory.createForClass(Invoice);

InvoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
InvoiceSchema.index({ tenantId: 1, sessionId: 1, issuedAt: -1 });
