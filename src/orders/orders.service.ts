import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
  OnModuleInit,
} from '@nestjs/common';
import { PayOS } from '@payos/node';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHmac } from 'crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  Order,
  OrderDocument,
  OrderStatus,
  OrderItemStatus,
  OrderItemCostSnapshot,
} from './schemas/order.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateCustomerRequestDto } from './dto/customer-request.dto';
import { CreatePayosPaymentDto } from './dto/create-payos-payment.dto';
import {
  Table,
  TableDocument,
  TableStatus,
} from '../tables/schemas/table.schema';
import {
  InventoryItem,
  InventoryItemDocument,
  ItemStatus,
} from '../inventory/schemas/inventory.schema';
import { InventoryService } from '../inventory/inventory.service';
import {
  Tenant,
  TenantDocument,
  TenantStatus,
  SubscriptionStatus,
} from '../tenants/schemas/tenant.schema';
import { ChatGateway } from '../chat/chat.gateway';
import { MenuItemAvailabilityResult, MenuService } from '../menu/menu.service';
import {
  MenuItem,
  MenuItemDocument,
  MenuItemStatus,
} from '../menu/schemas/menu-item.schema';
import { AuditLogService } from '../common/services/audit-log.service';
import { runTransactionSensitive } from '../common/domain/transaction';
import {
  MenuItemRecipe,
  MenuItemRecipeDocument,
  MenuRecipeIngredient,
  MenuRecipeStatus,
} from '../menu/schemas/menu-item-recipe.schema';
import {
  TableSession,
  TableSessionDocument,
  TableSessionPaymentMethod,
  TableSessionPaymentStatus,
  TableSessionStatus,
} from './schemas/table-session.schema';
import {
  CustomerPaymentMethod,
  CustomerRequest,
  CustomerRequestDocument,
  CustomerRequestStatus,
  CustomerRequestType,
} from './schemas/customer-request.schema';
import {
  CustomerPayment,
  CustomerPaymentDocument,
  CustomerPaymentProvider,
  CustomerPaymentStatus,
} from './schemas/customer-payment.schema';
import { CashierService } from '../cashier/cashier.service';
import { PaymentMethod } from '../common/domain/payment-method';
import {
  CashMovementSourceType,
  CashMovementType,
} from '../cashier/schemas/cash-movement.schema';

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
  costSnapshot?: OrderItemCostSnapshot;
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
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Table.name) private tableModel: Model<TableDocument>,
    @InjectModel(InventoryItem.name)
    private itemModel: Model<InventoryItemDocument>,
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    @InjectModel(MenuItem.name) private menuItemModel: Model<MenuItemDocument>,
    @InjectModel(MenuItemRecipe.name)
    private menuRecipeModel: Model<MenuItemRecipeDocument>,
    @InjectModel(TableSession.name)
    private tableSessionModel: Model<TableSessionDocument>,
    @InjectModel(CustomerRequest.name)
    private customerRequestModel: Model<CustomerRequestDocument>,
    @InjectModel(CustomerPayment.name)
    private customerPaymentModel: Model<CustomerPaymentDocument>,
    private inventoryService: InventoryService,
    private menuService: MenuService,
    private chatGateway: ChatGateway,
    private auditLogService: AuditLogService,
    @Optional() private cashierService?: CashierService,
  ) {}

  onModuleInit() {
    setInterval(() => {
      this.autoCleanupEmptySessions().catch(err => this.logger.error('Auto cleanup empty sessions failed', err));
    }, 10 * 60 * 1000);
  }

  private async autoCleanupEmptySessions() {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const emptySessions = await this.tableSessionModel.find({
      status: TableSessionStatus.OPEN,
      lastActivityAt: { $lt: tenMinutesAgo }
    }).exec();

    for (const session of emptySessions) {
      const orderCount = await this.orderModel.countDocuments({
        sessionId: session._id,
      });

      if (orderCount === 0) {
        this.logger.log(`Auto closing empty session ${session._id}`);
        session.status = TableSessionStatus.CLOSED;
        session.lastActivityAt = new Date();
        await session.save();

        const table = await this.tableModel.findById(session.tableId).exec();
        if (table) {
          table.status = TableStatus.EMPTY;
          await table.save();
        }

        this.chatGateway.sendTableSyncEvent(session.tenantId.toString());
      }
    }
  }

  private toPublicTenantObjectId(
    tenantId: string,
    message = 'Invalid QR code',
  ) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException(message);
    }
    return new Types.ObjectId(tenantId);
  }

  private async assertTenantAcceptsPublicOrders(
    tenantObjectId: Types.ObjectId,
  ) {
    const tenant = await this.tenantModel
      .findById(tenantObjectId)
      .select('status subscription')
      .lean()
      .exec();
    const subscription = tenant?.subscription;
    const subscriptionStatusAllowed =
      subscription?.status === SubscriptionStatus.TRIALING ||
      subscription?.status === SubscriptionStatus.ACTIVE;
    const endDateAllowed = subscription?.endDate
      ? new Date(subscription.endDate).getTime() >= Date.now()
      : false;

    if (
      !tenant ||
      tenant.status !== TenantStatus.ACTIVE ||
      !subscriptionStatusAllowed ||
      !endDateAllowed
    ) {
      throw new ForbiddenException(
        'Cua hang tam ngung nhan don. Vui long lien he nhan vien.',
      );
    }
  }

  private getTableObjectId(table: TableDocument): Types.ObjectId {
    return table._id as Types.ObjectId;
  }

  private async markTableServing(
    table: TableDocument,
    session?: ClientSession,
  ) {
    if (
      table.status === TableStatus.EMPTY ||
      table.status === TableStatus.CLEANING
    ) {
      table.status = TableStatus.SERVING;
      await table.save(session ? { session } : undefined);
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      (error as { code?: number }).code === 11000,
    );
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
    const existingSession = await this.findOpenTableSession(
      tenantId,
      tableId,
      session,
    );
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

      const racedSession = await this.findOpenTableSession(
        tenantId,
        tableId,
        session,
      );
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

      const requestedSession = await this.tableSessionModel
        .findOne({
          _id: new Types.ObjectId(requestedSessionId),
          tenantId,
          tableId,
          status: TableSessionStatus.OPEN,
        })
        .exec();

      if (!requestedSession) {
        throw new BadRequestException('Invalid or expired table session');
      }

      return requestedSession;
    }

    return this.getOrCreateOpenTableSession(
      tenantId,
      table,
      qrCodeTokenSnapshot,
    );
  }

  private async closeOpenTableSessions(
    tenantId: string | Types.ObjectId,
    tableId: Types.ObjectId,
    session?: ClientSession,
  ) {
    const tenantObjectId =
      typeof tenantId === 'string' ? new Types.ObjectId(tenantId) : tenantId;
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
    const tenantObjectId = this.toPublicTenantObjectId(
      tenantId,
      'Tenant not found',
    );
    await this.assertTenantAcceptsPublicOrders(tenantObjectId);
    const [menuItems, availabilityRows] = await Promise.all([
      this.menuService.findAllMenuItems(tenantId),
      this.menuService.getAvailability(tenantId, 1),
    ]);

    const availabilityByMenuId = new Map<string, MenuItemAvailabilityResult>();
    availabilityRows.forEach((row) =>
      availabilityByMenuId.set(row.menuItemId, row),
    );

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
    await this.assertTenantAcceptsPublicOrders(tenantObjectId);
    const table = await this.tableModel
      .findOne({
        tenantId: tenantObjectId,
        qrCodeToken: qrToken,
      })
      .exec();

    if (!table) throw new NotFoundException('Invalid QR code');
    if (table.isHidden)
      throw new BadRequestException('This table is currently unavailable');
    const tableSession = await this.getOrCreateOpenTableSession(
      tenantObjectId,
      table,
      qrToken,
    );
    return {
      name: table.name,
      status: table.status,
      _id: table._id,
      sessionId: tableSession._id,
      sessionStatus: tableSession.status,
    };
  }

  async getPublicOrderStatus(tenantId: string, orderId: string) {
    const tenantObjectId = this.toPublicTenantObjectId(
      tenantId,
      'Order not found',
    );
    await this.assertTenantAcceptsPublicOrders(tenantObjectId);
    const order = await this.orderModel
      .findOne({
        _id: orderId,
        tenantId: tenantObjectId,
      })
      .populate('items.itemId', 'name category imageUrl sellingPrice status')
      .exec();
    if (!order) throw new NotFoundException('Order not found');
    return {
      status: order.status,
      items: (order.items || []).map((item: any) => ({
        _id: item._id?.toString() || this.getOrderItemMenuId(item),
        itemId: this.getOrderItemMenuId(item),
        name: this.getOrderItemName(item),
        quantity: Number(item.quantity || 0),
        status: item.status,
        note: item.note,
      })),
    };
  }

  async getTableSessionSummary(tenantId: string, sessionId: string) {
    const tenantObjectId = this.toPublicTenantObjectId(
      tenantId,
      'Table session not found',
    );
    await this.assertTenantAcceptsPublicOrders(tenantObjectId);
    const sessionObjectId = this.toObjectId(sessionId, 'Invalid table session');
    return this.buildTableSessionSummary(tenantObjectId, sessionObjectId);
  }

  async createCustomerRequest(
    tenantId: string,
    qrToken: string,
    dto: CreateCustomerRequestDto,
  ) {
    const tenantObjectId = this.toPublicTenantObjectId(
      tenantId,
      'Invalid or expired QR code',
    );
    await this.assertTenantAcceptsPublicOrders(tenantObjectId);
    const requestType = dto?.type;
    if (!Object.values(CustomerRequestType).includes(requestType)) {
      throw new BadRequestException('Invalid customer request type');
    }

    const table = await this.tableModel
      .findOne({
        tenantId: tenantObjectId,
        qrCodeToken: qrToken,
      })
      .exec();

    if (!table) throw new NotFoundException('Invalid or expired QR code');
    if (table.isHidden)
      throw new BadRequestException('This table is currently unavailable');

    const sessionObjectId = this.toObjectId(
      dto.sessionId,
      'Invalid table session',
    );
    const tableSession = await this.tableSessionModel
      .findOne({
        _id: sessionObjectId,
        tenantId: tenantObjectId,
        tableId: table._id,
        status: TableSessionStatus.OPEN,
      })
      .exec();

    if (!tableSession) {
      throw new BadRequestException('Invalid or expired table session');
    }

    if (dto.customerName || dto.customerPhone) {
      tableSession.customerName = dto.customerName || tableSession.customerName;
      tableSession.customerPhone =
        dto.customerPhone || tableSession.customerPhone;
      tableSession.lastActivityAt = new Date();
    }

    const summary = await this.buildTableSessionSummary(
      tenantObjectId,
      sessionObjectId,
    );
    const paymentMethod = this.getRequestPaymentMethod(
      requestType,
      dto.paymentMethod,
    );
    let payment: any = null;

    if (
      requestType === CustomerRequestType.PAY_CASH ||
      requestType === CustomerRequestType.PAY_TRANSFER ||
      requestType === CustomerRequestType.PRINT_BILL
    ) {
      tableSession.paymentStatus = TableSessionPaymentStatus.REQUESTED;
      tableSession.paymentMethod =
        paymentMethod === CustomerPaymentMethod.CASH
          ? TableSessionPaymentMethod.CASH
          : TableSessionPaymentMethod.TRANSFER;
    }
    tableSession.lastActivityAt = new Date();
    await tableSession.save();

    if (requestType === CustomerRequestType.PRINT_BILL) {
      payment = await this.ensurePayosPaymentForSession(
        tenantObjectId,
        tableSession,
        summary,
      );
    }

    const idempotentRequestTypes = [
      CustomerRequestType.CALL_STAFF,
      CustomerRequestType.PAY_CASH,
      CustomerRequestType.PAY_TRANSFER,
      CustomerRequestType.PRINT_BILL,
    ];
    if (idempotentRequestTypes.includes(requestType)) {
      const existingRequest = await this.customerRequestModel
        .findOne({
          tenantId: tenantObjectId,
          tableId: table._id,
          sessionId: tableSession._id,
          type: requestType,
          status: {
            $in: [
              CustomerRequestStatus.PENDING,
              CustomerRequestStatus.ACKNOWLEDGED,
            ],
          },
        })
        .sort({ createdAt: -1 })
        .exec();

      if (existingRequest) {
        if (!payment && existingRequest.paymentId) {
          const existingPayment = await this.customerPaymentModel
            .findById(existingRequest.paymentId)
            .exec();
          payment = existingPayment
            ? this.toPublicPaymentResponse(existingPayment)
            : null;
        }

        return {
          _id: existingRequest._id.toString(),
          type: existingRequest.type,
          status: existingRequest.status,
          paymentMethod: existingRequest.paymentMethod,
          message: existingRequest.message,
          tenantId,
          tableId: table._id.toString(),
          tableName: table.name,
          sessionId: tableSession._id.toString(),
          customerName: tableSession.customerName,
          customerPhone: tableSession.customerPhone,
          bill: summary.bill,
          payment,
          createdAt: (existingRequest as any).createdAt,
          reused: true,
        };
      }
    }

    const customerRequest = new this.customerRequestModel({
      tenantId: tenantObjectId,
      tableId: table._id,
      sessionId: tableSession._id,
      type: requestType,
      paymentMethod,
      message: dto.message?.trim() || undefined,
      customerName: tableSession.customerName,
      customerPhone: tableSession.customerPhone,
      tableNameSnapshot: table.name,
      qrTokenSnapshot: qrToken,
      paymentId: payment?.paymentId
        ? new Types.ObjectId(payment.paymentId)
        : undefined,
      billSnapshot: summary.bill,
    });

    const savedRequest = await customerRequest.save();
    const payload = {
      _id: savedRequest._id.toString(),
      type: savedRequest.type,
      status: savedRequest.status,
      paymentMethod: savedRequest.paymentMethod,
      message: savedRequest.message,
      tenantId,
      tableId: table._id.toString(),
      tableName: table.name,
      sessionId: tableSession._id.toString(),
      customerName: tableSession.customerName,
      customerPhone: tableSession.customerPhone,
      bill: summary.bill,
      payment,
      createdAt: (savedRequest as any).createdAt,
    };

    await this.auditLogService.logSystem(tenantId, 'CUSTOMER_REQUEST_CREATED', {
      requestId: savedRequest._id.toString(),
      type: savedRequest.type,
      sessionId: tableSession._id.toString(),
      tableId: table._id.toString(),
      tableName: table.name,
      paymentMethod,
      amount: summary.bill?.finalAmount,
    });

    this.chatGateway.sendOrderEvent(tenantId, 'customerRequest', payload);
    return payload;
  }

  async createPayosPayment(tenantId: string, dto: CreatePayosPaymentDto) {
    const tenantObjectId = this.toPublicTenantObjectId(
      tenantId,
      'Table session not found',
    );
    await this.assertTenantAcceptsPublicOrders(tenantObjectId);
    const sessionObjectId = this.toObjectId(
      dto.sessionId,
      'Invalid table session',
    );
    const tableSession = await this.tableSessionModel
      .findOne({
        _id: sessionObjectId,
        tenantId: tenantObjectId,
        status: TableSessionStatus.OPEN,
      })
      .exec();

    if (!tableSession) {
      throw new BadRequestException('Invalid or expired table session');
    }

    if (dto.customerName || dto.customerPhone) {
      tableSession.customerName = dto.customerName || tableSession.customerName;
      tableSession.customerPhone =
        dto.customerPhone || tableSession.customerPhone;
    }
    tableSession.paymentStatus = TableSessionPaymentStatus.REQUESTED;
    tableSession.paymentMethod = TableSessionPaymentMethod.TRANSFER;
    tableSession.lastActivityAt = new Date();
    await tableSession.save();

    const summary = await this.buildTableSessionSummary(
      tenantObjectId,
      sessionObjectId,
    );
    return this.ensurePayosPaymentForSession(
      tenantObjectId,
      tableSession,
      summary,
    );
  }

  async getCustomerPaymentStatus(
    paymentId: string,
    tenantId: string,
    sessionId: string,
  ) {
    const paymentObjectId = this.toObjectId(paymentId, 'Payment not found');
    const tenantObjectId = this.toObjectId(tenantId, 'Payment not found');
    const sessionObjectId = this.toObjectId(sessionId, 'Payment not found');
    const payment = await this.customerPaymentModel
      .findOne({
        _id: paymentObjectId,
        tenantId: tenantObjectId,
        sessionId: sessionObjectId,
      })
      .exec();
    if (!payment) throw new NotFoundException('Payment not found');
    return this.toPublicPaymentResponse(payment);
  }

  async handlePayosWebhook(body: Record<string, unknown>) {
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY || '';
    const clientId = process.env.PAYOS_CLIENT_ID || '';
    const apiKey = process.env.PAYOS_API_KEY || '';

    if (!checksumKey || !clientId || !apiKey) {
      throw new BadRequestException('payOS is not configured');
    }

    let data = body.data as Record<string, unknown>;
    const signature = String(body.signature || '');
    const computedSignature = this.createPayosSignature(data, checksumKey);

    if (signature !== computedSignature) {
      const payos = new PayOS(clientId, apiKey, checksumKey);
      try {
        data = payos.verifyPaymentWebhookData(body as any) as any;
      } catch (error) {
        throw new BadRequestException('Invalid payOS webhook signature');
      }
    }

    const orderCode = Number(data.orderCode);
    if (!Number.isFinite(orderCode)) {
      throw new BadRequestException('Invalid payOS order code');
    }

    const payment = await this.customerPaymentModel
      .findOne({ orderCode })
      .exec();
    if (!payment) {
      return { success: true };
    }

    payment.webhookPayload = body;
    const webhookCode = String(data.code || body.code || '');
    const isPaid = body.success === true || webhookCode === '00';
    const payloadData = data as any;
    const isCancelled =
      payloadData.cancel === true ||
      String(payloadData.status || '').toUpperCase() === 'CANCELLED';

    const wasAlreadyPaid = payment.status === CustomerPaymentStatus.PAID;
    if (isPaid) {
      payment.status = CustomerPaymentStatus.PAID;
      payment.paidAt = payment.paidAt || new Date();
    } else if (isCancelled && payment.status !== CustomerPaymentStatus.PAID) {
      payment.status = CustomerPaymentStatus.CANCELLED;
    }

    const savedPayment = await payment.save();
    if (
      isPaid &&
      !wasAlreadyPaid &&
      savedPayment.status === CustomerPaymentStatus.PAID
    ) {
      await this.tableSessionModel
        .updateOne(
          {
            _id: savedPayment.sessionId,
            tenantId: savedPayment.tenantId,
          },
          {
            $set: {
              paymentStatus: TableSessionPaymentStatus.PAID,
              paymentMethod: TableSessionPaymentMethod.TRANSFER,
              paidAt: savedPayment.paidAt || new Date(),
              lastActivityAt: new Date(),
            },
            $inc: {
              totalPaidAmount: savedPayment.amount,
            },
          },
        )
        .exec();

      await this.auditLogService.logSystem(
        savedPayment.tenantId.toString(),
        'CUSTOMER_PAYMENT_PAID',
        {
          paymentId: savedPayment._id.toString(),
          orderCode: savedPayment.orderCode,
          amount: savedPayment.amount,
          sessionId: savedPayment.sessionId.toString(),
          tableId: savedPayment.tableId.toString(),
          provider: savedPayment.provider,
        },
      );

      this.chatGateway.sendOrderEvent(
        savedPayment.tenantId.toString(),
        'paymentPaid',
        {
          ...this.toPublicPaymentResponse(savedPayment),
          tableId: savedPayment.tableId.toString(),
          tableName: savedPayment.tableNameSnapshot,
          sessionId: savedPayment.sessionId.toString(),
          customerName: savedPayment.customerName,
          customerPhone: savedPayment.customerPhone,
          bill: savedPayment.billSnapshot,
        },
      );
    }

    return { success: true };
  }

  async createQrOrder(
    tenantId: string,
    qrToken: string,
    dto: CreateOrderDto,
  ): Promise<Order> {
    const tenantObjectId = this.toPublicTenantObjectId(
      tenantId,
      'Invalid or expired QR code',
    );
    await this.assertTenantAcceptsPublicOrders(tenantObjectId);
    const table = await this.tableModel
      .findOne({
        tenantId: tenantObjectId,
        qrCodeToken: qrToken,
      })
      .exec();

    if (!table) throw new NotFoundException('Invalid or expired QR code');
    if (table.isHidden)
      throw new BadRequestException('This table is currently unavailable');
    const tableSession = await this.resolveOpenTableSession(
      tenantObjectId,
      table,
      qrToken,
      dto.sessionId,
    );

    const requestedItems = Array.isArray(dto.items) ? [...dto.items] : [];

    if (
      table.defaultItemsEnabled &&
      table.defaultItems &&
      table.defaultItems.length > 0
    ) {
      for (const defaultItem of table.defaultItems) {
        const defaultItemId = defaultItem.itemId.toString();
        const alreadyExists = requestedItems.some(
          (i) =>
            String((i as any).menuItemId || (i as any).itemId) ===
            defaultItemId,
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
    tableSession.customerPhone =
      dto.customerPhone || tableSession.customerPhone;
    tableSession.lastActivityAt = new Date();
    if (
      tableSession.paymentStatus === TableSessionPaymentStatus.PAID ||
      tableSession.paymentStatus === TableSessionPaymentStatus.REQUESTED
    ) {
      tableSession.paymentStatus = TableSessionPaymentStatus.UNPAID;
    }
    await tableSession.save();
    await this.markTableServing(table);

    this.chatGateway.sendOrderEvent(tenantId, 'newQrOrder', savedOrder);
    return savedOrder;
  }

  async createStaffOrder(
    tenantId: string,
    creatorId: string,
    dto: CreateOrderDto,
  ): Promise<Order> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const table = await this.tableModel
      .findOne({ _id: dto.tableId, tenantId: tenantObjectId })
      .exec();
    if (!table) throw new NotFoundException('Table not found');
    const tableSession = await this.resolveOpenTableSession(
      tenantObjectId,
      table,
      table.qrCodeToken,
      dto.sessionId,
    );

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
    if (
      tableSession.paymentStatus === TableSessionPaymentStatus.PAID ||
      tableSession.paymentStatus === TableSessionPaymentStatus.REQUESTED
    ) {
      tableSession.paymentStatus = TableSessionPaymentStatus.UNPAID;
    }
    await tableSession.save();
    await this.markTableServing(table);

    this.chatGateway.sendOrderEvent(tenantId, 'orderConfirmed', savedOrder);
    return savedOrder;
  }

  async confirmOrder(
    tenantId: string,
    orderId: string,
    confirmedBy: string,
  ): Promise<Order> {
    const order = await this.orderModel
      .findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Order is already processed');
    }

    const preparedItems = await this.validateOrderStockAvailability(
      tenantId,
      order.items,
    );
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

  async rejectOrder(
    tenantId: string,
    orderId: string,
    reason?: string,
  ): Promise<Order> {
    const order = await this.orderModel
      .findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) })
      .exec();
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
      const otherOrders = await this.orderModel
        .countDocuments({
          tableId: table._id,
          tenantId: new Types.ObjectId(tenantId),
          _id: { $ne: order._id },
          status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
        })
        .exec();

      if (otherOrders === 0) {
        table.status = TableStatus.EMPTY;
        await table.save();
        await this.closeOpenTableSessions(
          tenantId,
          table._id as Types.ObjectId,
        );
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
    canCancelLate = false,
  ): Promise<Order> {
    const order = await this.orderModel
      .findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!order) throw new NotFoundException('Order not found');

    const item = order.items.find(
      (i: any) =>
        (i as any)._id?.toString() === itemId || i.itemId.toString() === itemId,
    );
    if (!item) throw new NotFoundException('Item not found in order');

    if (item.status === OrderItemStatus.CANCELLED) {
      throw new BadRequestException('Item is already cancelled');
    }

    const confirmedAt =
      order.confirmedAt || (order as any).createdAt || new Date();
    const elapsedMs = Date.now() - new Date(confirmedAt).getTime();
    const twoMinutesMs = 2 * 60 * 1000;

    if (elapsedMs > twoMinutesMs) {
      if (userRole !== 'ADMIN' && userRole !== 'MANAGER' && !canCancelLate) {
        throw new ForbiddenException(
          'Sau 2 phut chi Quan ly hoac Admin moi co the huy mon.',
        );
      }
    }

    item.status = OrderItemStatus.CANCELLED;
    item.cancelledAt = new Date();
    item.cancelledBy = cancelledBy;
    item.cancelReason = reason || 'Khong co ly do';

    order.totalAmount = this.calculateTotalAmount(
      order.items.filter((i: any) => i.status !== OrderItemStatus.CANCELLED),
    );
    order.finalAmount = order.totalAmount;

    const savedOrder = await order.save();
    await this.auditLogService.log(
      tenantId,
      cancelledBy,
      'ORDER_ITEM_CANCELLED',
      {
        orderId,
        itemId,
        reason: item.cancelReason,
        elapsedMs,
        itemStatus: item.status,
      },
    );
    this.chatGateway.sendOrderEvent(tenantId, 'itemCancelled', {
      orderId,
      itemId,
      reason,
    });
    return savedOrder;
  }

  async updateItemStatus(
    tenantId: string,
    orderId: string,
    itemId: string,
    status: OrderItemStatus,
    userRole?: string,
  ): Promise<Order> {
    if (!Object.values(OrderItemStatus).includes(status)) {
      throw new BadRequestException('Invalid item status');
    }

    const order = await this.orderModel
      .findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!order) throw new NotFoundException('Order not found');

    const item = order.items.find(
      (i: any) =>
        (i as any)._id?.toString() === itemId || i.itemId.toString() === itemId,
    );
    if (!item) throw new NotFoundException('Item not found in order');

    if (userRole === 'KITCHEN') {
      if (
        order.status !== OrderStatus.IN_PROGRESS ||
        item.status !== OrderItemStatus.PREPARING ||
        status !== OrderItemStatus.READY
      ) {
        throw new ForbiddenException(
          'Bep chi duoc chuyen mon dang lam sang da xong.',
        );
      }
    }

    if (userRole === 'USER') {
      if (
        order.status !== OrderStatus.IN_PROGRESS ||
        item.status !== OrderItemStatus.READY ||
        status !== OrderItemStatus.SERVED
      ) {
        throw new ForbiddenException(
          'Nhan vien chi duoc chuyen mon da xong sang da phuc vu.',
        );
      }
    }

    item.status = status;

    const nonCancelledItems = order.items.filter(
      (i: any) => i.status !== OrderItemStatus.CANCELLED,
    );
    const allReady =
      nonCancelledItems.length > 0 &&
      nonCancelledItems.every(
        (i: any) =>
          i.status === OrderItemStatus.READY ||
          i.status === OrderItemStatus.SERVED,
      );
    if (allReady) {
      this.chatGateway.sendOrderEvent(tenantId, 'allItemsReady', { orderId });
    }

    const savedOrder = await order.save();
    this.chatGateway.sendOrderEvent(tenantId, 'itemStatusChanged', {
      orderId,
      itemId,
      status,
    });
    return savedOrder;
  }

  async markFree(
    tenantId: string,
    orderId: string,
    itemId?: string,
    markedBy?: string,
  ): Promise<Order> {
    const order = await this.orderModel
      .findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!order) throw new NotFoundException('Order not found');

    if (itemId) {
      const item = order.items.find(
        (i: any) =>
          (i as any)._id?.toString() === itemId ||
          i.itemId.toString() === itemId,
      );
      if (!item) throw new NotFoundException('Item not found');
      item.isFree = true;
    } else {
      order.isFree = true;
    }

    order.totalAmount = this.calculateTotalAmount(
      order.items.filter(
        (i: any) => i.status !== OrderItemStatus.CANCELLED && !i.isFree,
      ),
    );
    order.finalAmount = order.isFree ? 0 : order.totalAmount;

    const savedOrder = await order.save();
    await this.auditLogService.log(tenantId, markedBy, 'ORDER_MARKED_FREE', {
      orderId,
      itemId,
      orderIsFree: Boolean(order.isFree),
      totalAmount: order.totalAmount,
      finalAmount: order.finalAmount,
    });
    return savedOrder;
  }

  async getBill(
    tenantId: string,
    orderId: string,
    discount = 0,
    discountType: string = 'FLAT',
  ): Promise<any> {
    const order = await this.orderModel
      .findOne({ _id: orderId, tenantId: new Types.ObjectId(tenantId) })
      .exec();
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
    const serviceChargeAmount = Math.round(
      amountAfterDiscount * (serviceChargeRate / 100),
    );
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

  async checkout(
    tenantId: string,
    orderId: string,
    discount = 0,
    discountType: string = 'FLAT',
    actorId?: string,
    options: {
      skipCashMovement?: boolean;
      paymentMethod?: PaymentMethod;
    } = {},
  ): Promise<Order> {
    let savedOrder: OrderDocument | null = null;
    savedOrder = await runTransactionSensitive(
      this.connection,
      (session) =>
        this.checkoutOrderWithinSession(
          tenantId,
          orderId,
          discount,
          discountType,
          actorId,
          options,
          session,
        ),
      `checkout order ${orderId}`,
      this.logger,
    );

    if (!savedOrder) {
      throw new BadRequestException('Checkout failed');
    }

    this.chatGateway.sendOrderEvent(tenantId, 'orderCompleted', savedOrder);
    return savedOrder;
  }

  private async checkoutOrderWithinSession(
    tenantId: string,
    orderId: string,
    discount: number,
    discountType: string,
    actorId: string | undefined,
    options: {
      skipCashMovement?: boolean;
      paymentMethod?: PaymentMethod;
    },
    session: ClientSession,
  ): Promise<OrderDocument> {
    const order = await this.orderModel
      .findOne({
        _id: orderId,
        tenantId: new Types.ObjectId(tenantId),
      })
      .session(session)
      .exec();

    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.COMPLETED) {
      throw new BadRequestException('Order already checked out');
    }
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('Cancelled order cannot be checked out');
    }

    const preparedItems = await this.validateOrderStockAvailability(
      tenantId,
      order.items,
      session,
    );
    const costedItems = await this.attachCostSnapshotsToItems(
      tenantId,
      preparedItems,
      session,
    );
    order.items = costedItems as any;

    const ingredientRequirements =
      this.buildIngredientRequirements(costedItems);
    if (ingredientRequirements.length === 0) {
      throw new BadRequestException('Order has no active items to process');
    }

    const bill = await this.calculateBillFromOrder(
      tenantId,
      order,
      discount,
      discountType,
      session,
    );

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
    const savedOrder = await order.save({ session });

    if (!options.skipCashMovement && actorId && this.cashierService) {
      const cashierShift = await this.cashierService.requireOpenShift(
        tenantId,
        session,
      );
      await this.cashierService.recordMovement({
        tenantId,
        shiftId: (cashierShift._id as Types.ObjectId).toString(),
        type: CashMovementType.MANUAL_CHECKOUT,
        amount: bill.finalAmount,
        paymentMethod: options.paymentMethod || PaymentMethod.CASH,
        sourceType: CashMovementSourceType.ORDER,
        sourceId: order._id.toString(),
        reason: 'Order checkout',
        createdBy: actorId,
        session,
      });
    }

    const table = await this.tableModel
      .findById(order.tableId)
      .session(session)
      .exec();
    if (table) {
      const otherOrders = await this.orderModel
        .countDocuments({
          tableId: table._id,
          tenantId: new Types.ObjectId(tenantId),
          _id: { $ne: order._id },
          status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
        })
        .session(session)
        .exec();

      if (otherOrders === 0) {
        table.status = TableStatus.EMPTY;
        await table.save({ session });
        await this.closeOpenTableSessions(
          new Types.ObjectId(tenantId),
          table._id as Types.ObjectId,
          session,
        );
      }
    }

    return savedOrder;
  }

  async closeCustomerSession(tenantId: string, sessionId: string) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const session = await this.tableSessionModel
      .findOne({ _id: sessionId, tenantId: tenantObjectId })
      .exec();
    
    if (!session) throw new NotFoundException('Session not found');

    const table = await this.tableModel
      .findOne({ _id: session.tableId, tenantId: tenantObjectId })
      .exec();

    session.status = TableSessionStatus.CLOSED;
    session.lastActivityAt = new Date();
    await session.save();

    if (table) {
      table.status = TableStatus.EMPTY;
      await table.save();
    }

    this.chatGateway.sendTableSyncEvent(tenantId);
    return { success: true };
  }

  async payBalanceTableSession(
    tenantId: string,
    sessionId: string,
    paidBy: string,
  ) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const sessionObjectId = this.toObjectId(sessionId, 'Invalid table session');
    
    const payload = await runTransactionSensitive(
      this.connection,
      async (session) => {
        const tableSession = await this.tableSessionModel
          .findOne({
            _id: sessionObjectId,
            tenantId: tenantObjectId,
            status: TableSessionStatus.OPEN,
          })
          .session(session)
          .exec();

        if (!tableSession) {
          throw new NotFoundException('Open table session not found');
        }

        const cashierShift = this.cashierService
          ? await this.cashierService.requireOpenShift(tenantId, session)
          : undefined;

        const orders = await this.orderModel
          .find({
            tenantId: tenantObjectId,
            sessionId: sessionObjectId,
            status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
          })
          .session(session)
          .exec();

        const billItems = orders.flatMap((order: any) =>
          order.items
            .filter((item: any) => item.status !== OrderItemStatus.CANCELLED && !item.isFree)
            .map((item: any) => ({ ...item }))
        );
        const subtotal = billItems.reduce((sum, item) => sum + item.subtotal, 0);
        const totalPaidAmount = tableSession.totalPaidAmount || 0;
        const finalAmount = Math.max(0, subtotal - totalPaidAmount);

        if (finalAmount <= 0) {
          throw new BadRequestException('Bàn này không còn nợ để thanh toán');
        }

        const paidAt = new Date();

        await this.tableSessionModel
          .updateOne(
            { _id: sessionObjectId, tenantId: tenantObjectId },
            {
              $set: {
                paymentStatus: TableSessionPaymentStatus.PAID,
                paymentMethod: TableSessionPaymentMethod.MANUAL,
                paidAt,
                paidBy: new Types.ObjectId(paidBy),
                lastActivityAt: new Date(),
              },
              $inc: {
                totalPaidAmount: finalAmount,
              },
            },
          )
          .session(session)
          .exec();

        await this.customerRequestModel
          .updateMany(
            {
              tenantId: tenantObjectId,
              sessionId: sessionObjectId,
              type: {
                $in: [CustomerRequestType.PAY_CASH, CustomerRequestType.PAY_TRANSFER, CustomerRequestType.PRINT_BILL],
              },
              status: {
                $in: [CustomerRequestStatus.PENDING, CustomerRequestStatus.ACKNOWLEDGED],
              },
            },
            { $set: { status: CustomerRequestStatus.DONE } },
          )
          .session(session)
          .exec();

        if (this.cashierService && cashierShift) {
          await this.cashierService.recordMovement({
            tenantId,
            shiftId: (cashierShift._id as Types.ObjectId).toString(),
            type: CashMovementType.MANUAL_CHECKOUT,
            amount: finalAmount,
            paymentMethod: PaymentMethod.CASH,
            sourceType: CashMovementSourceType.TABLE_SESSION,
            sourceId: sessionId,
            reason: 'Thanh toán tiếp phần dư',
            createdBy: paidBy,
            session,
          });
        }

        return {
          sessionId,
          paymentStatus: TableSessionPaymentStatus.PAID,
          paymentMethod: TableSessionPaymentMethod.MANUAL,
          totalAmount: finalAmount,
          paidAt,
        };
      },
      `pay balance table session ${sessionId}`,
      this.logger,
    );

    await this.auditLogService.log(
      tenantId,
      paidBy,
      'TABLE_SESSION_PAY_BALANCE',
      {
        sessionId,
        totalAmount: payload.totalAmount,
        paymentMethod: payload.paymentMethod,
        paidAt: payload.paidAt,
      },
    );

    this.chatGateway.sendOrderEvent(tenantId, 'manualCheckoutCompleted', {
      sessionId: payload.sessionId,
      paymentStatus: payload.paymentStatus,
      paymentMethod: payload.paymentMethod,
      paidAt: payload.paidAt,
    });
    this.chatGateway.sendTableSyncEvent(tenantId);

    return { success: true, payload };
  }

  async getStaffWorkspace(tenantId: string) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const sessions = await this.tableSessionModel
      .find({
        tenantId: tenantObjectId,
        status: TableSessionStatus.OPEN,
      })
      .sort({ lastActivityAt: -1, openedAt: -1 })
      .exec();

    if (sessions.length === 0) {
      return { sessions: [] };
    }

    const sessionIds = sessions.map((session) => session._id as Types.ObjectId);
    const tableIds = Array.from(
      new Set(sessions.map((session) => session.tableId.toString())),
    )
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const [tables, orders, requests] = await Promise.all([
      this.tableModel
        .find({ _id: { $in: tableIds }, tenantId: tenantObjectId })
        .exec(),
      this.orderModel
        .find({
          tenantId: tenantObjectId,
          sessionId: { $in: sessionIds },
          status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
        })
        .populate('items.itemId', 'name category imageUrl sellingPrice status')
        .sort({ createdAt: -1 })
        .exec(),
      this.customerRequestModel
        .find({
          tenantId: tenantObjectId,
          sessionId: { $in: sessionIds },
          status: {
            $in: [
              CustomerRequestStatus.PENDING,
              CustomerRequestStatus.ACKNOWLEDGED,
            ],
          },
        })
        .sort({ createdAt: -1 })
        .exec(),
    ]);

    const tableById = new Map(
      tables.map((table) => [table._id.toString(), table]),
    );
    const ordersBySession = new Map<string, any[]>();
    const requestsBySession = new Map<string, any[]>();

    orders.forEach((order) => {
      const key = order.sessionId?.toString?.() || '';
      if (!key) return;
      const existing = ordersBySession.get(key) || [];
      existing.push(order);
      ordersBySession.set(key, existing);
    });

    requests.forEach((request) => {
      const key = request.sessionId?.toString?.() || '';
      if (!key) return;
      const existing = requestsBySession.get(key) || [];
      existing.push(request);
      requestsBySession.set(key, existing);
    });

    return {
      sessions: sessions
        .map((tableSession) => {
          const sessionId = (tableSession._id as Types.ObjectId).toString();
          const table = tableById.get(tableSession.tableId.toString());
          const sessionOrders = ordersBySession.get(sessionId) || [];
          const sessionRequests = requestsBySession.get(sessionId) || [];
          const publicOrders = sessionOrders.map((order) =>
            this.toPublicSessionOrder(order),
          );
          const billItems = publicOrders.flatMap((order: any) =>
            order.items
              .filter(
                (item: any) =>
                  item.status !== OrderItemStatus.CANCELLED && !item.isFree,
              )
              .map((item: any) => ({
                ...item,
                orderId: order._id,
                orderCode: order._id.slice(-6).toUpperCase(),
              })),
          );
          const subtotal = billItems.reduce(
            (sum, item) => sum + item.subtotal,
            0,
          );
          const totalQuantity = billItems.reduce(
            (sum, item) => sum + item.quantity,
            0,
          );
          let totalPaidAmount = tableSession.totalPaidAmount || 0;
          if (tableSession.paymentStatus === TableSessionPaymentStatus.PAID && totalPaidAmount === 0) {
            totalPaidAmount = subtotal;
          }
          const finalAmount = Math.max(0, subtotal - totalPaidAmount);

          return {
            sessionId,
            table: {
              _id: tableSession.tableId.toString(),
              name:
                table?.name || tableSession.qrCodeTokenSnapshot || 'Mang di',
              status: table?.status,
            },
            customer: {
              name: tableSession.customerName || '',
              phone: tableSession.customerPhone || '',
            },
            paymentStatus:
              tableSession.paymentStatus || TableSessionPaymentStatus.UNPAID,
            paymentMethod: tableSession.paymentMethod,
            paidAt: tableSession.paidAt,
            openedAt: tableSession.openedAt,
            lastActivityAt: tableSession.lastActivityAt,
            orders: publicOrders,
            requests: sessionRequests.map((request) => ({
              _id: (request._id as Types.ObjectId).toString(),
              type: request.type,
              status: request.status,
              paymentMethod: request.paymentMethod,
              message: request.message,
              customerName: request.customerName,
              customerPhone: request.customerPhone,
              tableName: request.tableNameSnapshot || table?.name,
              createdAt: (request as any).createdAt,
              updatedAt: (request as any).updatedAt,
            })),
            bill: {
              orderCount: publicOrders.length,
              itemCount: billItems.length,
              totalQuantity,
              subtotal,
              finalAmount,
              totalPaidAmount,
              items: billItems,
            },
          };
        })
        .filter(
          (session) => session.orders.length > 0 || session.requests.length > 0,
        ),
    };
  }

  async getKitchenQueue(tenantId: string) {
    const orders = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.IN_PROGRESS,
      })
      .populate('tableId', 'name status')
      .populate('items.itemId', 'name category imageUrl status')
      .sort({ confirmedAt: 1, createdAt: 1 })
      .exec();

    const queue: any[] = [];
    orders.forEach((order: any) => {
      const tableName =
        typeof order.tableId === 'object' && order.tableId?.name
          ? order.tableId.name
          : 'Mang di';
      const tableId =
        typeof order.tableId === 'object' && order.tableId?._id
          ? order.tableId._id.toString()
          : order.tableId?.toString?.();

      (order.items || []).forEach((item: any) => {
        if (
          ![OrderItemStatus.PREPARING, OrderItemStatus.READY].includes(
            item.status,
          )
        )
          return;
        const itemRef = item.itemId;
        queue.push({
          orderId: order._id.toString(),
          orderCode: order._id.toString().slice(-6).toUpperCase(),
          orderItemId: item._id?.toString() || this.getOrderItemMenuId(item),
          tableId,
          tableName,
          sessionId: order.sessionId?.toString?.(),
          itemId: this.getOrderItemMenuId(item),
          name:
            itemRef && typeof itemRef === 'object' && itemRef.name
              ? itemRef.name
              : this.getOrderItemName(item),
          quantity: Number(item.quantity || 0),
          note: item.note,
          status: item.status,
          createdAt: order.createdAt,
          confirmedAt: order.confirmedAt,
        });
      });
    });

    return { items: queue };
  }

  async updateCustomerRequestStatus(
    tenantId: string,
    requestId: string,
    status: string,
  ) {
    if (!Types.ObjectId.isValid(requestId)) {
      throw new BadRequestException('Invalid customer request');
    }
    if (
      ![
        CustomerRequestStatus.ACKNOWLEDGED,
        CustomerRequestStatus.DONE,
        CustomerRequestStatus.CANCELLED,
      ].includes(status as CustomerRequestStatus)
    ) {
      throw new BadRequestException('Invalid customer request status');
    }

    const request = await this.customerRequestModel
      .findOne({
        _id: new Types.ObjectId(requestId),
        tenantId: new Types.ObjectId(tenantId),
      })
      .exec();

    if (!request) {
      throw new NotFoundException('Customer request not found');
    }

    request.status = status as CustomerRequestStatus;
    const savedRequest = await request.save();
    const payload = {
      _id: savedRequest._id.toString(),
      type: savedRequest.type,
      status: savedRequest.status,
      tableId: savedRequest.tableId.toString(),
      sessionId: savedRequest.sessionId.toString(),
      tableName: savedRequest.tableNameSnapshot,
      updatedAt: (savedRequest as any).updatedAt,
    };

    this.chatGateway.sendOrderEvent(
      tenantId,
      'customerRequestUpdated',
      payload,
    );
    return payload;
  }

  async manualCheckoutTableSession(
    tenantId: string,
    sessionId: string,
    paidBy: string,
    discount = 0,
    discountType: string = 'FLAT',
  ) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const sessionObjectId = this.toObjectId(sessionId, 'Invalid table session');
    const completedOrders: OrderDocument[] = [];
    const payload = await runTransactionSensitive(
      this.connection,
      async (session) => {
        const tableSession = await this.tableSessionModel
          .findOne({
            _id: sessionObjectId,
            tenantId: tenantObjectId,
            status: TableSessionStatus.OPEN,
          })
          .session(session)
          .exec();

        if (!tableSession) {
          throw new NotFoundException('Open table session not found');
        }

        const cashierShift = this.cashierService
          ? await this.cashierService.requireOpenShift(tenantId, session)
          : undefined;

        const orders = await this.orderModel
          .find({
            tenantId: tenantObjectId,
            sessionId: sessionObjectId,
            status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
          })
          .sort({ createdAt: 1 })
          .session(session)
          .exec();

        if (orders.length === 0) {
          throw new BadRequestException('Table session has no active orders');
        }

        const pendingOrder = orders.find(
          (order) => order.status === OrderStatus.PENDING,
        );
        if (pendingOrder) {
          throw new BadRequestException(
            'Confirm pending orders before checkout',
          );
        }

        let totalAmount = 0;
        for (const order of orders) {
          const completed = await this.checkoutOrderWithinSession(
            tenantId,
            order._id.toString(),
            discount,
            discountType,
            paidBy,
            { skipCashMovement: true },
            session,
          );
          completedOrders.push(completed);
          totalAmount += Number((completed as any).finalAmount || 0);
        }

        const paymentAlreadyReceived =
          tableSession.paymentStatus === TableSessionPaymentStatus.PAID &&
          tableSession.paymentMethod === TableSessionPaymentMethod.TRANSFER;
        const paymentMethod = paymentAlreadyReceived
          ? TableSessionPaymentMethod.TRANSFER
          : TableSessionPaymentMethod.MANUAL;
        const paidAt =
          paymentAlreadyReceived && tableSession.paidAt
            ? tableSession.paidAt
            : new Date();

        await this.tableSessionModel
          .updateOne(
            { _id: sessionObjectId, tenantId: tenantObjectId },
            {
              $set: {
                paymentStatus: TableSessionPaymentStatus.PAID,
                paymentMethod,
                paidAt,
                paidBy: new Types.ObjectId(paidBy),
                lastActivityAt: new Date(),
              },
            },
          )
          .session(session)
          .exec();

        await this.customerRequestModel
          .updateMany(
            {
              tenantId: tenantObjectId,
              sessionId: sessionObjectId,
              type: {
                $in: [
                  CustomerRequestType.PAY_CASH,
                  CustomerRequestType.PAY_TRANSFER,
                  CustomerRequestType.PRINT_BILL,
                ],
              },
              status: {
                $in: [
                  CustomerRequestStatus.PENDING,
                  CustomerRequestStatus.ACKNOWLEDGED,
                ],
              },
            },
            { $set: { status: CustomerRequestStatus.DONE } },
          )
          .session(session)
          .exec();

        if (this.cashierService && cashierShift) {
          await this.cashierService.recordMovement({
            tenantId,
            shiftId: (cashierShift._id as Types.ObjectId).toString(),
            type: CashMovementType.MANUAL_CHECKOUT,
            amount: totalAmount,
            paymentMethod: paymentAlreadyReceived
              ? PaymentMethod.PAYOS
              : PaymentMethod.CASH,
            sourceType: CashMovementSourceType.TABLE_SESSION,
            sourceId: sessionId,
            reason: 'Table session manual checkout',
            createdBy: paidBy,
            session,
          });
        }

        return {
          sessionId,
          paymentStatus: TableSessionPaymentStatus.PAID,
          paymentMethod,
          orderIds: completedOrders.map((order: any) => order._id.toString()),
          totalAmount,
          paidAt,
          paymentAlreadyReceived,
        };
      },
      `manual checkout table session ${sessionId}`,
      this.logger,
    );

    await this.auditLogService.log(
      tenantId,
      paidBy,
      'TABLE_SESSION_MANUAL_CHECKOUT',
      {
        sessionId,
        orderIds: payload.orderIds,
        totalAmount: payload.totalAmount,
        paymentMethod: payload.paymentMethod,
        paidAt: payload.paidAt,
        discount,
        discountType,
        paymentAlreadyReceived: payload.paymentAlreadyReceived,
      },
    );
    completedOrders.forEach((order) => {
      this.chatGateway.sendOrderEvent(tenantId, 'orderCompleted', order);
    });
    this.chatGateway.sendOrderEvent(tenantId, 'manualCheckoutCompleted', {
      sessionId: payload.sessionId,
      paymentStatus: payload.paymentStatus,
      paymentMethod: payload.paymentMethod,
      orderIds: payload.orderIds,
      totalAmount: payload.totalAmount,
      paidAt: payload.paidAt,
    });
    return {
      sessionId: payload.sessionId,
      paymentStatus: payload.paymentStatus,
      paymentMethod: payload.paymentMethod,
      orderIds: payload.orderIds,
      totalAmount: payload.totalAmount,
      paidAt: payload.paidAt,
    };
  }

  async findAllActive(tenantId: string): Promise<Order[]> {
    return this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
      })
      .populate('tableId')
      .populate('items.itemId', 'name category imageUrl sellingPrice status')
      .exec();
  }

  async findOrders(
    tenantId: string,
    filters: {
      startDate?: string;
      endDate?: string;
      tableId?: string;
      status?: string;
      customerPhone?: string;
      createdBy?: string;
    },
  ): Promise<Order[]> {
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
      query['customer.phone'] = {
        $regex: filters.customerPhone,
        $options: 'i',
      };
    }

    if (filters.createdBy) {
      query.createdBy = new Types.ObjectId(filters.createdBy);
    }

    return this.orderModel
      .find(query)
      .populate('tableId')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOrderById(tenantId: string, orderId: string): Promise<Order> {
    const order = await this.orderModel
      .findOne({
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
    return this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        tableId: new Types.ObjectId(tableId),
        status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
      })
      .populate('items.itemId', 'name category imageUrl sellingPrice status')
      .sort({ createdAt: -1 })
      .exec();
  }

  async getTableBill(tenantId: string, tableId: string): Promise<any> {
    const tenantObjectId = this.toPublicTenantObjectId(
      tenantId,
      'Table bill not found',
    );
    await this.assertTenantAcceptsPublicOrders(tenantObjectId);

    const orders = await this.orderModel
      .find({
        tenantId: tenantObjectId,
        tableId: new Types.ObjectId(tableId),
        status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
      })
      .populate('items.itemId', 'name category imageUrl sellingPrice status')
      .exec();

    const allItems = orders.flatMap((o: any) =>
      o.items
        .filter((i: any) => i.status !== OrderItemStatus.CANCELLED && !i.isFree)
        .map((i: any) => ({
          itemId: this.getOrderItemMenuId(i),
          orderItemId: i._id?.toString(),
          name: this.getOrderItemName(i),
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

  private toObjectId(
    value: string | Types.ObjectId | undefined,
    message: string,
  ): Types.ObjectId {
    if (value instanceof Types.ObjectId) return value;
    if (!value || !Types.ObjectId.isValid(value)) {
      throw new BadRequestException(message);
    }
    return new Types.ObjectId(value);
  }

  private async buildTableSessionSummary(
    tenantObjectId: Types.ObjectId,
    sessionObjectId: Types.ObjectId,
  ) {
    const tableSession = await this.tableSessionModel
      .findOne({
        _id: sessionObjectId,
        tenantId: tenantObjectId,
      })
      .exec();

    if (!tableSession) {
      throw new NotFoundException('Table session not found');
    }

    const table = await this.tableModel
      .findOne({
        _id: tableSession.tableId,
        tenantId: tenantObjectId,
      })
      .exec();

    if (!table) {
      throw new NotFoundException('Table not found');
    }

    const orders = await this.orderModel
      .find({
        tenantId: tenantObjectId,
        sessionId: sessionObjectId,
        status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
      })
      .populate('items.itemId', 'name category imageUrl sellingPrice status')
      .sort({ createdAt: -1 })
      .exec();

    const publicOrders = orders.map((order) =>
      this.toPublicSessionOrder(order),
    );
    const billItems = publicOrders.flatMap((order: any) =>
      order.items
        .filter(
          (item: any) =>
            item.status !== OrderItemStatus.CANCELLED && !item.isFree,
        )
        .map((item: any) => ({
          ...item,
          orderId: order._id,
          orderCode: order._id.slice(-6).toUpperCase(),
        })),
    );
    const subtotal = billItems.reduce((sum, item) => sum + item.subtotal, 0);
    const totalQuantity = billItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );
    let totalPaidAmount = tableSession.totalPaidAmount || 0;
    if (tableSession.paymentStatus === TableSessionPaymentStatus.PAID && totalPaidAmount === 0) {
      totalPaidAmount = subtotal;
    }
    const finalAmount = Math.max(0, subtotal - totalPaidAmount);

    return {
      table: {
        _id: (table._id as Types.ObjectId).toString(),
        name: table.name,
        status: table.status,
      },
      session: {
        _id: (tableSession._id as Types.ObjectId).toString(),
        status: tableSession.status,
        paymentStatus:
          tableSession.paymentStatus || TableSessionPaymentStatus.UNPAID,
        paymentMethod: tableSession.paymentMethod,
        paidAt: tableSession.paidAt,
        openedAt: tableSession.openedAt,
        lastActivityAt: tableSession.lastActivityAt,
        totalPaidAmount,
      },
      customer: {
        name: tableSession.customerName || '',
        phone: tableSession.customerPhone || '',
      },
      orders: publicOrders,
      bill: {
        orderCount: publicOrders.length,
        itemCount: billItems.length,
        totalQuantity,
        subtotal,
        finalAmount,
        totalPaidAmount,
        items: billItems,
      },
    };
  }

  private toPublicSessionOrder(order: any) {
    const items = (order.items || []).map((item: any) => {
      const quantity = Number(item.quantity || 0);
      const price = Number(item.price || 0);
      const isFree = Boolean(item.isFree);

      return {
        _id: item._id?.toString() || this.getOrderItemMenuId(item),
        itemId: this.getOrderItemMenuId(item),
        name: this.getOrderItemName(item),
        category: this.getOrderItemCategory(item),
        quantity,
        price,
        note: item.note,
        status: item.status,
        isFree,
        subtotal:
          isFree || item.status === OrderItemStatus.CANCELLED
            ? 0
            : quantity * price,
      };
    });

    return {
      _id: order._id.toString(),
      status: order.status,
      totalAmount: order.totalAmount,
      finalAmount: order.finalAmount,
      customer: order.customer,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      items,
    };
  }

  private getOrderItemMenuId(item: any): string {
    const itemRef = item?.itemId;
    if (itemRef && typeof itemRef === 'object' && itemRef._id) {
      return itemRef._id.toString();
    }
    return itemRef?.toString?.() || '';
  }

  private getOrderItemName(item: any): string {
    const itemRef = item?.itemId;
    if (itemRef && typeof itemRef === 'object' && itemRef.name) {
      return itemRef.name;
    }
    return item?.menuItemNameSnapshot || 'Mon';
  }

  private getOrderItemCategory(item: any): string | undefined {
    const itemRef = item?.itemId;
    if (itemRef && typeof itemRef === 'object' && itemRef.category) {
      return itemRef.category;
    }
    return undefined;
  }

  private getRequestPaymentMethod(
    type: CustomerRequestType,
    requestedMethod?: CustomerPaymentMethod,
  ): CustomerPaymentMethod | undefined {
    if (
      requestedMethod &&
      Object.values(CustomerPaymentMethod).includes(requestedMethod)
    ) {
      return requestedMethod;
    }
    if (type === CustomerRequestType.PAY_CASH)
      return CustomerPaymentMethod.CASH;
    if (
      type === CustomerRequestType.PAY_TRANSFER ||
      type === CustomerRequestType.PRINT_BILL
    ) {
      return CustomerPaymentMethod.TRANSFER;
    }
    return undefined;
  }

  private async ensurePayosPaymentForSession(
    tenantObjectId: Types.ObjectId,
    tableSession: TableSessionDocument,
    summary: any,
  ) {
    const amount = Number(
      summary?.bill?.finalAmount || summary?.bill?.subtotal || 0,
    );
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('No active bill to pay');
    }

    const existingPayment = await this.customerPaymentModel
      .findOne({
        tenantId: tenantObjectId,
        sessionId: tableSession._id,
        provider: CustomerPaymentProvider.PAYOS,
        status: {
          $in: [CustomerPaymentStatus.PENDING, CustomerPaymentStatus.PAID],
        },
        amount,
      })
      .sort({ createdAt: -1 })
      .exec();

    if (existingPayment) {
      return this.toPublicPaymentResponse(existingPayment);
    }

    this.assertPayosConfigured();

    const orderCode = await this.generateUniquePayosOrderCode();
    const description = this.buildPayosDescription(
      (tableSession._id as Types.ObjectId).toString(),
    );
    const payment = new this.customerPaymentModel({
      tenantId: tenantObjectId,
      tableId: tableSession.tableId,
      sessionId: tableSession._id,
      provider: CustomerPaymentProvider.PAYOS,
      status: CustomerPaymentStatus.PENDING,
      orderCode,
      amount,
      description,
      customerName: summary.customer?.name,
      customerPhone: summary.customer?.phone,
      tableNameSnapshot: summary.table?.name,
      billSnapshot: summary.bill,
    });

    const savedPayment = await payment.save();

    try {
      const providerResponse = await this.createPayosPaymentRequest({
        orderCode,
        amount,
        description,
      });
      savedPayment.providerResponse = providerResponse;
      savedPayment.providerPaymentLinkId = this.getOptionalString(
        providerResponse.paymentLinkId,
      );
      savedPayment.checkoutUrl = this.getOptionalString(
        providerResponse.checkoutUrl,
      );
      savedPayment.qrCode = this.getOptionalString(providerResponse.qrCode);

      const providerStatus = this.getOptionalString(
        providerResponse.status,
      )?.toUpperCase();
      if (providerStatus === CustomerPaymentStatus.PAID) {
        savedPayment.status = CustomerPaymentStatus.PAID;
        savedPayment.paidAt = new Date();
      }

      const updatedPayment = await savedPayment.save();
      return this.toPublicPaymentResponse(updatedPayment);
    } catch (error) {
      savedPayment.status = CustomerPaymentStatus.FAILED;
      await savedPayment.save();
      throw error;
    }
  }

  private assertPayosConfigured() {
    if (
      !process.env.PAYOS_CLIENT_ID ||
      !process.env.PAYOS_API_KEY ||
      !process.env.PAYOS_CHECKSUM_KEY
    ) {
      throw new BadRequestException('payOS is not configured');
    }
  }

  private async generateUniquePayosOrderCode(): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const orderCode = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      const exists = await this.customerPaymentModel
        .exists({ orderCode })
        .exec();
      if (!exists) return orderCode;
    }
    throw new BadRequestException('Unable to generate payment order code');
  }

  private buildPayosDescription(sessionId: string): string {
    return `TraSua ${sessionId.slice(-8)}`;
  }

  private async createPayosPaymentRequest(payload: {
    orderCode: number;
    amount: number;
    description: string;
  }): Promise<Record<string, unknown>> {
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY || '';
    const requestBody: Record<string, unknown> = {
      orderCode: payload.orderCode,
      amount: payload.amount,
      description: payload.description,
      returnUrl:
        process.env.PAYOS_RETURN_URL || 'https://web-khach-ts.vercel.app/home',
      cancelUrl:
        process.env.PAYOS_CANCEL_URL || 'https://web-khach-ts.vercel.app/home',
    };
    requestBody.signature = this.createPayosSignature(requestBody, checksumKey);

    const response = await fetch(
      'https://api-merchant.payos.vn/v2/payment-requests',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': process.env.PAYOS_CLIENT_ID || '',
          'x-api-key': process.env.PAYOS_API_KEY || '',
        },
        body: JSON.stringify(requestBody),
      },
    );

    const responseBody = await response.json().catch(() => ({}));
    const responseRecord = this.asRecord(responseBody);
    const responseCode = this.getOptionalString(responseRecord.code);

    if (!response.ok || (responseCode && responseCode !== '00')) {
      const message =
        this.getOptionalString(responseRecord.desc) ||
        this.getOptionalString(responseRecord.message) ||
        'Unable to create payOS payment';
      throw new BadRequestException(message);
    }

    return this.asRecord(responseRecord.data);
  }

  private createPayosSignature(
    data: Record<string, unknown>,
    checksumKey: string,
  ): string {
    const rawData = Object.keys(data)
      .filter(
        (key) =>
          key !== 'signature' && data[key] !== undefined && data[key] !== null,
      )
      .sort()
      .map((key) => `${key}=${this.stringifyPayosValue(data[key])}`)
      .join('&');

    return createHmac('sha256', checksumKey).update(rawData).digest('hex');
  }

  private stringifyPayosValue(value: unknown): string {
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    }
    return String(value);
  }

  private toPublicPaymentResponse(payment: CustomerPaymentDocument | any) {
    return {
      paymentId: payment._id.toString(),
      provider: payment.provider,
      status: payment.status,
      orderCode: payment.orderCode,
      amount: payment.amount,
      description: payment.description,
      checkoutUrl: payment.checkoutUrl,
      qrCode: payment.qrCode,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private getOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private async buildOrderItems(
    tenantId: string,
    itemDtos: any[],
  ): Promise<PreparedOrderItem[]> {
    const normalizedItems = this.normalizeIncomingOrderItems(itemDtos);
    const preparedItems = await this.convertToPreparedOrderItems(
      tenantId,
      normalizedItems,
    );
    await this.validateOrderStockAvailability(tenantId, preparedItems);
    return preparedItems;
  }

  private normalizeIncomingOrderItems(
    itemDtos: any[],
  ): NormalizedOrderInputItem[] {
    if (!Array.isArray(itemDtos) || itemDtos.length === 0) {
      throw new BadRequestException('Order must contain at least one item');
    }

    return itemDtos.map((itemDto) => {
      const requestedId = String(
        itemDto?.menuItemId || itemDto?.itemId || '',
      ).trim();
      const quantity = Number(itemDto?.quantity);

      if (!requestedId) {
        throw new BadRequestException('Menu item id is required');
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException(
          `Invalid quantity for item ${requestedId}`,
        );
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
    const requestedIds = Array.from(
      new Set(normalizedItems.map((item) => item.requestedId)),
    );
    const menuByRequestedId = await this.resolveMenuByRequestedIds(
      tenantId,
      requestedIds,
    );
    const recipeByMenuId = await this.getActiveRecipeByMenuIds(
      tenantId,
      Array.from(
        new Set(
          Array.from(menuByRequestedId.values()).map((menuItem) =>
            menuItem._id.toString(),
          ),
        ),
      ),
    );

    return normalizedItems.map((item, index) => {
      const menuItem = menuByRequestedId.get(item.requestedId);
      if (!menuItem) {
        throw new NotFoundException(
          `Menu item ${item.requestedId} not found or unavailable`,
        );
      }

      const recipe = recipeByMenuId.get(menuItem._id.toString());
      if (
        !recipe ||
        !Array.isArray(recipe.ingredients) ||
        recipe.ingredients.length === 0
      ) {
        throw this.buildMissingRecipeException(
          menuItem._id.toString(),
          menuItem.name,
        );
      }

      const recipeSnapshot = this.buildRecipeSnapshot(
        recipe.ingredients,
        item.quantity,
      );
      if (recipeSnapshot.length === 0) {
        throw this.buildMissingRecipeException(
          menuItem._id.toString(),
          menuItem.name,
        );
      }

      const baseItem = baseItems?.[index];
      const basePrice = Number(baseItem?.price);

      return {
        itemId: menuItem._id as Types.ObjectId,
        legacyInventoryItemId: menuItem.legacyInventoryItemId as
          | Types.ObjectId
          | undefined,
        menuItemNameSnapshot: menuItem.name,
        quantity: item.quantity,
        price:
          Number.isFinite(basePrice) && basePrice >= 0
            ? basePrice
            : menuItem.sellingPrice,
        note: item.note,
        status:
          (baseItem?.status as OrderItemStatus) || OrderItemStatus.PENDING,
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
      ? await this.menuItemModel
          .find({
            tenantId: tenantObjectId,
            _id: { $in: validRequestedObjectIds },
            status: MenuItemStatus.ACTIVE,
          })
          .exec()
      : [];

    directMenuItems.forEach((menuItem) => {
      result.set(menuItem._id.toString(), menuItem);
    });

    const unresolvedAfterDirect = requestedIds.filter((id) => !result.has(id));
    const unresolvedObjectIds = unresolvedAfterDirect
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const legacyMappedMenuItems = unresolvedObjectIds.length
      ? await this.menuItemModel
          .find({
            tenantId: tenantObjectId,
            legacyInventoryItemId: { $in: unresolvedObjectIds },
            status: MenuItemStatus.ACTIVE,
          })
          .exec()
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
        const linkedLegacyMenuItems = await this.menuItemModel
          .find({
            tenantId: tenantObjectId,
            legacyInventoryItemId: { $in: unresolvedObjectIdsForInventory },
          })
          .select({ legacyInventoryItemId: 1 })
          .exec();

        const alreadyLinkedInventoryIdSet = new Set(
          linkedLegacyMenuItems
            .map((row) => row.legacyInventoryItemId?.toString())
            .filter((value): value is string => Boolean(value)),
        );

        const inventoryItems = await this.itemModel
          .find({
            tenantId: tenantObjectId,
            _id: { $in: unresolvedObjectIdsForInventory },
            status: ItemStatus.ACTIVE,
          })
          .exec();

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

  private async getActiveRecipeByMenuIds(
    tenantId: string,
    menuIds: string[],
  ): Promise<Map<string, MenuItemRecipeDocument>> {
    if (menuIds.length === 0) return new Map<string, MenuItemRecipeDocument>();
    const recipes = await this.menuRecipeModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        menuItemId: {
          $in: menuIds
            .filter((id) => Types.ObjectId.isValid(id))
            .map((id) => new Types.ObjectId(id)),
        },
        status: MenuRecipeStatus.ACTIVE,
      })
      .exec();

    const map = new Map<string, MenuItemRecipeDocument>();
    recipes.forEach((recipe) => map.set(recipe.menuItemId.toString(), recipe));
    return map;
  }

  private buildRecipeSnapshot(
    ingredients: MenuRecipeIngredient[],
    quantity: number,
  ): PreparedOrderItem['recipeSnapshot'] {
    return ingredients.map((ingredient) => {
      const wastePercent = Number(ingredient.wastePercent) || 0;
      const wasteMultiplier = 1 + wastePercent / 100;
      const totalRequiredQuantity = Number(
        (ingredient.requiredQuantity * quantity * wasteMultiplier).toFixed(4),
      );
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
      .every(
        (item) =>
          Array.isArray(item.recipeSnapshot) &&
          item.recipeSnapshot.length > 0 &&
          item.menuItemNameSnapshot,
      );

    let preparedItems: PreparedOrderItem[];

    if (hasRecipeSnapshotForAllActiveItems) {
      preparedItems = items as PreparedOrderItem[];
    } else {
      const activeBaseItems = items.filter(
        (item) => item.status !== OrderItemStatus.CANCELLED,
      );
      const normalizedItems = activeBaseItems.map((item) => ({
        requestedId: String(
          (item as any).itemId?._id || (item as any).itemId || '',
        ).trim(),
        quantity: Number(item.quantity),
        note: item.note,
      }));
      const preparedActiveItems = await this.convertToPreparedOrderItems(
        tenantId,
        normalizedItems,
        activeBaseItems,
      );
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

  private buildIngredientRequirements(
    items: PreparedOrderItem[],
  ): IngredientRequirement[] {
    const requirementMap = new Map<string, IngredientRequirement>();

    items.forEach((item) => {
      if (item.status === OrderItemStatus.CANCELLED) return;
      const menuItemId = item.itemId.toString();
      const menuItemName = item.menuItemNameSnapshot || menuItemId;

      (item.recipeSnapshot || []).forEach((ingredient) => {
        if (ingredient.isOptional) return;

        const inventoryItemId = ingredient.inventoryItemId.toString();
        const requestedQuantity = Number(ingredient.totalRequiredQuantity);
        if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0)
          return;

        const existing = requirementMap.get(inventoryItemId);
        if (existing) {
          existing.totalRequestedQuantity = Number(
            (existing.totalRequestedQuantity + requestedQuantity).toFixed(4),
          );
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

  private async attachCostSnapshotsToItems(
    tenantId: string,
    items: PreparedOrderItem[],
    session?: ClientSession,
  ): Promise<PreparedOrderItem[]> {
    const ingredientIds = Array.from(
      new Set(
        items.flatMap((item) =>
          (item.recipeSnapshot || [])
            .filter((ingredient) => !ingredient.isOptional)
            .map((ingredient) => ingredient.inventoryItemId.toString()),
        ),
      ),
    )
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const inventoryItems = ingredientIds.length
      ? await this.itemModel
          .find({
            tenantId: new Types.ObjectId(tenantId),
            _id: { $in: ingredientIds },
          })
          .session(session || null)
          .exec()
      : [];

    const inventoryById = new Map<string, InventoryItemDocument>();
    inventoryItems.forEach((inventoryItem) => {
      inventoryById.set(inventoryItem._id.toString(), inventoryItem);
    });

    return items.map((item) => {
      if (item.status === OrderItemStatus.CANCELLED) return item;

      let totalCost = 0;
      const ingredients = (item.recipeSnapshot || [])
        .filter((ingredient) => !ingredient.isOptional)
        .map((ingredient) => {
          const inventoryItem = inventoryById.get(
            ingredient.inventoryItemId.toString(),
          );
          const requiredQuantity = Number(ingredient.totalRequiredQuantity);
          const costPriceSnapshot = Math.round(
            Number(inventoryItem?.costPrice || 0),
          );
          const costAmount = Math.round(requiredQuantity * costPriceSnapshot);
          totalCost += costAmount;

          return {
            inventoryItemId: ingredient.inventoryItemId,
            nameSnapshot:
              ingredient.ingredientNameSnapshot ||
              inventoryItem?.name ||
              ingredient.inventoryItemId.toString(),
            requiredQuantity,
            unit: ingredient.unitSnapshot,
            costPriceSnapshot,
            costAmount,
          };
        });

      return {
        ...item,
        costSnapshot: {
          totalCost,
          ingredients,
          costEstimated: false,
          missingCost: ingredients.length === 0,
        },
      };
    });
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
      ? await this.itemModel
          .find({
            tenantId: new Types.ObjectId(tenantId),
            _id: { $in: ingredientObjectIds },
          })
          .session(session || null)
          .exec()
      : [];

    const inventoryById = new Map<string, InventoryItemDocument>();
    inventoryItems.forEach((inventoryItem) => {
      inventoryById.set(inventoryItem._id.toString(), inventoryItem);
    });

    const insufficientItems: any[] = [];
    requirements.forEach((requirement) => {
      const inventoryItem = inventoryById.get(requirement.inventoryItemId);
      const availableQuantity =
        inventoryItem?.status === ItemStatus.ACTIVE
          ? Number(inventoryItem.stock || 0)
          : 0;
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

  private buildMissingRecipeException(
    menuItemId: string,
    menuItemName: string,
  ) {
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

    const tenant = await this.tenantModel
      .findById(tenantId)
      .session(session || null)
      .exec();
    const vatRate = tenant?.settings?.vatRate || 0;
    const serviceChargeRate = tenant?.settings?.serviceCharge || 0;

    const subtotal = order.totalAmount;
    const discountAmount =
      discountType === 'PERCENT'
        ? Math.round(subtotal * (discount / 100))
        : discount;

    const amountAfterDiscount = Math.max(0, subtotal - discountAmount);
    const vatAmount = Math.round(amountAfterDiscount * (vatRate / 100));
    const serviceChargeAmount = Math.round(
      amountAfterDiscount * (serviceChargeRate / 100),
    );
    const finalAmount = amountAfterDiscount + vatAmount + serviceChargeAmount;

    return {
      discount: discountAmount,
      vatAmount,
      serviceChargeAmount,
      finalAmount,
    };
  }

  private calculateTotalAmount(items: any[]): number {
    return items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  }

  private isMongoTransactionUnsupportedError(error: unknown): boolean {
    const fallback = {
      message: '',
      codeName: '',
      code: undefined as number | undefined,
    };
    const details =
      typeof error === 'object' && error !== null
        ? {
            message: String((error as any).message || ''),
            codeName: String((error as any).codeName || ''),
            code:
              typeof (error as any).code === 'number'
                ? (error as any).code
                : undefined,
          }
        : fallback;

    const message = details.message.toLowerCase();
    return (
      details.code === 20 ||
      details.codeName.toLowerCase() === 'illegaloperation' ||
      message.includes(
        'transaction numbers are only allowed on a replica set member or mongos',
      ) ||
      (message.includes('replica set') && message.includes('transaction'))
    );
  }
}
