import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Order, OrderDocument, OrderStatus, OrderItemStatus } from './schemas/order.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { Table, TableDocument, TableStatus } from '../tables/schemas/table.schema';
import { InventoryItem, InventoryItemDocument, ItemStatus } from '../inventory/schemas/inventory.schema';
import { InventoryService } from '../inventory/inventory.service';
import { Tenant, TenantDocument } from '../tenants/schemas/tenant.schema';
import { ChatGateway } from '../chat/chat.gateway';
import { MenuItemAvailabilityResult, MenuService } from '../menu/menu.service';
import { MenuItem, MenuItemDocument, MenuItemStatus } from '../menu/schemas/menu-item.schema';
import {
  MenuItemRecipe,
  MenuItemRecipeDocument,
  MenuRecipeIngredient,
  MenuRecipeStatus,
} from '../menu/schemas/menu-item-recipe.schema';
import { TableSession, TableSessionDocument, TableSessionStatus } from './schemas/table-session.schema';

type NormalizedOrderInputItem = {
  requestedId: string;
  quantity: number;
  note?: string;
};

type PreparedOrderItem = {
  itemId: Types.ObjectId;
  legacyInventoryItemId?: Types.ObjectId;
  menuItemNameSnapshot: string;
  quantity: number;
  price: number;
  note?: string;
  status: OrderItemStatus;
  isFree: boolean;
  cancelledAt?: Date;
  cancelledBy?: string;
  cancelReason?: string;
  recipeSnapshot: Array<{
    inventoryItemId: Types.ObjectId;
    ingredientNameSnapshot: string;
    requiredQuantityPerUnit: number;
    totalRequiredQuantity: number;
    unitSnapshot: string;
    wastePercent?: number;
    isOptional?: boolean;
  }>;
};

type IngredientContributor = {
  menuItemId: string;
  menuItemName: string;
  requestedQuantity: number;
  unit: string;
};

