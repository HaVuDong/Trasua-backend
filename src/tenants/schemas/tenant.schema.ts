import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TenantDocument = Tenant & Document;

export enum TenantStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  EXPIRED = 'EXPIRED',
  DELETED = 'DELETED',
}

export enum SubscriptionStatus {
  TRIALING = 'TRIALING',
  ACTIVE = 'ACTIVE',
  PAST_DUE = 'PAST_DUE',
  EXPIRED = 'EXPIRED',
}

@Schema({ _id: false })
export class SubscriptionInfo {
  @Prop({ required: true })
  plan: string;

  @Prop({ type: String, enum: SubscriptionStatus, default: SubscriptionStatus.ACTIVE })
  status: SubscriptionStatus;

  @Prop({ required: true })
  startDate: Date;

  @Prop({ required: true })
  endDate: Date;

  @Prop()
  trialEndsAt?: Date;

  @Prop({ default: 0 })
  amount?: number;

  @Prop({ default: 'VND' })
  currency?: string;

  @Prop({ default: 'MONTHLY' })
  billingCycle?: string;

  @Prop()
  lastPaymentAt?: Date;
}

@Schema({ _id: false })
export class PaymentRecord {
  @Prop({ required: true })
  date: Date;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  durationMonths: number;

  @Prop()
  performedBy?: string;

  @Prop()
  notes?: string;
}

@Schema({ _id: false })
export class TenantSettings {
  @Prop()
  logoUrl?: string;

  @Prop()
  backgroundUrl?: string;

  @Prop()
  bannerUrl?: string;

  @Prop()
  brandName?: string;

  @Prop()
  primaryColor?: string;

  @Prop({ default: 0 })
  vatRate?: number;

  @Prop({ default: 0 })
  serviceCharge?: number;

  @Prop({ type: [String], default: [] })
  ipWhitelist?: string[];

  @Prop({ default: 5 })
  lateThresholdMinutes?: number;

  @Prop({ default: 8 })
  standardHoursPerDay?: number;
}

@Schema({ timestamps: true })
export class Tenant {
  @Prop({ required: true })
  name: string;

  @Prop()
  subdomain?: string;

  @Prop()
  address?: string;

  @Prop({ required: true })
  ownerName: string;

  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ required: true })
  phone: string;

  @Prop({ enum: TenantStatus, default: TenantStatus.ACTIVE })
  status: TenantStatus;

  @Prop({ type: SubscriptionInfo, required: true })
  subscription: SubscriptionInfo;

  @Prop({ type: TenantSettings, default: () => ({}) })
  settings: TenantSettings;

  @Prop({ type: [PaymentRecord], default: [] })
  paymentHistory: PaymentRecord[];
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);
