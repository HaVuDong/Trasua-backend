import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WorkShiftDocument = WorkShift & Document;

export enum WorkShiftStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

@Schema({ _id: false })
export class RequiredStaffByRole {
  @Prop({ default: 0 })
  MANAGER: number;

  @Prop({ default: 0 })
  USER: number;

  @Prop({ default: 0 })
  KITCHEN: number;
}

@Schema({ timestamps: true })
export class WorkShift {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, index: true })
  startAt: Date;

  @Prop({ required: true, index: true })
  endAt: Date;

  @Prop({ type: RequiredStaffByRole, default: () => ({}) })
  requiredStaffByRole: RequiredStaffByRole;

  @Prop({ enum: WorkShiftStatus, default: WorkShiftStatus.PENDING_APPROVAL, index: true })
  status: WorkShiftStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  approvedBy?: Types.ObjectId;

  @Prop()
  reviewedAt?: Date;

  @Prop()
  reviewNotes?: string;
}

export const WorkShiftSchema = SchemaFactory.createForClass(WorkShift);
WorkShiftSchema.index({ tenantId: 1, startAt: 1, endAt: 1, status: 1 });
