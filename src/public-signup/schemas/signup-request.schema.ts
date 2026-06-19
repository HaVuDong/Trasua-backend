import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SignupRequestDocument = SignupRequest & Document;

export enum SignupRequestStatus {
  OTP_PENDING = 'OTP_PENDING',
  VERIFIED = 'VERIFIED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

@Schema({ timestamps: true })
export class SignupRequest {
  @Prop({ required: true })
  storeName: string;

  @Prop({ index: true })
  subdomain?: string;

  @Prop()
  address?: string;

  @Prop({ required: true })
  phone: string;

  @Prop({ required: true })
  adminName: string;

  @Prop({ required: true, index: true })
  adminEmail: string;

  @Prop()
  adminPhone?: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ required: true })
  selectedPlan: string;

  @Prop({ required: true })
  otpHash: string;

  @Prop({ required: true })
  otpExpiresAt: Date;

  @Prop({ default: 0 })
  attempts: number;

  @Prop()
  otpSentAt?: Date;

  @Prop({ type: String, enum: SignupRequestStatus, default: SignupRequestStatus.OTP_PENDING, index: true })
  status: SignupRequestStatus;

  @Prop()
  ip?: string;
}

export const SignupRequestSchema = SchemaFactory.createForClass(SignupRequest);

SignupRequestSchema.index({ adminEmail: 1, status: 1, createdAt: -1 });
SignupRequestSchema.index({ subdomain: 1 }, { sparse: true });
