import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Role } from '../../users/schemas/user.schema';

export type ShiftRegistrationDocument = ShiftRegistration & Document;

export enum ShiftRegistrationStatus {
  REGISTERED = 'REGISTERED',
  CANCEL_PENDING = 'CANCEL_PENDING',
  CANCELLED = 'CANCELLED',
  LEAVE_APPROVED = 'LEAVE_APPROVED',
  NO_SHOW = 'NO_SHOW',
}

@Schema({ timestamps: true })
export class ShiftRegistration {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'WorkShift', required: true, index: true })
  shiftId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: [Role.MANAGER, Role.USER, Role.KITCHEN], required: true, index: true })
  role: Role;

  @Prop({ enum: ShiftRegistrationStatus, default: ShiftRegistrationStatus.REGISTERED, index: true })
  status: ShiftRegistrationStatus;

  @Prop()
  cancelReason?: string;

  @Prop()
  cancelRequestedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  cancelReviewedBy?: Types.ObjectId;

  @Prop()
  cancelReviewedAt?: Date;

  @Prop()
  cancelReviewNotes?: string;

  @Prop({ default: 0 })
  absencePenaltyAmount: number;
}

export const ShiftRegistrationSchema = SchemaFactory.createForClass(ShiftRegistration);
ShiftRegistrationSchema.index({ tenantId: 1, shiftId: 1, userId: 1 }, { unique: true });
ShiftRegistrationSchema.index({ tenantId: 1, userId: 1, status: 1 });
