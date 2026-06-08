import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TableDocument = Table & Document;

export enum TableStatus {
  EMPTY = 'EMPTY',
  SERVING = 'SERVING',
  PAYING = 'PAYING',
  CLEANING = 'CLEANING',
}

@Schema({ _id: false })
export class DefaultItem {
  @Prop({ type: Types.ObjectId, ref: 'InventoryItem', required: true })
  itemId: Types.ObjectId;

  @Prop({ required: true })
  quantity: number;
}

@Schema({ timestamps: true })
export class Table {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ trim: true })
  tableNumber: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  location?: string;

  @Prop({ required: true, default: 4 })
  capacity: number;

  @Prop({ enum: TableStatus, default: TableStatus.EMPTY })
  status: TableStatus;

  // unique code for generating QR (e.g. uuid)
  @Prop({ required: true, unique: true })
  qrCodeToken: string;

  @Prop({ type: [DefaultItem], default: [] })
  defaultItems: DefaultItem[];

  @Prop({ default: false })
  isHidden: boolean;

  @Prop({ default: true })
  defaultItemsEnabled: boolean;
}

export const TableSchema = SchemaFactory.createForClass(Table);

// Hard-delete model: tenantId + tableNumber must be unique for existing records.
// Use partial index to avoid breaking old records that may not be backfilled yet.
TableSchema.index(
  { tenantId: 1, tableNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { tableNumber: { $type: 'string' } },
  },
);
