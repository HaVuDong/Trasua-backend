import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InventoryItemDocument = InventoryItem & Document;

export enum ItemCategory {
  DRINK = 'DRINK',
  FOOD = 'FOOD',
  FRUIT = 'FRUIT',
  OTHER = 'OTHER',
}

export enum ItemStatus {
  ACTIVE = 'ACTIVE',
  HIDDEN = 'HIDDEN',
  DELETED = 'DELETED',
}

@Schema({ timestamps: true })
export class InventoryItem {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  unit: string; // e.g. chai, kg, gói

  @Prop({ enum: ItemCategory, required: true })
  category: ItemCategory;

  @Prop()
  imageUrl?: string;

  @Prop({ required: true })
  costPrice: number;

  @Prop({ required: true })
  sellingPrice: number;

  @Prop({ required: true, default: 0 })
  stock: number;

  @Prop({ required: true, default: 10 })
  minStockLevel: number;

  @Prop({ enum: ItemStatus, default: ItemStatus.ACTIVE })
  status: ItemStatus;
}

export const InventoryItemSchema = SchemaFactory.createForClass(InventoryItem);
