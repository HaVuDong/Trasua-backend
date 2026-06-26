import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  integerVndValidator,
  INTEGER_VND_MESSAGE,
} from '../../common/domain/money';

export type PayrollDocument = Payroll & Document;

@Schema({ _id: false })
export class AllowanceItem {
  @Prop({ required: true })
  name: string;

  @Prop({
    required: true,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  amount: number;
}

@Schema({ _id: false })
export class DeductionItem {
  @Prop({ required: true })
  name: string;

  @Prop({
    required: true,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  amount: number;

  @Prop()
  reason?: string;
}

@Schema({ timestamps: true })
export class Payroll {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  month: string; // e.g. "2026-05"

  @Prop({
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  baseSalary: number; // Hourly rate or shift rate depending on config

  @Prop({ default: 0 })
  workedHours: number;

  @Prop({ default: 0 })
  workedShifts: number;

  @Prop({ default: 0 })
  overtimeHours: number;

  @Prop({
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  overtimePay: number;

  @Prop({ default: 0 })
  weekendHours: number;

  @Prop({
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  weekendPay: number;

  @Prop({ default: 0 })
  holidayHours: number;

  @Prop({
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  holidayPay: number;

  @Prop({ default: 0 })
  unpaidLeaveDays: number;

  @Prop({ type: [AllowanceItem], default: [] })
  allowances: AllowanceItem[];

  @Prop({
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  totalAllowances: number;

  @Prop({ type: [DeductionItem], default: [] })
  deductions: DeductionItem[];

  @Prop({
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  totalDeductions: number;

  @Prop({
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  totalPayout: number;

  @Prop({
    default: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  finalSalary: number;

  @Prop({ default: 'DRAFT' })
  status: string; // DRAFT, CALCULATED, CONFIRMED

  @Prop({ type: Types.ObjectId, ref: 'User' })
  confirmedBy?: Types.ObjectId;

  @Prop()
  confirmedAt?: Date;

  @Prop()
  adjustmentNote?: string;
}

export const PayrollSchema = SchemaFactory.createForClass(Payroll);
export const PayrollModelName = Payroll.name;
