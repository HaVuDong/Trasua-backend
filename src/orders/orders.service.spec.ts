import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { MenuItemStatus } from '../menu/schemas/menu-item.schema';
import { TableStatus } from '../tables/schemas/table.schema';
import { TenantStatus, SubscriptionStatus } from '../tenants/schemas/tenant.schema';
import { TableSessionStatus } from './schemas/table-session.schema';
import { OrdersService } from './orders.service';

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

describe('OrdersService public QR APIs', () => {
  let service: OrdersService;
  let tableModel: { findOne: jest.Mock };
  let tenantModel: { findById: jest.Mock };
  let tableSessionModel: jest.Mock & { findOne: jest.Mock; updateMany: jest.Mock };
  let customerPaymentModel: { findOne: jest.Mock };
  let menuService: { findAllMenuItems: jest.Mock; getAvailability: jest.Mock };

  beforeEach(() => {
    tableModel = {
      findOne: jest.fn(),
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
    customerPaymentModel = {
      findOne: jest.fn(),
    };
    menuService = {
      findAllMenuItems: jest.fn(),
      getAvailability: jest.fn(),
    };

    service = new OrdersService(
      {} as never,
      {} as never,
      tableModel as never,
      {} as never,
      tenantModel as never,
      {} as never,
      {} as never,
      tableSessionModel as never,
      {} as never,
      customerPaymentModel as never,
      {} as never,
      menuService as never,
      {} as never,
    );
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
    tableModel.findOne.mockReturnValue(execResult({
      _id: new Types.ObjectId(),
      name: 'Ban 1',
      status: TableStatus.EMPTY,
      isHidden: true,
    }));

    await expect(service.getTableInfo(tenantId, 'public-token')).rejects.toThrow(BadRequestException);
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

    expect(tableSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      tableId: table._id,
      status: TableSessionStatus.OPEN,
      qrCodeTokenSnapshot: 'public-token',
    }));
    expect(table.status).toBe(TableStatus.SERVING);
    expect(table.save).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      name: 'Ban 1',
      status: TableStatus.SERVING,
      _id: table._id,
      sessionStatus: TableSessionStatus.OPEN,
    }));
    expect(result.sessionId).toBeDefined();
  });

  it('returns customer payment status only for the matching tenant and session', async () => {
    const paymentId = new Types.ObjectId();
    const tenantId = new Types.ObjectId();
    const sessionId = new Types.ObjectId();
    customerPaymentModel.findOne.mockReturnValue(execResult({
      _id: paymentId,
      tenantId,
      sessionId,
      provider: 'PAYOS',
      status: 'PENDING',
      orderCode: 123,
      amount: 22000,
      description: 'TS 123',
      checkoutUrl: 'https://pay.test',
    }));

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
});
