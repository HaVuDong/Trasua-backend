import { Types } from 'mongoose';
import { OrderItemStatus, OrderStatus } from '../orders/schemas/order.schema';
import { ReportsService } from './reports.service';

function execResult<T>(value: T) {
  return { exec: jest.fn().mockResolvedValue(value) };
}

function selectExecResult<T>(value: T) {
  return { select: jest.fn().mockReturnValue(execResult(value)) };
}

describe('ReportsService', () => {
  describe('getDashboard', () => {
    it('uses completedAt for today revenue and MenuItem names for top items', async () => {
      const tenantId = new Types.ObjectId().toString();
      const menuItemId = new Types.ObjectId();

      const todayCreatedOrders = [
        {
          status: OrderStatus.PENDING,
          items: [],
        },
      ];
      const completedToday = [
        {
          status: OrderStatus.COMPLETED,
          finalAmount: 400000,
          completedAt: new Date(),
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          items: [
            {
              itemId: menuItemId,
              menuItemNameSnapshot: 'Snapshot Name',
              status: OrderItemStatus.READY,
              quantity: 2,
              price: 200000,
              isFree: false,
            },
          ],
        },
      ];

      const orderModel = {
        find: jest
          .fn()
          .mockReturnValueOnce(execResult(todayCreatedOrders))
          .mockReturnValueOnce(execResult(completedToday))
          .mockReturnValueOnce(execResult([]))
          .mockReturnValueOnce(execResult(completedToday)),
        countDocuments: jest.fn().mockReturnValue(execResult(2)),
      };
      const itemModel = {
        find: jest.fn().mockReturnValue(selectExecResult([])),
      };
      const menuItemModel = {
        findById: jest
          .fn()
          .mockReturnValue(selectExecResult({ name: 'Tra Sua That' })),
      };

      const service = new ReportsService(
        orderModel as any,
        {} as any,
        {} as any,
        {} as any,
        itemModel as any,
        menuItemModel as any,
      );

      const result = await service.getDashboard(tenantId);

      expect(orderModel.find.mock.calls[0][0]).toHaveProperty('createdAt');
      expect(orderModel.find.mock.calls[1][0]).toHaveProperty('completedAt');
      expect(orderModel.find.mock.calls[1][0]).not.toHaveProperty('createdAt');
      expect(result.today.revenue).toBe(400000);
      expect(result.today.completedOrders).toBe(1);
      expect(result.today.pendingOrders).toBe(1);
      expect(result.today.activeOrders).toBe(2);
      expect(result.topItems).toEqual([
        {
          itemId: menuItemId.toString(),
          name: 'Tra Sua That',
          count: 2,
          revenue: 400000,
        },
      ]);
    });
  });

  describe('profit reports', () => {
    it('uses cost snapshots and marks old items with missing cost', async () => {
      const tenantId = new Types.ObjectId().toString();
      const menuItemId = new Types.ObjectId();
      const freeItemId = new Types.ObjectId();
      const oldItemId = new Types.ObjectId();
      const cancelledItemId = new Types.ObjectId();
      const completedAt = new Date('2026-06-20T10:00:00.000Z');
      const orders = [
        {
          status: OrderStatus.COMPLETED,
          completedAt,
          discount: 2000,
          items: [
            {
              itemId: menuItemId,
              menuItemNameSnapshot: 'Tra sua',
              status: OrderItemStatus.SERVED,
              quantity: 2,
              price: 20000,
              isFree: false,
              costSnapshot: { totalCost: 12000 },
            },
            {
              itemId: freeItemId,
              menuItemNameSnapshot: 'Topping tang',
              status: OrderItemStatus.SERVED,
              quantity: 1,
              price: 5000,
              isFree: true,
              costSnapshot: { totalCost: 1500 },
            },
            {
              itemId: oldItemId,
              menuItemNameSnapshot: 'Mon cu',
              status: OrderItemStatus.SERVED,
              quantity: 1,
              price: 10000,
              isFree: false,
            },
            {
              itemId: cancelledItemId,
              menuItemNameSnapshot: 'Mon huy',
              status: OrderItemStatus.CANCELLED,
              quantity: 1,
              price: 999999,
              isFree: false,
              costSnapshot: { totalCost: 999999 },
            },
          ],
        },
      ];

      const orderModel = {
        find: jest.fn().mockReturnValue(execResult(orders)),
      };
      const menuItemModel = {
        find: jest.fn().mockReturnValue(
          selectExecResult([
            { _id: menuItemId, name: 'Tra sua', category: 'DRINK' },
            { _id: freeItemId, name: 'Topping tang', category: 'TOPPING' },
            { _id: oldItemId, name: 'Mon cu', category: 'DRINK' },
          ]),
        ),
      };

      const service = new ReportsService(
        orderModel as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        menuItemModel as any,
      );

      const result = await service.getProfitReport(
        tenantId,
        new Date('2026-06-20T00:00:00.000Z'),
        new Date('2026-06-20T23:59:59.999Z'),
        'day',
      );

      expect(result.summary).toMatchObject({
        revenue: 50000,
        discount: 2000,
        netRevenue: 48000,
        cogs: 13500,
        grossProfit: 34500,
        missingCostCount: 1,
      });
      expect(result.groups[0]).toMatchObject({
        key: '2026-06-20',
        revenue: 50000,
        cogs: 13500,
      });
    });

    it('returns item margin sorted by gross profit', async () => {
      const tenantId = new Types.ObjectId().toString();
      const a = new Types.ObjectId();
      const b = new Types.ObjectId();
      const orders = [
        {
          status: OrderStatus.COMPLETED,
          completedAt: new Date('2026-06-20T10:00:00.000Z'),
          discount: 0,
          items: [
            {
              itemId: a,
              menuItemNameSnapshot: 'A',
              status: OrderItemStatus.SERVED,
              quantity: 1,
              price: 30000,
              costSnapshot: { totalCost: 10000 },
            },
            {
              itemId: b,
              menuItemNameSnapshot: 'B',
              status: OrderItemStatus.SERVED,
              quantity: 1,
              price: 20000,
              costSnapshot: { totalCost: 15000 },
            },
          ],
        },
      ];
      const orderModel = {
        find: jest.fn().mockReturnValue(execResult(orders)),
      };
      const menuItemModel = {
        find: jest.fn().mockReturnValue(
          selectExecResult([
            { _id: a, name: 'A', category: 'DRINK' },
            { _id: b, name: 'B', category: 'DRINK' },
          ]),
        ),
      };
      const service = new ReportsService(
        orderModel as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        menuItemModel as any,
      );

      const result = await service.getItemMarginReport(
        tenantId,
        new Date('2026-06-20T00:00:00.000Z'),
        new Date('2026-06-20T23:59:59.999Z'),
      );

      expect(result.items.map((item: any) => item.label)).toEqual(['A', 'B']);
      expect(result.items[0].grossProfit).toBe(20000);
    });
  });

  describe('getFinancialReport', () => {
    it('uses cost snapshots instead of current inventory cost', async () => {
      const tenantId = new Types.ObjectId().toString();
      const menuItemId = new Types.ObjectId();
      const oldItemId = new Types.ObjectId();
      const completedAt = new Date('2026-06-20T10:00:00.000Z');
      const orders = [
        {
          status: OrderStatus.COMPLETED,
          completedAt,
          finalAmount: 50000,
          vat: 0,
          serviceCharge: 0,
          discount: 0,
          items: [
            {
              itemId: menuItemId,
              status: OrderItemStatus.SERVED,
              quantity: 2,
              price: 25000,
              costSnapshot: { totalCost: 12000 },
            },
            {
              itemId: oldItemId,
              status: OrderItemStatus.SERVED,
              quantity: 1,
              price: 10000,
            },
          ],
        },
      ];
      const orderModel = {
        find: jest
          .fn()
          .mockReturnValueOnce(execResult(orders))
          .mockReturnValueOnce(execResult(orders)),
      };
      const payrollModel = {
        find: jest.fn().mockReturnValue(execResult([{ finalSalary: 10000 }])),
      };
      const itemModel = {
        findById: jest.fn(),
      };
      const service = new ReportsService(
        orderModel as any,
        {} as any,
        payrollModel as any,
        {} as any,
        itemModel as any,
        {} as any,
      );

      const result = await service.getFinancialReport(
        tenantId,
        new Date('2026-06-20T00:00:00.000Z'),
        new Date('2026-06-20T23:59:59.999Z'),
      );

      expect(itemModel.findById).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        revenue: 50000,
        materialCost: 12000,
        laborCost: 10000,
        grossProfit: 38000,
        netProfit: 28000,
        missingCostCount: 1,
      });
    });
  });
});