type IngredientRequirement = {
  inventoryItemId: string;
  ingredientName: string;
  unit: string;
  totalRequestedQuantity: number;
  contributors: IngredientContributor[];
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Table.name) private tableModel: Model<TableDocument>,
    @InjectModel(InventoryItem.name) private itemModel: Model<InventoryItemDocument>,
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    @InjectModel(MenuItem.name) private menuItemModel: Model<MenuItemDocument>,
    @InjectModel(MenuItemRecipe.name) private menuRecipeModel: Model<MenuItemRecipeDocument>,
    @InjectModel(TableSession.name) private tableSessionModel: Model<TableSessionDocument>,
    private inventoryService: InventoryService,
    private menuService: MenuService,
    private chatGateway: ChatGateway,
  ) {}

  private toPublicTenantObjectId(tenantId: string, message = 'Invalid QR code') {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException(message);
    }
    return new Types.ObjectId(tenantId);
  }

  private getTableObjectId(table: TableDocument): Types.ObjectId {
    return table._id as Types.ObjectId;
  }

  private async markTableServing(table: TableDocument, session?: ClientSession) {
    if (table.status === TableStatus.EMPTY || table.status === TableStatus.CLEANING) {
      table.status = TableStatus.SERVING;
      await table.save(session ? { session } : undefined);
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
  }

  private async findOpenTableSession(
    tenantId: Types.ObjectId,
    tableId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<TableSessionDocument | null> {
    const query = this.tableSessionModel
      .findOne({
        tenantId,
        tableId,
        status: TableSessionStatus.OPEN,
      })
      .sort({ openedAt: -1 });

    if (session) query.session(session);
    return query.exec();
  }

  private async getOrCreateOpenTableSession(
    tenantId: Types.ObjectId,
    table: TableDocument,
    qrCodeTokenSnapshot: string,
    session?: ClientSession,
  ): Promise<TableSessionDocument> {
    const tableId = this.getTableObjectId(table);
    const existingSession = await this.findOpenTableSession(tenantId, tableId, session);
    if (existingSession) {
      existingSession.lastActivityAt = new Date();
      await existingSession.save(session ? { session } : undefined);
      await this.markTableServing(table, session);
      return existingSession;
    }

    const tableSession = new this.tableSessionModel({
      tenantId,
      tableId,
      status: TableSessionStatus.OPEN,
      qrCodeTokenSnapshot,
      openedAt: new Date(),
      lastActivityAt: new Date(),
    });
    let savedSession: TableSessionDocument;
    try {
      savedSession = await tableSession.save(session ? { session } : undefined);
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;

      const racedSession = await this.findOpenTableSession(tenantId, tableId, session);
      if (!racedSession) throw error;
      savedSession = racedSession;
    }

    await this.markTableServing(table, session);
    return savedSession;
  }

  private async resolveOpenTableSession(
    tenantId: Types.ObjectId,
    table: TableDocument,
    qrCodeTokenSnapshot: string,
    requestedSessionId?: string,
  ): Promise<TableSessionDocument> {
    const tableId = this.getTableObjectId(table);

    if (requestedSessionId) {
      if (!Types.ObjectId.isValid(requestedSessionId)) {
        throw new BadRequestException('Invalid table session');
      }

      const requestedSession = await this.tableSessionModel.findOne({
        _id: new Types.ObjectId(requestedSessionId),
        tenantId,
        tableId,
        status: TableSessionStatus.OPEN,
      }).exec();

      if (!requestedSession) {
        throw new BadRequestException('Invalid or expired table session');
      }

      return requestedSession;
    }

    return this.getOrCreateOpenTableSession(tenantId, table, qrCodeTokenSnapshot);
  }

  private async closeOpenTableSessions(tenantId: string | Types.ObjectId, tableId: Types.ObjectId, session?: ClientSession) {
    const tenantObjectId = typeof tenantId === 'string' ? new Types.ObjectId(tenantId) : tenantId;
    const now = new Date();
    const query = this.tableSessionModel.updateMany(
      {
        tenantId: tenantObjectId,
        tableId,
        status: TableSessionStatus.OPEN,
      },
      {
        $set: {
          status: TableSessionStatus.CLOSED,
          closedAt: now,
          lastActivityAt: now,
        },
      },
    );

    if (session) query.session(session);
    await query.exec();
  }

  async getPublicMenu(tenantId: string) {
    this.toPublicTenantObjectId(tenantId, 'Tenant not found');
    const [menuItems, availabilityRows] = await Promise.all([
      this.menuService.findAllMenuItems(tenantId),
      this.menuService.getAvailability(tenantId, 1),
    ]);

    const availabilityByMenuId = new Map<string, MenuItemAvailabilityResult>();
    availabilityRows.forEach((row) => availabilityByMenuId.set(row.menuItemId, row));

    return menuItems
      .filter((item) => item.status === MenuItemStatus.ACTIVE)
      .map((item) => {
        const availability = availabilityByMenuId.get(item._id.toString());

        return {
          _id: item._id.toString(),
          menuItemId: item._id.toString(),
          name: item.name,
          category: item.category,
          description: item.description,
          sellingPrice: item.sellingPrice,
          imageUrl: item.imageUrl,
          available: Boolean(availability?.available),
          availabilityStatus: availability?.status || 'OUT_OF_STOCK',
          availabilityReason: availability?.reason,
        };
      });
  }

  async getTableInfo(tenantId: string, qrToken: string) {
    const tenantObjectId = this.toPublicTenantObjectId(tenantId);
    const table = await this.tableModel.findOne({
      tenantId: tenantObjectId,
      qrCodeToken: qrToken,
    }).exec();

    if (!table) throw new NotFoundException('Invalid QR code');
    if (table.isHidden) throw new BadRequestException('This table is currently unavailable');
    const tableSession = await this.getOrCreateOpenTableSession(tenantObjectId, table, qrToken);
    return {
      name: table.name,
      status: table.status,
      _id: table._id,
      sessionId: tableSession._id,
      sessionStatus: tableSession.status,
    };
  }

  async getPublicOrderStatus(tenantId: string, orderId: string) {
    const tenantObjectId = this.toPublicTenantObjectId(tenantId, 'Order not found');
    const order = await this.orderModel.findOne({
      _id: orderId,
      tenantId: tenantObjectId,
    }).exec();
    if (!order) throw new NotFoundException('Order not found');
    return { status: order.status };
  }

  async createQrOrder(tenantId: string, qrToken: string, dto: CreateOrderDto): Promise<Order> {
    const tenantObjectId = this.toPublicTenantObjectId(tenantId, 'Invalid or expired QR code');
    const table = await this.tableModel.findOne({
      tenantId: tenantObjectId,
      qrCodeToken: qrToken,
    }).exec();

    if (!table) throw new NotFoundException('Invalid or expired QR code');
    if (table.isHidden) throw new BadRequestException('This table is currently unavailable');
    const tableSession = await this.resolveOpenTableSession(tenantObjectId, table, qrToken, dto.sessionId);

    const requestedItems = Array.isArray(dto.items) ? [...dto.items] : [];

    if (table.defaultItemsEnabled && table.defaultItems && table.defaultItems.length > 0) {
      for (const defaultItem of table.defaultItems) {
        const defaultItemId = defaultItem.itemId.toString();
        const alreadyExists = requestedItems.some(
          (i) => String((i as any).menuItemId || (i as any).itemId) === defaultItemId,
        );
        if (!alreadyExists) {
          requestedItems.push({
            itemId: defaultItemId,
            quantity: defaultItem.quantity,
            note: 'Mon mac dinh',
          } as any);
        }
      }
    }

    const items = await this.buildOrderItems(tenantId, requestedItems);
    const totalAmount = this.calculateTotalAmount(items);

    const order = new this.orderModel({
      tenantId: tenantObjectId,
      tableId: table._id,
      sessionId: tableSession._id,
      customer: {
        name: dto.customerName || 'Khach quet QR',
        phone: dto.customerPhone || '',
      },
      items,
      status: OrderStatus.PENDING,
      totalAmount,
      finalAmount: totalAmount,
      orderNote: dto.orderNote,
    });

    const savedOrder = await order.save();
    tableSession.customerName = dto.customerName || tableSession.customerName;
    tableSession.customerPhone = dto.customerPhone || tableSession.customerPhone;
    tableSession.lastActivityAt = new Date();
    await tableSession.save();
    await this.markTableServing(table);

    this.chatGateway.sendOrderEvent(tenantId, 'newQrOrder', savedOrder);
    return savedOrder;
  }

  async createStaffOrder(tenantId: string, creatorId: string, dto: CreateOrderDto): Promise<Order> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const table = await this.tableModel.findOne({ _id: dto.tableId, tenantId: tenantObjectId }).exec();
    if (!table) throw new NotFoundException('Table not found');
    const tableSession = await this.resolveOpenTableSession(tenantObjectId, table, table.qrCodeToken, dto.sessionId);

    const items = await this.buildOrderItems(tenantId, dto.items);
    items.forEach((item) => {
      item.status = OrderItemStatus.PREPARING;
    });
    const totalAmount = this.calculateTotalAmount(items);

    const order = new this.orderModel({
      tenantId: tenantObjectId,
      tableId: new Types.ObjectId(dto.tableId),
      sessionId: tableSession._id,
      items,
      status: OrderStatus.IN_PROGRESS,
      totalAmount,
      finalAmount: totalAmount,
      createdBy: new Types.ObjectId(creatorId),
      confirmedBy: new Types.ObjectId(creatorId),
      confirmedAt: new Date(),
      orderNote: dto.orderNote,
    });

    const savedOrder = await order.save();
    tableSession.lastActivityAt = new Date();
    await tableSession.save();
    await this.markTableServing(table);

    this.chatGateway.sendOrderEvent(tenantId, 'orderConfirmed', savedOrder);
    return savedOrder;
  }

  async confirmOrder(tenantId: string, orderId: string, confirmedBy: string): Promise<Order> {
    const order = await this.orderModel.findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Order is already processed');
    }

    const preparedItems = await this.validateOrderStockAvailability(tenantId, order.items);
    order.items = preparedItems as any;

    order.status = OrderStatus.IN_PROGRESS;
    order.confirmedAt = new Date();
    order.confirmedBy = new Types.ObjectId(confirmedBy);
    order.items.forEach((item: any) => {
      if (item.status === OrderItemStatus.PENDING) {
        item.status = OrderItemStatus.PREPARING;
      }
    });

    const savedOrder = await order.save();
    this.chatGateway.sendOrderEvent(tenantId, 'orderConfirmed', savedOrder);
    return savedOrder;
  }

  async rejectOrder(tenantId: string, orderId: string, reason?: string): Promise<Order> {
    const order = await this.orderModel.findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Order is already processed');
    }

    order.status = OrderStatus.CANCELLED;
    order.rejectReason = reason || 'Don hang bi tu choi';
    order.items.forEach((item: any) => {
      item.status = OrderItemStatus.CANCELLED;
    });

    const table = await this.tableModel.findById(order.tableId).exec();
    if (table) {
      const otherOrders = await this.orderModel.countDocuments({
        tableId: table._id,
        tenantId: new Types.ObjectId(tenantId),
        _id: { $ne: order._id },
        status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
      }).exec();

      if (otherOrders === 0) {
        table.status = TableStatus.EMPTY;
        await table.save();
        await this.closeOpenTableSessions(tenantId, table._id as Types.ObjectId);
      }
    }

    const savedOrder = await order.save();
    this.chatGateway.sendOrderEvent(tenantId, 'orderRejected', savedOrder);
    return savedOrder;
  }

  async cancelItem(
    tenantId: string,
    orderId: string,
    itemId: string,
    cancelledBy: string,
    userRole: string,
    reason?: string,
  ): Promise<Order> {
    const order = await this.orderModel.findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!order) throw new NotFoundException('Order not found');

    const item = order.items.find((i: any) => (i as any)._id?.toString() === itemId || i.itemId.toString() === itemId);
    if (!item) throw new NotFoundException('Item not found in order');

    if (item.status === OrderItemStatus.CANCELLED) {
      throw new BadRequestException('Item is already cancelled');
    }

    const confirmedAt = order.confirmedAt || (order as any).createdAt || new Date();
    const elapsedMs = Date.now() - new Date(confirmedAt).getTime();
    const twoMinutesMs = 2 * 60 * 1000;

    if (elapsedMs > twoMinutesMs) {
      if (userRole !== 'ADMIN' && userRole !== 'MANAGER') {
        throw new ForbiddenException('Sau 2 phut chi Quan ly hoac Admin moi co the huy mon.');
      }
    }

    item.status = OrderItemStatus.CANCELLED;
    item.cancelledAt = new Date();
    item.cancelledBy = cancelledBy;
    item.cancelReason = reason || 'Khong co ly do';

    order.totalAmount = this.calculateTotalAmount(order.items.filter((i: any) => i.status !== OrderItemStatus.CANCELLED));
    order.finalAmount = order.totalAmount;

    const savedOrder = await order.save();
    this.chatGateway.sendOrderEvent(tenantId, 'itemCancelled', { orderId, itemId, reason });
    return savedOrder;
  }

  async updateItemStatus(tenantId: string, orderId: string, itemId: string, status: OrderItemStatus): Promise<Order> {
    const order = await this.orderModel.findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!order) throw new NotFoundException('Order not found');

    const item = order.items.find((i: any) => (i as any)._id?.toString() === itemId || i.itemId.toString() === itemId);
    if (!item) throw new NotFoundException('Item not found in order');

    item.status = status;

    const nonCancelledItems = order.items.filter((i: any) => i.status !== OrderItemStatus.CANCELLED);
    const allReady = nonCancelledItems.length > 0 && nonCancelledItems.every((i: any) => i.status === OrderItemStatus.READY);
    if (allReady) {
      this.chatGateway.sendOrderEvent(tenantId, 'allItemsReady', { orderId });
    }

    const savedOrder = await order.save();
    this.chatGateway.sendOrderEvent(tenantId, 'itemStatusChanged', { orderId, itemId, status });
    return savedOrder;
  }

  async markFree(tenantId: string, orderId: string, itemId?: string): Promise<Order> {
    const order = await this.orderModel.findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!order) throw new NotFoundException('Order not found');

    if (itemId) {
      const item = order.items.find((i: any) => (i as any)._id?.toString() === itemId || i.itemId.toString() === itemId);
      if (!item) throw new NotFoundException('Item not found');
      item.isFree = true;
    } else {
      order.isFree = true;
    }

    order.totalAmount = this.calculateTotalAmount(
      order.items.filter((i: any) => i.status !== OrderItemStatus.CANCELLED && !i.isFree),
    );
    order.finalAmount = order.isFree ? 0 : order.totalAmount;

    return order.save();
  }

  async getBill(tenantId: string, orderId: string, discount = 0, discountType: string = 'FLAT'): Promise<any> {
    const order = await this.orderModel.findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!order) throw new NotFoundException('Order not found');

    if (order.isFree) {
      return {
        subtotal: order.totalAmount,
        discount: order.totalAmount,
        discountType: 'FREE',
        vatRate: 0,
        vatAmount: 0,
        serviceChargeRate: 0,
        serviceChargeAmount: 0,
        finalAmount: 0,
      };
    }

    const tenant = await this.tenantModel.findById(tenantId).exec();
    const vatRate = tenant?.settings?.vatRate || 0;
    const serviceChargeRate = tenant?.settings?.serviceCharge || 0;

    const subtotal = order.totalAmount;
    let discountAmount = 0;

    if (discountType === 'PERCENT') {
      discountAmount = Math.round(subtotal * (discount / 100));
    } else {
      discountAmount = discount;
    }

    const amountAfterDiscount = Math.max(0, subtotal - discountAmount);

    const vatAmount = Math.round(amountAfterDiscount * (vatRate / 100));
    const serviceChargeAmount = Math.round(amountAfterDiscount * (serviceChargeRate / 100));
    const finalAmount = amountAfterDiscount + vatAmount + serviceChargeAmount;

    return {
      subtotal,
      discount: discountAmount,
      discountType,
      vatRate,
      vatAmount,
      serviceChargeRate,
      serviceChargeAmount,
      finalAmount,
    };
  }

  async checkout(tenantId: string, orderId: string, discount = 0, discountType: string = 'FLAT'): Promise<Order> {
    const session = await this.connection.startSession();
    let savedOrder: OrderDocument | null = null;

    try {
      // Checkout uses Mongo transaction for all-or-nothing ingredient deduction.
      // Local standalone MongoDB does not support transactions. Use replica set/Atlas for this flow.
      await session.withTransaction(async () => {
        const order = await this.orderModel.findOne({
          _id: orderId,
          tenantId: new Types.ObjectId(tenantId),
        }).session(session).exec();

        if (!order) throw new NotFoundException('Order not found');
        if (order.status === OrderStatus.COMPLETED) {
          throw new BadRequestException('Order already checked out');
        }
        if (order.status === OrderStatus.CANCELLED) {
          throw new BadRequestException('Cancelled order cannot be checked out');
        }

        const preparedItems = await this.validateOrderStockAvailability(tenantId, order.items, session);
        order.items = preparedItems as any;

        const ingredientRequirements = this.buildIngredientRequirements(preparedItems);
        if (ingredientRequirements.length === 0) {
          throw new BadRequestException('Order has no active items to process');
        }

        const bill = await this.calculateBillFromOrder(tenantId, order, discount, discountType, session);

        for (const requirement of ingredientRequirements) {
          await this.inventoryService.deductStock(
            tenantId,
            requirement.inventoryItemId,
            requirement.totalRequestedQuantity,
            { session, itemName: requirement.ingredientName },
          );
        }

        order.status = OrderStatus.COMPLETED;
        order.completedAt = new Date();
        order.discount = bill.discount;
        order.discountType = discountType;
        order.vat = bill.vatAmount;
        order.serviceCharge = bill.serviceChargeAmount;
        order.finalAmount = bill.finalAmount;
        savedOrder = await order.save({ session });

        const table = await this.tableModel.findById(order.tableId).session(session).exec();
        if (table) {
          const otherOrders = await this.orderModel.countDocuments({
            tableId: table._id,
            tenantId: new Types.ObjectId(tenantId),
            _id: { $ne: order._id },
            status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
          }).session(session).exec();

          if (otherOrders === 0) {
            table.status = TableStatus.CLEANING;
            await table.save({ session });
            await this.closeOpenTableSessions(new Types.ObjectId(tenantId), table._id as Types.ObjectId, session);
          }
        }
      });
    } catch (error: any) {
      if (this.isMongoTransactionUnsupportedError(error)) {
        this.logger.warn(
          `Checkout transaction unsupported on current Mongo deployment (tenantId=${tenantId}, orderId=${orderId}).`,
        );
        throw new BadRequestException({
          code: 'MONGO_TRANSACTION_UNSUPPORTED',
          message: 'MongoDB transaction is not supported. Configure replica set or use MongoDB Atlas/replica set.',
        });
      }
      throw error;
    } finally {
      await session.endSession();
    }

    if (!savedOrder) {
      throw new BadRequestException('Checkout failed');
    }

    this.chatGateway.sendOrderEvent(tenantId, 'orderCompleted', savedOrder);
    return savedOrder;
  }

  async findAllActive(tenantId: string): Promise<Order[]> {
    return this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
    })
      .populate('tableId')
      .populate('items.itemId', 'name category imageUrl sellingPrice status')
      .exec();
  }

  async findOrders(tenantId: string, filters: {
    startDate?: string;
    endDate?: string;
    tableId?: string;
    status?: string;
    customerPhone?: string;
    createdBy?: string;
  }): Promise<Order[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };

    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) query.createdAt.$gte = new Date(filters.startDate);
      if (filters.endDate) query.createdAt.$lte = new Date(filters.endDate);
    }

    if (filters.tableId) {
      query.tableId = new Types.ObjectId(filters.tableId);
    }

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.customerPhone) {
      query['customer.phone'] = { $regex: filters.customerPhone, $options: 'i' };
    }

    if (filters.createdBy) {
      query.createdBy = new Types.ObjectId(filters.createdBy);
    }

    return this.orderModel.find(query)
      .populate('tableId')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOrderById(tenantId: string, orderId: string): Promise<Order> {
    const order = await this.orderModel.findOne({
      _id: orderId,
      tenantId: new Types.ObjectId(tenantId),
    })
      .populate('tableId')
      .populate('createdBy', 'name email')
      .populate('confirmedBy', 'name email')
      .populate('items.itemId', 'name category imageUrl sellingPrice status')
      .exec();

    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async getOrdersByTable(tenantId: string, tableId: string): Promise<Order[]> {
    return this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      tableId: new Types.ObjectId(tableId),
      status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
    })
      .populate('items.itemId', 'name category imageUrl sellingPrice status')
      .sort({ createdAt: -1 })
      .exec();
  }

  async getTableBill(tenantId: string, tableId: string): Promise<any> {
    const orders = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      tableId: new Types.ObjectId(tableId),
      status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
    }).exec();

    const allItems = orders.flatMap((o: any) =>
      o.items
        .filter((i: any) => i.status !== OrderItemStatus.CANCELLED && !i.isFree)
        .map((i: any) => ({
          itemId: i.itemId,
          quantity: i.quantity,
          price: i.price,
          subtotal: i.quantity * i.price,
          note: i.note,
          status: i.status,
        })),
    );

    const subtotal = allItems.reduce((sum, i) => sum + i.subtotal, 0);

    return {
      tableId,
      orderCount: orders.length,
      items: allItems,
      subtotal,
    };
  }

  private async buildOrderItems(tenantId: string, itemDtos: any[]): Promise<PreparedOrderItem[]> {
    const normalizedItems = this.normalizeIncomingOrderItems(itemDtos);
    const preparedItems = await this.convertToPreparedOrderItems(tenantId, normalizedItems);
    await this.validateOrderStockAvailability(tenantId, preparedItems);
    return preparedItems;
  }

  private normalizeIncomingOrderItems(itemDtos: any[]): NormalizedOrderInputItem[] {
    if (!Array.isArray(itemDtos) || itemDtos.length === 0) {
      throw new BadRequestException('Order must contain at least one item');
    }

    return itemDtos.map((itemDto) => {
      const requestedId = String(itemDto?.menuItemId || itemDto?.itemId || '').trim();
      const quantity = Number(itemDto?.quantity);

      if (!requestedId) {
        throw new BadRequestException('Menu item id is required');
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException(`Invalid quantity for item ${requestedId}`);
      }

      return {
        requestedId,
        quantity,
        note: itemDto?.note,
      };
    });
  }

  private async convertToPreparedOrderItems(
    tenantId: string,
    normalizedItems: NormalizedOrderInputItem[],
    baseItems?: any[],
  ): Promise<PreparedOrderItem[]> {
    await this.menuService.findAllMenuItems(tenantId);

    const requestedIds = Array.from(new Set(normalizedItems.map((item) => item.requestedId)));
    const menuByRequestedId = await this.resolveMenuByRequestedIds(tenantId, requestedIds);
    const recipeByMenuId = await this.getActiveRecipeByMenuIds(
      tenantId,
      Array.from(new Set(Array.from(menuByRequestedId.values()).map((menuItem) => menuItem._id.toString()))),
    );

    return normalizedItems.map((item, index) => {
      const menuItem = menuByRequestedId.get(item.requestedId);
      if (!menuItem) {
        throw new NotFoundException(`Menu item ${item.requestedId} not found or unavailable`);
      }

      const recipe = recipeByMenuId.get(menuItem._id.toString());
      if (!recipe || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
        throw this.buildMissingRecipeException(menuItem._id.toString(), menuItem.name);
      }

      const recipeSnapshot = this.buildRecipeSnapshot(recipe.ingredients, item.quantity);
      if (recipeSnapshot.length === 0) {
        throw this.buildMissingRecipeException(menuItem._id.toString(), menuItem.name);
      }

      const baseItem = baseItems?.[index];
      const basePrice = Number(baseItem?.price);

      return {
        itemId: menuItem._id as Types.ObjectId,
        legacyInventoryItemId: menuItem.legacyInventoryItemId as Types.ObjectId | undefined,
        menuItemNameSnapshot: menuItem.name,
        quantity: item.quantity,
        price: Number.isFinite(basePrice) && basePrice >= 0 ? basePrice : menuItem.sellingPrice,
        note: item.note,
        status: (baseItem?.status as OrderItemStatus) || OrderItemStatus.PENDING,
        isFree: Boolean(baseItem?.isFree),
        cancelledAt: baseItem?.cancelledAt,
        cancelledBy: baseItem?.cancelledBy,
        cancelReason: baseItem?.cancelReason,
        recipeSnapshot,
      };
    });
  }

  private async resolveMenuByRequestedIds(
    tenantId: string,
    requestedIds: string[],
  ): Promise<Map<string, MenuItemDocument>> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const result = new Map<string, MenuItemDocument>();

    const validRequestedObjectIds = requestedIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const directMenuItems = validRequestedObjectIds.length
      ? await this.menuItemModel.find({
          tenantId: tenantObjectId,
          _id: { $in: validRequestedObjectIds },
          status: MenuItemStatus.ACTIVE,
        }).exec()
      : [];

    directMenuItems.forEach((menuItem) => {
      result.set(menuItem._id.toString(), menuItem);
    });

    const unresolvedAfterDirect = requestedIds.filter((id) => !result.has(id));
    const unresolvedObjectIds = unresolvedAfterDirect
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const legacyMappedMenuItems = unresolvedObjectIds.length
      ? await this.menuItemModel.find({
          tenantId: tenantObjectId,
          legacyInventoryItemId: { $in: unresolvedObjectIds },
          status: MenuItemStatus.ACTIVE,
        }).exec()
      : [];

    legacyMappedMenuItems.forEach((menuItem) => {
      if (menuItem.legacyInventoryItemId) {
        result.set(menuItem.legacyInventoryItemId.toString(), menuItem);
      }
    });

    const unresolvedIds = requestedIds.filter((id) => !result.has(id));
    if (unresolvedIds.length > 0) {
      const unresolvedObjectIdsForInventory = unresolvedIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));

      if (unresolvedObjectIdsForInventory.length > 0) {
        const linkedLegacyMenuItems = await this.menuItemModel.find({
          tenantId: tenantObjectId,
          legacyInventoryItemId: { $in: unresolvedObjectIdsForInventory },
        }).select({ legacyInventoryItemId: 1 }).exec();

        const alreadyLinkedInventoryIdSet = new Set(
          linkedLegacyMenuItems
            .map((row) => row.legacyInventoryItemId?.toString())
            .filter((value): value is string => Boolean(value)),
        );

        const inventoryItems = await this.itemModel.find({
          tenantId: tenantObjectId,
          _id: { $in: unresolvedObjectIdsForInventory },
          status: ItemStatus.ACTIVE,
        }).exec();

        for (const inventoryItem of inventoryItems) {
          const inventoryId = inventoryItem._id.toString();
          if (!alreadyLinkedInventoryIdSet.has(inventoryId)) {
            throw new BadRequestException({
              code: 'MENU_ITEM_NOT_LINKED',
              message: 'Mon nay chua duoc lien ket menu_items',
              itemId: inventoryId,
              itemName: inventoryItem.name,
            });
          }
        }
      }
    }

    return result;
  }

  private async getActiveRecipeByMenuIds(tenantId: string, menuIds: string[]): Promise<Map<string, MenuItemRecipeDocument>> {
    if (menuIds.length === 0) return new Map<string, MenuItemRecipeDocument>();
    const recipes = await this.menuRecipeModel.find({
      tenantId: new Types.ObjectId(tenantId),
      menuItemId: { $in: menuIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)) },
      status: MenuRecipeStatus.ACTIVE,
    }).exec();

    const map = new Map<string, MenuItemRecipeDocument>();
    recipes.forEach((recipe) => map.set(recipe.menuItemId.toString(), recipe));
    return map;
  }

  private buildRecipeSnapshot(ingredients: MenuRecipeIngredient[], quantity: number): PreparedOrderItem['recipeSnapshot'] {
    return ingredients.map((ingredient) => {
      const wastePercent = Number(ingredient.wastePercent) || 0;
      const wasteMultiplier = 1 + wastePercent / 100;
      const totalRequiredQuantity = Number((ingredient.requiredQuantity * quantity * wasteMultiplier).toFixed(4));
      return {
        inventoryItemId: ingredient.inventoryItemId as Types.ObjectId,
        ingredientNameSnapshot: ingredient.inventoryItemNameSnapshot,
        requiredQuantityPerUnit: ingredient.requiredQuantity,
        totalRequiredQuantity,
        unitSnapshot: ingredient.unitSnapshot,
        wastePercent: ingredient.wastePercent,
        isOptional: Boolean(ingredient.isOptional),
      };
    });
  }

  private async validateOrderStockAvailability(
    tenantId: string,
    items: any[],
    session?: ClientSession,
  ): Promise<PreparedOrderItem[]> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('Order has no items to process');
    }

    const hasRecipeSnapshotForAllActiveItems = items
      .filter((item) => item.status !== OrderItemStatus.CANCELLED)
      .every((item) => Array.isArray(item.recipeSnapshot) && item.recipeSnapshot.length > 0 && item.menuItemNameSnapshot);

    let preparedItems: PreparedOrderItem[];

    if (hasRecipeSnapshotForAllActiveItems) {
      preparedItems = items as PreparedOrderItem[];
    } else {
      const activeBaseItems = items.filter((item) => item.status !== OrderItemStatus.CANCELLED);
      const normalizedItems = activeBaseItems.map((item) => ({
        requestedId: String((item as any).itemId?._id || (item as any).itemId || '').trim(),
        quantity: Number(item.quantity),
        note: item.note,
      }));
      const preparedActiveItems = await this.convertToPreparedOrderItems(tenantId, normalizedItems, activeBaseItems);
      const cancelledItems = items
        .filter((item) => item.status === OrderItemStatus.CANCELLED)
        .map((item) => item as PreparedOrderItem);
      preparedItems = [...preparedActiveItems, ...cancelledItems];
    }

    const requirements = this.buildIngredientRequirements(preparedItems);
    if (requirements.length === 0) {
      throw new BadRequestException('Order has no active items to process');
    }

    await this.validateIngredientRequirements(tenantId, requirements, session);
    return preparedItems;
  }

  private buildIngredientRequirements(items: PreparedOrderItem[]): IngredientRequirement[] {
    const requirementMap = new Map<string, IngredientRequirement>();

    items.forEach((item) => {
      if (item.status === OrderItemStatus.CANCELLED) return;
      const menuItemId = item.itemId.toString();
      const menuItemName = item.menuItemNameSnapshot || menuItemId;

      (item.recipeSnapshot || []).forEach((ingredient) => {
        if (ingredient.isOptional) return;

        const inventoryItemId = ingredient.inventoryItemId.toString();
        const requestedQuantity = Number(ingredient.totalRequiredQuantity);
        if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) return;

        const existing = requirementMap.get(inventoryItemId);
        if (existing) {
          existing.totalRequestedQuantity = Number((existing.totalRequestedQuantity + requestedQuantity).toFixed(4));
          existing.contributors.push({
            menuItemId,
            menuItemName,
            requestedQuantity,
            unit: ingredient.unitSnapshot,
          });
          return;
        }

        requirementMap.set(inventoryItemId, {
          inventoryItemId,
          ingredientName: ingredient.ingredientNameSnapshot,
          unit: ingredient.unitSnapshot,
          totalRequestedQuantity: requestedQuantity,
          contributors: [
            {
              menuItemId,
              menuItemName,
              requestedQuantity,
              unit: ingredient.unitSnapshot,
            },
          ],
        });
      });
    });

    return Array.from(requirementMap.values());
  }

  private async validateIngredientRequirements(
    tenantId: string,
    requirements: IngredientRequirement[],
    session?: ClientSession,
  ): Promise<void> {
    const ingredientObjectIds = requirements
      .map((req) => req.inventoryItemId)
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const inventoryItems = ingredientObjectIds.length
      ? await this.itemModel.find({
          tenantId: new Types.ObjectId(tenantId),
          _id: { $in: ingredientObjectIds },
        }).session(session || null).exec()
      : [];

    const inventoryById = new Map<string, InventoryItemDocument>();
    inventoryItems.forEach((inventoryItem) => {
      inventoryById.set(inventoryItem._id.toString(), inventoryItem);
    });

    const insufficientItems: any[] = [];
    requirements.forEach((requirement) => {
      const inventoryItem = inventoryById.get(requirement.inventoryItemId);
      const availableQuantity = inventoryItem?.status === ItemStatus.ACTIVE ? Number(inventoryItem.stock || 0) : 0;
      const isEnough = availableQuantity >= requirement.totalRequestedQuantity;
      if (isEnough) return;

      requirement.contributors.forEach((contributor) => {
        insufficientItems.push({
          menuItemId: contributor.menuItemId,
          menuItemName: contributor.menuItemName,
          inventoryItemId: requirement.inventoryItemId,
          ingredientName: requirement.ingredientName,
          requestedQuantity: contributor.requestedQuantity,
          totalRequestedQuantity: requirement.totalRequestedQuantity,
          availableQuantity,
          unit: requirement.unit,
        });
      });
    });

    if (insufficientItems.length > 0) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_INGREDIENT_STOCK',
        message: 'Khong du nguyen lieu de tao don',
        items: insufficientItems,
      });
    }
  }

  private buildMissingRecipeException(menuItemId: string, menuItemName: string) {
    return new BadRequestException({
      code: 'MISSING_MENU_RECIPE',
      message: 'Mon nay chua co cong thuc nguyen lieu',
      items: [
        {
          menuItemId,
          menuItemName,
        },
      ],
    });
  }

  private async calculateBillFromOrder(
    tenantId: string,
    order: OrderDocument,
    discount = 0,
    discountType = 'FLAT',
    session?: ClientSession,
  ): Promise<{
    discount: number;
    vatAmount: number;
    serviceChargeAmount: number;
    finalAmount: number;
  }> {
    if (order.isFree) {
      return {
        discount: order.totalAmount,
        vatAmount: 0,
        serviceChargeAmount: 0,
        finalAmount: 0,
      };
    }

    const tenant = await this.tenantModel.findById(tenantId).session(session || null).exec();
    const vatRate = tenant?.settings?.vatRate || 0;
    const serviceChargeRate = tenant?.settings?.serviceCharge || 0;

    const subtotal = order.totalAmount;
    const discountAmount = discountType === 'PERCENT'
      ? Math.round(subtotal * (discount / 100))
      : discount;

    const amountAfterDiscount = Math.max(0, subtotal - discountAmount);
    const vatAmount = Math.round(amountAfterDiscount * (vatRate / 100));
    const serviceChargeAmount = Math.round(amountAfterDiscount * (serviceChargeRate / 100));
    const finalAmount = amountAfterDiscount + vatAmount + serviceChargeAmount;

    return {
      discount: discountAmount,
      vatAmount,
      serviceChargeAmount,
      finalAmount,
    };
  }

  private calculateTotalAmount(items: any[]): number {
    return items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
  }

  private isMongoTransactionUnsupportedError(error: unknown): boolean {
    const fallback = { message: '', codeName: '', code: undefined as number | undefined };
    const details = typeof error === 'object' && error !== null
      ? {
          message: String((error as any).message || ''),
          codeName: String((error as any).codeName || ''),
          code: typeof (error as any).code === 'number' ? (error as any).code : undefined,
        }
      : fallback;

    const message = details.message.toLowerCase();
    return (
      details.code === 20 ||
      details.codeName.toLowerCase() === 'illegaloperation' ||
      message.includes('transaction numbers are only allowed on a replica set member or mongos') ||
      message.includes('replica set') && message.includes('transaction')
    );
  }
}
