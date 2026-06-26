import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Types } from 'mongoose';
import { MenuItemStatus } from '../menu/schemas/menu-item.schema';
import {
  CustomerPaymentProvider,
  CustomerPaymentStatus,
} from './schemas/customer-payment.schema';
import { TableStatus } from '../tables/schemas/table.schema';
import {
  TenantStatus,
  SubscriptionStatus,
} from '../tenants/schemas/tenant.schema';
import { TableSessionStatus } from './schemas/table-session.schema';
import { OrdersService } from './orders.service';
import { OrderItemStatus } from './schemas/order.schema';

function execResult<T>(value: T) {
  return {
    exec: jest.fn().mockResolvedValue(value),
  };
}

function sortedExecResult<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

function signPayosData(
  data: Record<string, unknown>,
  checksumKey: string,
): string {
  const rawData = Object.keys(data)
    .filter(
      (key) =>
        key !== 'signature' && data[key] !== undefined && data[key] !== null,
    )
    .sort()
    .map(
      (key) =>
        `${key}=${typeof data[key] === 'object' ? JSON.stringify(data[key]) : String(data[key])}`,
    )
    .join('&');

  return createHmac('sha256', checksumKey).update(rawData).digest('hex');
}

describe('OrdersService public QR APIs', () => {
  let service: OrdersService;
  let tableModel: { findOne: jest.Mock };
  let itemModel: { find: jest.Mock };
  let tenantModel: { findById: jest.Mock };
  let tableSessionModel: jest.Mock & {
    findOne: jest.Mock;
    updateMany: jest.Mock;
  };
  let customerPaymentModel: { findOne: jest.Mock };
  let menuService: { findAllMenuItems: jest.Mock; getAvailability: jest.Mock };
  let chatGateway: { sendOrderEvent: jest.Mock };
  let auditLogService: { log: jest.Mock; logSystem: jest.Mock };

  beforeEach(() => {
    tableModel = {
      findOne: jest.fn(),
    };
    itemModel = {
      find: jest.fn(),
    };
    tenantModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({
          status: TenantStatus.ACTIVE,
          subscription: {
            status: SubscriptionStatus.ACTIVE,
            endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        }),
      }),
    };
    tableSessionModel = jest.fn().mockImplementation((payload) => {
      const doc = {
        _id: new Types.ObjectId(),
        ...payload,
        save: jest.fn(),
      };
      doc.save.mockResolvedValue(doc);
      return doc;
    }) as jest.Mock & { findOne: jest.Mock; updateMany: jest.Mock };
    tableSessionModel.findOne = jest.fn();
    tableSessionModel.updateMany = jest.fn();
    (tableSessionModel as any).updateOne = jest
      .fn()
      .mockReturnValue(execResult({ modifiedCount: 1 }));
    customerPaymentModel = {
      findOne: jest.fn(),
    };
    menuService = {
      findAllMenuItems: jest.fn(),
      getAvailability: jest.fn(),
    };
    chatGateway = {
      sendOrderEvent: jest.fn(),
    };
    auditLogService = {
      log: jest.fn().mockResolvedValue(undefined),
      logSystem: jest.fn().mockResolvedValue(undefined),
    };

    service = new OrdersService(
      {} as never,
      {} as never,
      tableModel as never,
      itemModel as never,
      tenantModel as never,
      {} as never,
      {} as never,
      tableSessionModel as never,
      {} as never,
      customerPaymentModel as never,
      {} as never,
      menuService as never,
      chatGateway as never,
      auditLogService as never,
    );
    process.env.PAYOS_CHECKSUM_KEY = 'checksum';
  });

  it('returns only customer-safe public menu fields', async () => {
    const tenantId = new Types.ObjectId().toString();
    const menuItemId = new Types.ObjectId();
    const legacyInventoryItemId = new Types.ObjectId();

    menuService.findAllMenuItems.mockResolvedValue([
      {
        _id: menuItemId,
        legacyInventoryItemId,
        name: 'Tra sua tran chau',
        category: 'DRINK',
        description: 'Best seller',
        sellingPrice: 35000,
        imageUrl: 'https://example.test/milk-tea.jpg',
        status: MenuItemStatus.ACTIVE,
      },
    ]);
    menuService.getAvailability.mockResolvedValue([
      {
        menuItemId: menuItemId.toString(),
        name: 'Tra sua tran chau',
        quantity: 1,
        available: false,
        status: 'OUT_OF_STOCK',
        reason: 'INSUFFICIENT_INGREDIENTS',
        issues: [
          {
            inventoryItemId: new Types.ObjectId().toString(),
            name: 'Tran chau',
            unit: 'g',
            requestedQuantity: 50,
            availableQuantity: 0,
            reason: 'INSUFFICIENT_STOCK',
          },
        ],
      },
    ]);

    const result = await service.getPublicMenu(tenantId);

    expect(result).toEqual([
      {
        _id: menuItemId.toString(),
        menuItemId: menuItemId.toString(),
        name: 'Tra sua tran chau',
        category: 'DRINK',
        description: 'Best seller',
        sellingPrice: 35000,
        imageUrl: 'https://example.test/milk-tea.jpg',
        available: false,
        availabilityStatus: 'OUT_OF_STOCK',
        availabilityReason: 'INSUFFICIENT_INGREDIENTS',
      },
    ]);
    expect(result[0]).not.toHaveProperty('legacyInventoryItemId');
    expect(result[0]).not.toHaveProperty('availabilityIssues');
    expect(result[0]).not.toHaveProperty('stock');
    expect(result[0]).not.toHaveProperty('minStockLevel');
    expect(result[0]).not.toHaveProperty('unit');
  });

  it('rejects table info for hidden tables', async () => {
    const tenantId = new Types.ObjectId().toString();
    tableModel.findOne.mockReturnValue(
      execResult({
        _id: new Types.ObjectId(),
        name: 'Ban 1',
        status: TableStatus.EMPTY,
        isHidden: true,
      }),
    );

    await expect(
      service.getTableInfo(tenantId, 'public-token'),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates an open table session when public table info is requested', async () => {
    const tenantId = new Types.ObjectId().toString();
    const table = {
      _id: new Types.ObjectId(),
      name: 'Ban 1',
      status: TableStatus.EMPTY,
      isHidden: false,
      save: jest.fn().mockResolvedValue(undefined),
    };
    tableModel.findOne.mockReturnValue(execResult(table));
    tableSessionModel.findOne.mockReturnValue(sortedExecResult(null));

    const result = await service.getTableInfo(tenantId, 'public-token');

    expect(tableSessionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: table._id,
        status: TableSessionStatus.OPEN,
        qrCodeTokenSnapshot: 'public-token',
      }),
    );
    expect(table.status).toBe(TableStatus.SERVING);
    expect(table.save).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        name: 'Ban 1',
        status: TableStatus.SERVING,
        _id: table._id,
        sessionStatus: TableSessionStatus.OPEN,
      }),
    );
    expect(result.sessionId).toBeDefined();
  });

  it('returns customer payment status only for the matching tenant and session', async () => {
    const paymentId = new Types.ObjectId();
    const tenantId = new Types.ObjectId();
    const sessionId = new Types.ObjectId();
    customerPaymentModel.findOne.mockReturnValue(
      execResult({
        _id: paymentId,
        tenantId,
        sessionId,
        provider: 'PAYOS',
        status: 'PENDING',
        orderCode: 123,
        amount: 22000,
        description: 'TS 123',
        checkoutUrl: 'https://pay.test',
      }),
    );

    const result = await service.getCustomerPaymentStatus(
      paymentId.toString(),
      tenantId.toString(),
      sessionId.toString(),
    );

    expect(customerPaymentModel.findOne).toHaveBeenCalledWith({
      _id: paymentId,
      tenantId,
      sessionId,
    });
    expect(result).toMatchObject({
      paymentId: paymentId.toString(),
      status: 'PENDING',
      amount: 22000,
    });
  });

  it('handles paid customer payOS webhook idempotently', async () => {
    const paymentId = new Types.ObjectId();
    const tenantId = new Types.ObjectId();
    const sessionId = new Types.ObjectId();
    const tableId = new Types.ObjectId();
    const payment: any = {
      _id: paymentId,
      tenantId,
      sessionId,
      tableId,
      provider: CustomerPaymentProvider.PAYOS,
      status: CustomerPaymentStatus.PENDING,
      orderCode: 123456,
      amount: 22000,
      description: 'TraSua test',
      save: jest.fn().mockImplementation(async () => payment),
    };
    customerPaymentModel.findOne.mockReturnValue(execResult(payment));
    const data = { orderCode: payment.orderCode, code: '00' };
    const body = {
      data,
      success: true,
      signature: signPayosData(data, 'checksum'),
    };

    await service.handlePayosWebhook(body);
    await service.handlePayosWebhook(body);

    expect(payment.status).toBe(CustomerPaymentStatus.PAID);
    expect(payment.paidAt).toBeInstanceOf(Date);
    expect((tableSessionModel as any).updateOne).toHaveBeenCalledTimes(1);
    expect(chatGateway.sendOrderEvent).toHaveBeenCalledTimes(1);
    expect(auditLogService.logSystem).toHaveBeenCalledTimes(1);
  });

  it('does not cancel customer payment after it has been paid', async () => {
    const paidAt = new Date('2026-06-20T09:00:00.000Z');
    const payment: any = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(),
      sessionId: new Types.ObjectId(),
      tableId: new Types.ObjectId(),
      provider: CustomerPaymentProvider.PAYOS,
      status: CustomerPaymentStatus.PAID,
      orderCode: 123457,
      amount: 22000,
      description: 'TraSua test',
      paidAt,
      save: jest.fn().mockImplementation(async () => payment),
    };
    customerPaymentModel.findOne.mockReturnValue(execResult(payment));
    const data = {
      orderCode: payment.orderCode,
      cancel: true,
      status: 'CANCELLED',
    };
    const body = { data, signature: signPayosData(data, 'checksum') };

    await service.handlePayosWebhook(body);

    expect(payment.status).toBe(CustomerPaymentStatus.PAID);
    expect(payment.paidAt).toBe(paidAt);
    expect((tableSessionModel as any).updateOne).not.toHaveBeenCalled();
    expect(chatGateway.sendOrderEvent).not.toHaveBeenCalled();
  });

  it('allows paid customer webhook to recover a cancelled payment', async () => {
    const payment: any = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(),
      sessionId: new Types.ObjectId(),
      tableId: new Types.ObjectId(),
      provider: CustomerPaymentProvider.PAYOS,
      status: CustomerPaymentStatus.CANCELLED,
      orderCode: 123458,
      amount: 22000,
      description: 'TraSua test',
      save: jest.fn().mockImplementation(async () => payment),
    };
    customerPaymentModel.findOne.mockReturnValue(execResult(payment));
    const data = { orderCode: payment.orderCode, code: '00' };
    const body = {
      data,
      success: true,
      signature: signPayosData(data, 'checksum'),
    };

    await service.handlePayosWebhook(body);

    expect(payment.status).toBe(CustomerPaymentStatus.PAID);
    expect((tableSessionModel as any).updateOne).toHaveBeenCalledTimes(1);
    expect(chatGateway.sendOrderEvent).toHaveBeenCalledTimes(1);
  });

  it('snapshots item cost from current ingredient cost during checkout preparation', async () => {
    const tenantId = new Types.ObjectId().toString();
    const inventoryItemId = new Types.ObjectId();
    itemModel.find.mockReturnValue({
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        {
          _id: inventoryItemId,
          name: 'Sua tuoi',
          costPrice: 500,
        },
      ]),
    });

    const result = await (service as any).attachCostSnapshotsToItems(tenantId, [
      {
        itemId: new Types.ObjectId(),
        menuItemNameSnapshot: 'Tra sua',
        quantity: 1,
        price: 22000,
        status: OrderItemStatus.PREPARING,
        isFree: false,
        recipeSnapshot: [
          {
            inventoryItemId,
            ingredientNameSnapshot: 'Sua tuoi',
            requiredQuantityPerUnit: 3,
            totalRequiredQuantity: 3,
            unitSnapshot: 'ml',
          },
        ],
      },
    ]);

    expect(result[0].costSnapshot).toEqual({
      totalCost: 1500,
      costEstimated: false,
      missingCost: false,
      ingredients: [
        expect.objectContaining({
          inventoryItemId,
          nameSnapshot: 'Sua tuoi',
          requiredQuantity: 3,
          unit: 'ml',
          costPriceSnapshot: 500,
          costAmount: 1500,
        }),
      ],
    });
  });
});
