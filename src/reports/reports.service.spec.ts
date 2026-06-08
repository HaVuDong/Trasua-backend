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
        find: jest.fn()
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
        findById: jest.fn().mockReturnValue(selectExecResult({ name: 'Tra Sua That' })),
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
});
