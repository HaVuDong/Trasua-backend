import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { baseQuantityValidator } from '../../common/domain/quantity';

export type InventoryAdjustmentDocument = InventoryAdjustment & Document;

export enum InventoryAdjustmentType {
  COUNT_CORRECTION = 'COUNT_CORRECTION',
  DAMAGE = 'DAMAGE',
  WASTE = 'WASTE',
  INTERNAL_USE = 'INTERNAL_USE',
  OTHER = 'OTHER',
}

export enum InventoryAdjustmentStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

const BASE_QUANTITY_MESSAGE =
  'Inventory quantity must be stored as an integer base unit';

@Schema({ timestamps: true })
export class InventoryAdjustment {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'InventoryItem',
    required: true,
    index: true,
  })
  inventoryItemId: Types.ObjectId;

  @Prop({
    type: String,
    enum: InventoryAdjustmentType,
    required: true,
    index: true,
  })
  type: InventoryAdjustmentType;

  @Prop({
    required: true,
    validate: {
      validator: baseQuantityValidator,
      message: BASE_QUANTITY_MESSAGE,
    },
  })
  quantityBefore: number;

  @Prop({
    required: true,
    validate: {
      validator: baseQuantityValidator,
      message: BASE_QUANTITY_MESSAGE,
    },
  })
  quantityAfter: number;

  @Prop({
    required: true,
    validate: {
      validator: baseQuantityValidator,
      message: BASE_QUANTITY_MESSAGE,
    },
  })
  delta: number;

  @Prop({ required: true })
  reason: string;

  @Prop({
    type: String,
    enum: InventoryAdjustmentStatus,
    required: true,
    default: InventoryAdjustmentStatus.PENDING,
    index: true,
  })
  status: InventoryAdjustmentStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  reviewedBy?: Types.ObjectId;

  @Prop()
  reviewedAt?: Date;

  @Prop()
  reviewNote?: string;
}

export const InventoryAdjustmentSchema =
  SchemaFactory.createForClass(InventoryAdjustment);

InventoryAdjustmentSchema.index({
  tenantId: 1,
  inventoryItemId: 1,
  status: 1,
  createdAt: -1,
});
