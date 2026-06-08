import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TableSessionDocument = TableSession & Document;

export enum TableSessionStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

@Schema({ timestamps: true })
export class TableSession {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Table', required: true, index: true })
  tableId: Types.ObjectId;

  @Prop({ type: String, enum: TableSessionStatus, default: TableSessionStatus.OPEN, index: true })
  status: TableSessionStatus;

  @Prop({ required: true })
  qrCodeTokenSnapshot: string;

  @Prop({ required: true, default: Date.now })
  openedAt: Date;

  @Prop()
  closedAt?: Date;

  @Prop({ required: true, default: Date.now })
  lastActivityAt: Date;

  @Prop()
  customerName?: string;

  @Prop()
  customerPhone?: string;
}

export const TableSessionSchema = SchemaFactory.createForClass(TableSession);

TableSessionSchema.index(
  { tenantId: 1, tableId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: TableSessionStatus.OPEN },
  },
);
