import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InvoiceCounterDocument = InvoiceCounter & Document;

@Schema({ timestamps: true })
export class InvoiceCounter {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true, index: true })
  dateKey: string;

  @Prop({ required: true, default: 0, min: 0 })
  sequence: number;
}

export const InvoiceCounterSchema =
  SchemaFactory.createForClass(InvoiceCounter);

InvoiceCounterSchema.index({ tenantId: 1, dateKey: 1 }, { unique: true });
