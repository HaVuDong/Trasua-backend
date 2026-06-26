import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  integerVndValidator,
  INTEGER_VND_MESSAGE,
} from '../../common/domain/money';

export type CashierShiftDocument = CashierShift & Document;

export enum CashierShiftStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

@Schema({ timestamps: true })
export class CashierShift {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({
    type: String,
    enum: CashierShiftStatus,
    required: true,
    default: CashierShiftStatus.OPEN,
    index: true,
  })
  status: CashierShiftStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  openedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  closedBy?: Types.ObjectId;

  @Prop({
    required: true,
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  openingCash: number;

  @Prop({
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  expectedCashSnapshot?: number;

  @Prop({
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  countedCash?: number;

  @Prop({
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  cashDifference?: number;

  @Prop()
  differenceReason?: string;

  @Prop({ required: true, default: Date.now })
  openedAt: Date;

  @Prop()
  closedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;
}

export const CashierShiftSchema = SchemaFactory.createForClass(CashierShift);

CashierShiftSchema.index(
  { tenantId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: CashierShiftStatus.OPEN },
  },
);
CashierShiftSchema.index({ tenantId: 1, openedAt: -1 });
