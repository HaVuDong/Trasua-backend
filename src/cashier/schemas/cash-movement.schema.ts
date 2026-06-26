import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Document, Types } from 'mongoose';
import {
  integerVndValidator,
  INTEGER_VND_MESSAGE,
} from '../../common/domain/money';
import { PaymentMethod } from '../../common/domain/payment-method';

export type CashMovementDocument = CashMovement & Document;

export enum CashMovementType {
  CASH_IN = 'CASH_IN',
  CASH_OUT = 'CASH_OUT',
  MANUAL_CHECKOUT = 'MANUAL_CHECKOUT',
  REFUND = 'REFUND',
  ADJUSTMENT = 'ADJUSTMENT',
}

export enum CashMovementSourceType {
  ORDER = 'ORDER',
  TABLE_SESSION = 'TABLE_SESSION',
  MANUAL = 'MANUAL',
  REFUND = 'REFUND',
}

@Schema({ timestamps: true })
export class CashMovement {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'CashierShift',
    required: true,
    index: true,
  })
  shiftId: Types.ObjectId;

  @Prop({ type: String, enum: CashMovementType, required: true, index: true })
  type: CashMovementType;

  @Prop({
    required: true,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  amount: number;

  @Prop({ type: String, enum: PaymentMethod, required: true, index: true })
  paymentMethod: PaymentMethod;

  @Prop({
    type: String,
    enum: CashMovementSourceType,
    required: true,
    index: true,
  })
  sourceType: CashMovementSourceType;

  @Prop({ required: true, index: true })
  sourceId: string;

  @Prop()
  reason?: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  createdBy: Types.ObjectId;
}

export const CashMovementSchema = SchemaFactory.createForClass(CashMovement);

CashMovementSchema.pre('validate', function (this: CashMovementDocument) {
  if (this.sourceType === CashMovementSourceType.MANUAL && !this.sourceId) {
    this.sourceId = `manual:${randomUUID()}`;
  }

  if (this.sourceType !== CashMovementSourceType.MANUAL && !this.sourceId) {
    throw new Error('sourceId is required for automatic cash movements');
  }
});

CashMovementSchema.index(
  { tenantId: 1, shiftId: 1, sourceType: 1, sourceId: 1, type: 1 },
  { unique: true },
);
CashMovementSchema.index({ tenantId: 1, shiftId: 1, createdAt: -1 });
