import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UserDocument = User & Document;

export enum Role {
  SYSTEM_OWNER = 'SYSTEM_OWNER',
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  USER = 'USER',
  KITCHEN = 'KITCHEN',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  LOCKED = 'LOCKED',
  DELETED = 'DELETED',
}

@Schema({ _id: false })
export class SalaryConfig {
  @Prop()
  baseHourly?: number;

  @Prop()
  baseShift?: number;

  @Prop({ default: 1.5 })
  overtimeMultiplier?: number;
}

@Schema({ _id: false })
export class DeviceInfo {
  @Prop({ required: true })
  deviceId: string;

  @Prop({ required: true })
  userAgent: string;

  @Prop({ required: true })
  ip: string;

  @Prop({ required: true })
  lastLogin: Date;

  @Prop()
  verifiedAt?: Date;

  @Prop()
  trustMethod?: string;
}

@Schema({ timestamps: true })
export class User {
  // null for SYSTEM_OWNER
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: false })
  tenantId?: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: false, unique: true, sparse: true })
  email?: string;

  @Prop({ required: false })
  phone?: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ enum: Role, required: true })
  role: Role;

  @Prop({ enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @Prop()
  avatarUrl?: string;

  @Prop({ type: SalaryConfig, default: () => ({}) })
  salaryConfig?: SalaryConfig;

  @Prop({ type: [DeviceInfo], default: [] })
  trustedDevices: DeviceInfo[];

  @Prop({ type: [String], default: [] })
  ipWhitelist: string[];

  @Prop()
  localOtpCode?: string;

  @Prop()
  localOtpExpires?: Date;

  @Prop({ default: 0 })
  loginAttempts: number;

  @Prop()
  lockUntil?: Date;

  @Prop({ default: false })
  mustChangePassword: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.pre('save', async function (this: any) {
  if (this.role !== Role.SYSTEM_OWNER && !this.tenantId) {
    throw new Error('tenantId is required for non-system owners');
  }
});
