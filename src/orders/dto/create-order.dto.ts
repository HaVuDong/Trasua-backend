export class OrderItemDto {
  // New source of truth for sellable item
  menuItemId?: string;
  // Legacy compatibility: old clients still send itemId
  itemId?: string;
  quantity: number;
  note?: string;
}

export class CreateOrderDto {
  tableId: string;
  sessionId?: string;
  customerName?: string;
  customerPhone?: string;
  items: OrderItemDto[];
  orderNote?: string;
}
