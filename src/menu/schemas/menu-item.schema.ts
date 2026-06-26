import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  integerVndValidator,
  INTEGER_VND_MESSAGE,
} from '../../common/domain/money';
import { ItemCategory } from '../../inventory/schemas/inventory.schema';

export type MenuItemDocument = MenuItem & Document;

export enum MenuItemStatus {
  ACTIVE = 'ACTIVE',
  HIDDEN = 'HIDDEN',
  DELETED = 'DELETED',
}

export enum ManualAvailabilityOverride {
  FORCE_AVAILABLE = 'FORCE_AVAILABLE',
  FORCE_UNAVAILABLE = 'FORCE_UNAVAILABLE',
}

@Schema({ timestamps: true })
export class MenuItem {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, enum: ItemCategory, required: true })
  category: ItemCategory;

  @Prop()
  description?: string;

  @Prop({
    required: true,
    min: 0,
    validate: { validator: integerVndValidator, message: INTEGER_VND_MESSAGE },
  })
  sellingPrice: number;

  @Prop()
  imageUrl?: string;

  @Prop({ enum: MenuItemStatus, default: MenuItemStatus.ACTIVE })
  status: MenuItemStatus;

  @Prop({ enum: ManualAvailabilityOverride })
  manualAvailabilityOverride?: ManualAvailabilityOverride;

  @Prop({ type: Types.ObjectId, ref: 'InventoryItem' })
  legacyInventoryItemId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;
}

export const MenuItemSchema = SchemaFactory.createForClass(MenuItem);

MenuItemSchema.index({ tenantId: 1, name: 1 });
MenuItemSchema.index({ tenantId: 1, category: 1 });
MenuItemSchema.index({ tenantId: 1, status: 1 });
