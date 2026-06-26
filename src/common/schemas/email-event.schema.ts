import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailEventDocument = EmailEvent & Document;

export enum EmailProvider {
  RESEND = 'RESEND',
}

export enum EmailEventStatus {
  ACCEPTED = 'ACCEPTED',
  DELIVERED = 'DELIVERED',
  BOUNCED = 'BOUNCED',
  COMPLAINED = 'COMPLAINED',
  FAILED = 'FAILED',
}

@Schema({ timestamps: true })
export class EmailEvent {
  @Prop({
    type: String,
    enum: EmailProvider,
    required: true,
    default: EmailProvider.RESEND,
    index: true,
  })
  provider: EmailProvider;

  @Prop({ type: Types.ObjectId, ref: 'Tenant', index: true })
  tenantId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  userId?: Types.ObjectId;

  @Prop({ index: true })
  emailId?: string;

  @Prop({ required: true, index: true })
  to: string;

  @Prop()
  subject?: string;

  @Prop({ required: true, index: true })
  purpose: string;

  @Prop({
    type: String,
    enum: EmailEventStatus,
    required: true,
    default: EmailEventStatus.ACCEPTED,
    index: true,
  })
  status: EmailEventStatus;

  @Prop({ index: true })
  eventType?: string;

  @Prop()
  lastEventAt?: Date;

  @Prop({ index: true })
  svixId?: string;

  @Prop({ type: Object })
  providerPayload?: Record<string, unknown>;
}

export const EmailEventSchema = SchemaFactory.createForClass(EmailEvent);

EmailEventSchema.index(
  { provider: 1, emailId: 1 },
  { unique: true, sparse: true },
);
EmailEventSchema.index(
  { provider: 1, svixId: 1 },
  { unique: true, sparse: true },
);
EmailEventSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
