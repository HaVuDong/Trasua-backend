import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  integerVndValidator,
  INTEGER_VND_MESSAGE,
} from '../../common/domain/money';
import {
  CustomerPaymentProvider,
  CustomerPaymentStatus,
} from '../../orders/schemas/customer-payment.schema';

export type SaasPaymentDocument = SaasPayment & Document;

@Schema({ timestamps: true })
export class SaasPayment {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  plan: string;

  @Prop({ required: true, default: 1 })
  months: number;

  @Prop({
    required: true,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  amount: number;

  @Prop({
    type: String,
    enum: CustomerPaymentProvider,
    required: true,
    default: CustomerPaymentProvider.PAYOS,
  })
  provider: CustomerPaymentProvider;

  @Prop({
    type: String,
    enum: CustomerPaymentStatus,
    required: true,
    default: CustomerPaymentStatus.PENDING,
    index: true,
  })
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
  description: string;

  @Prop({ type: Object })
  providerResponse?: Record<string, unknown>;

  @Prop({ type: Object })
  webhookPayload?: Record<string, unknown>;

  @Prop()
  paidAt?: Date;
}

export const SaasPaymentSchema = SchemaFactory.createForClass(SaasPayment);

SaasPaymentSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
