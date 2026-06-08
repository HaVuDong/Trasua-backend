import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AttendanceDocument = Attendance & Document;

export enum AttendanceStatus {
  ON_TIME = 'ON_TIME',
  LATE = 'LATE',
  ABSENT = 'ABSENT',
  ON_LEAVE = 'ON_LEAVE',
}

@Schema({ timestamps: true })
export class Attendance {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ShiftRegistration', index: true })
  shiftRegistrationId?: Types.ObjectId;

  @Prop({ required: true })
  date: Date; // Keep the start of the day

  @Prop()
  checkInTime?: Date;

  @Prop()
  checkOutTime?: Date;

  @Prop()
  ipAddress?: string;

  @Prop()
  gps?: string;

  @Prop({ enum: AttendanceStatus, default: AttendanceStatus.ABSENT })
  status: AttendanceStatus;

  @Prop({ default: 0 })
  totalHours: number;

  @Prop({ default: 0 })
  lateMinutes: number;
}

export const AttendanceSchema = SchemaFactory.createForClass(Attendance);
