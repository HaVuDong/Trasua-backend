import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  integerVndValidator,
  INTEGER_VND_MESSAGE,
} from '../../common/domain/money';
import { Permission } from '../../common/permissions/permission.enum';

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
  @Prop({
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  baseHourly?: number;

  @Prop({
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
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

@Schema({ _id: false })
export class PermissionOverrides {
  @Prop({ type: [String], enum: Permission, default: [] })
  allow?: Permission[];

  @Prop({ type: [String], enum: Permission, default: [] })
  deny?: Permission[];
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
  localOtpAttempts?: number;

  @Prop()
  forgotPasswordOtpCode?: string;

  @Prop()
  forgotPasswordOtpExpires?: Date;

  @Prop({ default: 0 })
  forgotPasswordOtpAttempts?: number;

  @Prop()
  forgotPasswordBlockUntil?: Date;

  @Prop({ default: 0 })
  forgotPasswordLockPhase?: number;

  @Prop({ default: 0 })
  loginAttempts: number;

  @Prop()
  lockUntil?: Date;

  @Prop({ default: false })
  mustChangePassword: boolean;

  @Prop({ default: 1 })
  permissionVersion: number;

  @Prop({ default: 1 })
  authVersion: number;

  @Prop({ type: PermissionOverrides, default: () => ({ allow: [], deny: [] }) })
  permissionOverrides?: PermissionOverrides;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.pre('save', function (this: UserDocument) {
  if (this.role !== Role.SYSTEM_OWNER && !this.tenantId) {
    throw new Error('tenantId is required for non-system owners');
  }
});
