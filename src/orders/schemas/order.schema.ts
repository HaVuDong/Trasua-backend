import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderDocument = Order & Document;

export enum OrderItemStatus {
  PENDING = 'PENDING',
  PREPARING = 'PREPARING',
  READY = 'READY',
  CANCELLED = 'CANCELLED',
}

export enum OrderStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

@Schema({ _id: true })
export class OrderItem {
  @Prop({ type: Types.ObjectId, ref: 'MenuItem', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'InventoryItem' })
  legacyInventoryItemId?: Types.ObjectId;

  @Prop()
  menuItemNameSnapshot?: string;

  @Prop({ required: true })
  quantity: number;

  @Prop({ required: true })
  price: number;

  @Prop()
  note?: string;

  @Prop({ enum: OrderItemStatus, default: OrderItemStatus.PENDING })
  status: OrderItemStatus;

  @Prop({ default: false })
  isFree: boolean;

  @Prop()
  cancelledAt?: Date;

  @Prop()
  cancelledBy?: string;

  @Prop()
  cancelReason?: string;

  @Prop({
    type: [
      {
        _id: false,
        inventoryItemId: { type: Types.ObjectId, ref: 'InventoryItem', required: true },
        ingredientNameSnapshot: { type: String, required: true },
        requiredQuantityPerUnit: { type: Number, required: true },
        totalRequiredQuantity: { type: Number, required: true },
        unitSnapshot: { type: String, required: true },
        wastePercent: { type: Number },
        isOptional: { type: Boolean, default: false },
      },
    ],
    default: [],
  })
  recipeSnapshot: Array<{
    inventoryItemId: Types.ObjectId;
    ingredientNameSnapshot: string;
    requiredQuantityPerUnit: number;
    totalRequiredQuantity: number;
    unitSnapshot: string;
    wastePercent?: number;
    isOptional?: boolean;
  }>;
}

@Schema({ _id: false })
export class CustomerInfo {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  phone: string;
}

@Schema({ timestamps: true })
export class Order {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Table', required: true })
  tableId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TableSession', index: true })
  sessionId?: Types.ObjectId;

  @Prop({ type: CustomerInfo, required: false })
  customer?: CustomerInfo;

  @Prop({ type: [OrderItem], default: [] })
  items: OrderItem[];

  @Prop({ enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Prop({ required: true, default: 0 })
  totalAmount: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop()
  discountType?: string; // 'FLAT' | 'PERCENT'

  @Prop({ default: 0 })
  vat: number;

  @Prop({ default: 0 })
  serviceCharge: number;

  @Prop({ required: true, default: 0 })
  finalAmount: number;

  @Prop({ default: false })
  isFree: boolean;

  @Prop()
  rejectReason?: string;

  @Prop()
  orderNote?: string;

  // If created manually by a user, or via QR code.
  @Prop({ type: Types.ObjectId, ref: 'User', required: false })
  createdBy?: Types.ObjectId;

  // Who confirmed the order
  @Prop({ type: Types.ObjectId, ref: 'User', required: false })
  confirmedBy?: Types.ObjectId;

  // Timestamps
  @Prop()
  confirmedAt?: Date;

  @Prop()
  completedAt?: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
