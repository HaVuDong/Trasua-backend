import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ImportTicketDocument = ImportTicket & Document;

@Schema({ _id: false })
export class ImportItem {
  @Prop({ type: Types.ObjectId, ref: 'InventoryItem', required: true })
  itemId: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true, min: 0 })
  costPrice: number;
}

@Schema({ timestamps: true })
export class ImportTicket {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: [ImportItem], required: true })
  items: ImportItem[];

  @Prop({ required: true })
  provider: string;

  @Prop({ required: true, default: Date.now })
  date: Date;

  @Prop()
  notes?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;
}

export const ImportTicketSchema = SchemaFactory.createForClass(ImportTicket);
