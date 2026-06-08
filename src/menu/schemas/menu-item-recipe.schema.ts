import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MenuItemRecipeDocument = MenuItemRecipe & Document;

export enum MenuRecipeStatus {
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
}

@Schema({ _id: false })
export class MenuRecipeIngredient {
  @Prop({ type: Types.ObjectId, ref: 'InventoryItem', required: true })
  inventoryItemId: Types.ObjectId;

  @Prop({ required: true })
  inventoryItemNameSnapshot: string;

  @Prop({ required: true, min: 0 })
  requiredQuantity: number;

  @Prop({ required: true })
  unitSnapshot: string;

  @Prop({ min: 0, max: 100 })
  wastePercent?: number;

  @Prop({ default: false })
  isOptional?: boolean;
}

@Schema({ timestamps: true })
export class MenuItemRecipe {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MenuItem', required: true, index: true })
  menuItemId: Types.ObjectId;

  @Prop({ type: [MenuRecipeIngredient], default: [] })
  ingredients: MenuRecipeIngredient[];

  @Prop({ required: true, default: 1 })
  version: number;

  @Prop({ enum: MenuRecipeStatus, default: MenuRecipeStatus.ACTIVE })
  status: MenuRecipeStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;
}

export const MenuItemRecipeSchema = SchemaFactory.createForClass(MenuItemRecipe);

MenuItemRecipeSchema.index(
  { tenantId: 1, menuItemId: 1 },
  { unique: true, partialFilterExpression: { status: MenuRecipeStatus.ACTIVE } },
);
MenuItemRecipeSchema.index({ tenantId: 1, 'ingredients.inventoryItemId': 1 });
