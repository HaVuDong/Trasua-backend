import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Order,
  OrderDocument,
  OrderStatus,
  OrderItemStatus,
} from '../orders/schemas/order.schema';
import {
  Attendance,
  AttendanceDocument,
} from '../attendance/schemas/attendance.schema';
import { Payroll, PayrollDocument } from '../attendance/schemas/payroll.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  InventoryItem,
  InventoryItemDocument,
  ItemStatus,
} from '../inventory/schemas/inventory.schema';
import { MenuItem, MenuItemDocument } from '../menu/schemas/menu-item.schema';

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Attendance.name)
    private attendanceModel: Model<AttendanceDocument>,
    @InjectModel(Payroll.name) private payrollModel: Model<PayrollDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(InventoryItem.name)
    private itemModel: Model<InventoryItemDocument>,
    @InjectModel(MenuItem.name) private menuItemModel: Model<MenuItemDocument>,
  ) {}

  async getDashboard(tenantId: string): Promise<any> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(todayEnd);
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    // Orders created today are used for operational counts.
    const todayOrders = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        createdAt: { $gte: todayStart, $lte: todayEnd },
      })
      .exec();

    // Completed orders today are revenue source-of-truth and must match revenue-by-hour.
    const completedToday = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: todayStart, $lte: todayEnd },
      })
      .exec();
    const todayRevenue = completedToday.reduce(
      (sum, o) => sum + (o.finalAmount || 0),
      0,
    );

    // Yesterday revenue for comparison
    const yesterdayOrders = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: yesterdayStart, $lte: yesterdayEnd },
      })
      .exec();
    const yesterdayRevenue = yesterdayOrders.reduce(
      (sum, o) => sum + (o.finalAmount || 0),
      0,
    );

    // Last 7 days average
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const weekOrders = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: sevenDaysAgo, $lte: todayEnd },
      })
      .exec();
    const weekRevenue = weekOrders.reduce(
      (sum, o) => sum + (o.finalAmount || 0),
      0,
    );
    const avgDailyRevenue = Math.round(weekRevenue / 7);

    // Top 5 items today
    const itemCountMap = new Map<
      string,
      { name: string; count: number; revenue: number }
    >();
    completedToday.forEach((order) => {
      order.items.forEach((item) => {
        if (item.status !== OrderItemStatus.CANCELLED && !item.isFree) {
          const key = ((item.itemId as any)?._id || item.itemId).toString();
          const existing = itemCountMap.get(key) || {
            name: item.menuItemNameSnapshot || key,
            count: 0,
            revenue: 0,
          };
          existing.count += item.quantity;
          existing.revenue += item.quantity * item.price;
          if (item.menuItemNameSnapshot)
            existing.name = item.menuItemNameSnapshot;
          itemCountMap.set(key, existing);
        }
      });
    });

    const top5Items = Array.from(itemCountMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([itemId, data]) => ({ itemId, ...data }));

    // Populate item names from MenuItem in a single batch query instead of N+1.
    const top5MenuItemIds = top5Items
      .map((item) => item.itemId)
      .filter((id) => Types.ObjectId.isValid(id));
    if (top5MenuItemIds.length > 0) {
      const menuItems = await this.menuItemModel
        .find({ _id: { $in: top5MenuItemIds.map((id) => new Types.ObjectId(id)) } })
        .select('name')
        .exec();
      const menuMap = new Map(menuItems.map((m: any) => [m._id.toString(), m.name]));
      for (const item of top5Items) {
        const name = menuMap.get(item.itemId);
        if (name) item.name = name;
      }
    }

    // Stock alerts
    const lowStockItems = await this.itemModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: ItemStatus.ACTIVE,
        $expr: { $lt: ['$stock', '$minStockLevel'] },
      })
      .select('name stock minStockLevel unit')
      .exec();

    // Active tables count (from orders)
    const activeOrderCount = await this.orderModel
      .countDocuments({
        tenantId: new Types.ObjectId(tenantId),
        status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
      })
      .exec();

    return {
      today: {
        revenue: todayRevenue,
        yesterdayRevenue,
        avgDailyRevenue,
        completedOrders: completedToday.length,
        pendingOrders: todayOrders.filter(
          (o) => o.status === OrderStatus.PENDING,
        ).length,
        inProgressOrders: todayOrders.filter(
          (o) => o.status === OrderStatus.IN_PROGRESS,
        ).length,
        cancelledOrders: todayOrders.filter(
          (o) => o.status === OrderStatus.CANCELLED,
        ).length,
        activeOrders: activeOrderCount,
      },
      topItems: top5Items,
      stockAlerts: lowStockItems,
    };
  }

  async getRevenueReport(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<any> {
    const orders = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: startDate, $lte: endDate },
      })
      .exec();

    const totalRevenue = orders.reduce(
      (sum, o) => sum + (o.finalAmount || 0),
      0,
    );
    const totalVAT = orders.reduce((sum, o) => sum + (o.vat || 0), 0);
    const totalServiceCharge = orders.reduce(
      (sum, o) => sum + (o.serviceCharge || 0),
      0,
    );
    const totalDiscount = orders.reduce((sum, o) => sum + (o.discount || 0), 0);
    const orderCount = orders.length;

    return {
      totalRevenue,
      totalVAT,
      totalServiceCharge,
      totalDiscount,
      orderCount,
      orders: orders.map((o) => ({
        id: (o as any)._id,
        completedAt: o.completedAt,
        totalAmount: o.totalAmount,
        discount: o.discount,
        vat: o.vat,
        serviceCharge: o.serviceCharge,
        finalAmount: o.finalAmount,
      })),
    };
  }

  async getRevenueByHour(tenantId: string, dateStr?: string): Promise<any[]> {
    const date = dateStr ? new Date(dateStr) : new Date();
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const orders = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: dayStart, $lte: dayEnd },
      })
      .exec();

    // Group by hour
    const hourlyData: { hour: number; revenue: number; orderCount: number }[] =
      [];
    for (let h = 0; h < 24; h++) {
      const hourOrders = orders.filter((o) => {
        const completedHour = o.completedAt
          ? new Date(o.completedAt).getHours()
          : -1;
        return completedHour === h;
      });

      hourlyData.push({
        hour: h,
        revenue: hourOrders.reduce((sum, o) => sum + (o.finalAmount || 0), 0),
        orderCount: hourOrders.length,
      });
    }

    return hourlyData;
  }

  async getTopItems(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    limit = 10,
  ): Promise<any> {
    const orders = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: startDate, $lte: endDate },
      })
      .exec();

    const itemCountMap = new Map<string, { count: number; revenue: number }>();

    orders.forEach((order) => {
      order.items.forEach((item) => {
        if (item.status !== OrderItemStatus.CANCELLED && !item.isFree) {
          const key = item.itemId.toString();
          const existing = itemCountMap.get(key) || { count: 0, revenue: 0 };
          existing.count += item.quantity;
          existing.revenue += item.quantity * item.price;
          itemCountMap.set(key, existing);
        }
      });
    });

    const sorted = Array.from(itemCountMap.entries()).sort(
      (a, b) => b[1].count - a[1].count,
    );

    const topSelling = sorted.slice(0, limit);
    const leastSelling = sorted.reverse().slice(0, limit);

    // Populate item names
    const populateItems = async (items: [string, any][]) => {
      const ids = items.map(([itemId]) => itemId).filter((id) => Types.ObjectId.isValid(id));
      const menuItems = ids.length
        ? await this.menuItemModel
            .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
            .select('name category')
            .exec()
        : [];
      const menuMap = new Map(menuItems.map((m: any) => [m._id.toString(), m]));
      return items.map(([itemId, data]) => {
        const menuItem = menuMap.get(itemId);
        return {
          itemId,
          name: menuItem?.name || 'Unknown',
          category: menuItem?.category || 'Unknown',
          ...data,
        };
      });
    };

    return {
      topSelling: await populateItems(topSelling),
      leastSelling: await populateItems(leastSelling),
    };
  }

  async getFinancialReport(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<any> {
    // Revenue
    const revenueData = await this.getRevenueReport(
      tenantId,
      startDate,
      endDate,
    );

    // Material cost (from inventory deductions — simplified using completed orders)
    const orders = await this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: startDate, $lte: endDate },
      })
      .exec();
    const materialCostSummary = this.calculateMaterialCostFromSnapshots(orders);
    const materialCost = materialCostSummary.cogs;

    // Labor cost (from payroll)
    const monthStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;
    const payrolls = await this.payrollModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        month: monthStr,
      })
      .exec();
    const laborCost = payrolls.reduce(
      (sum, p) => sum + (p.finalSalary || 0),
      0,
    );

    const grossProfit = revenueData.totalRevenue - materialCost;
    const netProfit = grossProfit - laborCost;

    return {
      revenue: revenueData.totalRevenue,
      materialCost: Math.round(materialCost),
      laborCost: Math.round(laborCost),
      grossProfit: Math.round(grossProfit),
      netProfit: Math.round(netProfit),
      orderCount: revenueData.orderCount,
      totalVAT: revenueData.totalVAT,
      totalServiceCharge: revenueData.totalServiceCharge,
      totalDiscount: revenueData.totalDiscount,
      missingCostCount: materialCostSummary.missingCostCount,
      costEstimatedCount: materialCostSummary.costEstimatedCount,
    };
  }

  async getProfitReport(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    groupBy: 'day' | 'item' | 'category' = 'day',
  ): Promise<any> {
    const orders = await this.findCompletedOrders(tenantId, startDate, endDate);
    const menuMeta = await this.getMenuMetaForOrders(orders);
    const groups = new Map<string, any>();
    const summary = this.createProfitBucket('summary', 'Tong cong');

    for (const order of orders) {
      const rows = this.buildProfitRowsForOrder(order, menuMeta, groupBy);
      for (const row of rows) {
        this.addProfit(summary, row);
        const bucket =
          groups.get(row.groupKey) ||
          this.createProfitBucket(row.groupKey, row.groupLabel, row.extra);
        this.addProfit(bucket, row);
        groups.set(row.groupKey, bucket);
      }
    }

    return {
      startDate,
      endDate,
      groupBy,
      summary: this.finalizeProfitBucket(summary),
      groups: Array.from(groups.values()).map((bucket) =>
        this.finalizeProfitBucket(bucket),
      ),
    };
  }

  async getItemMarginReport(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<any> {
    const report = await this.getProfitReport(
      tenantId,
      startDate,
      endDate,
      'item',
    );
    return {
      ...report,
      items: report.groups.sort(
        (a: any, b: any) => b.grossProfit - a.grossProfit,
      ),
    };
  }

  async getEmployeeReport(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<any[]> {
    const users = await this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .exec();
    const reports = [];

    for (const user of users) {
      if (user.role === 'SYSTEM_OWNER') continue;

      // Calculate total orders generated by this employee
      const orders = await this.orderModel
        .find({
          tenantId: new Types.ObjectId(tenantId),
          createdBy: user._id,
          status: OrderStatus.COMPLETED,
          completedAt: { $gte: startDate, $lte: endDate },
        })
        .exec();

      const totalSales = orders.reduce(
        (sum, o) => sum + (o.finalAmount || 0),
        0,
      );

      // Attendance details
      const attendances = await this.attendanceModel
        .find({
          tenantId: new Types.ObjectId(tenantId),
          userId: user._id,
          date: { $gte: startDate, $lte: endDate },
        })
        .exec();

      const workedHours = attendances.reduce(
        (sum, a) => sum + (a.totalHours || 0),
        0,
      );
      const shifts = attendances.length;
      const lateDays = attendances.filter((a) => a.status === 'LATE').length;

      reports.push({
        userId: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        orderCount: orders.length,
        totalSales,
        workedHours,
        shiftsWorked: shifts,
        lateDays,
      });
    }

    return reports;
  }

  private async findCompletedOrders(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ) {
    return this.orderModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: startDate, $lte: endDate },
      })
      .exec();
  }

  private async getMenuMetaForOrders(orders: OrderDocument[]) {
    const ids = Array.from(
      new Set(
        orders.flatMap((order) =>
          order.items
            .map((item: any) =>
              ((item.itemId as any)?._id || item.itemId)?.toString?.(),
            )
            .filter(Boolean),
        ),
      ),
    );
    if (ids.length === 0)
      return new Map<string, { name: string; category: string }>();

    const menuItems = await this.menuItemModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('name category')
      .exec();
    const map = new Map<string, { name: string; category: string }>();
    menuItems.forEach((item: any) => {
      map.set(item._id.toString(), {
        name: item.name || item._id.toString(),
        category: item.category || 'Unknown',
      });
    });
    return map;
  }

  private buildProfitRowsForOrder(
    order: OrderDocument,
    menuMeta: Map<string, { name: string; category: string }>,
    groupBy: 'day' | 'item' | 'category',
  ) {
    const activeItems = order.items.filter(
      (item) => item.status !== OrderItemStatus.CANCELLED,
    );
    const orderGrossRevenue = activeItems.reduce((sum, item: any) => {
      if (order.isFree || item.isFree) return sum;
      return (
        sum + Math.round(Number(item.quantity || 0) * Number(item.price || 0))
      );
    }, 0);
    const orderDiscount = Math.round(Number(order.discount || 0));

    return activeItems.map((item: any) => {
      const itemId =
        ((item.itemId as any)?._id || item.itemId)?.toString?.() || 'unknown';
      const meta = menuMeta.get(itemId);
      const isFree = Boolean(order.isFree || item.isFree);
      const grossRevenue = isFree
        ? 0
        : Math.round(Number(item.quantity || 0) * Number(item.price || 0));
      const discount =
        orderGrossRevenue > 0
          ? Math.round((orderDiscount * grossRevenue) / orderGrossRevenue)
          : 0;
      const netRevenue = Math.max(0, grossRevenue - discount);
      const costSnapshot = item.costSnapshot;
      const cogs = costSnapshot
        ? Math.round(Number(costSnapshot.totalCost || 0))
        : 0;
      const missingCost = !costSnapshot || Boolean(costSnapshot.missingCost);
      const completedAt =
        order.completedAt || (order as any).updatedAt || new Date();
      const dayKey = this.formatReportDay(completedAt);
      const category = meta?.category || 'Unknown';
      const name = item.menuItemNameSnapshot || meta?.name || itemId;
      const { groupKey, groupLabel, extra } = this.resolveProfitGroup(
        groupBy,
        dayKey,
        itemId,
        name,
        category,
      );

      return {
        groupKey,
        groupLabel,
        extra,
        quantity: Number(item.quantity || 0),
        revenue: grossRevenue,
        discount,
        netRevenue,
        cogs,
        missingCost,
        costEstimated: Boolean(costSnapshot?.costEstimated),
      };
    });
  }

  private resolveProfitGroup(
    groupBy: 'day' | 'item' | 'category',
    dayKey: string,
    itemId: string,
    itemName: string,
    category: string,
  ) {
    if (groupBy === 'item') {
      return {
        groupKey: itemId,
        groupLabel: itemName,
        extra: { itemId, category },
      };
    }
    if (groupBy === 'category') {
      return {
        groupKey: category,
        groupLabel: category,
        extra: { category },
      };
    }
    return { groupKey: dayKey, groupLabel: dayKey, extra: { date: dayKey } };
  }

  private createProfitBucket(
    key: string,
    label: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      key,
      label,
      ...extra,
      quantity: 0,
      revenue: 0,
      discount: 0,
      netRevenue: 0,
      cogs: 0,
      grossProfit: 0,
      grossMargin: 0,
      missingCostCount: 0,
      costEstimatedCount: 0,
    };
  }

  private addProfit(bucket: any, row: any) {
    bucket.quantity += row.quantity;
    bucket.revenue += row.revenue;
    bucket.discount += row.discount;
    bucket.netRevenue += row.netRevenue;
    bucket.cogs += row.cogs;
    if (row.missingCost) bucket.missingCostCount += 1;
    if (row.costEstimated) bucket.costEstimatedCount += 1;
  }

  private calculateMaterialCostFromSnapshots(orders: OrderDocument[]) {
    return orders.reduce(
      (acc, order) => {
        order.items
          .filter((item) => item.status !== OrderItemStatus.CANCELLED)
          .forEach((item: any) => {
            const costSnapshot = item.costSnapshot;
            if (!costSnapshot) {
              acc.missingCostCount += 1;
              return;
            }

            acc.cogs += Math.round(Number(costSnapshot.totalCost || 0));
            if (costSnapshot.missingCost) acc.missingCostCount += 1;
            if (costSnapshot.costEstimated) acc.costEstimatedCount += 1;
          });
        return acc;
      },
      { cogs: 0, missingCostCount: 0, costEstimatedCount: 0 },
    );
  }

  private finalizeProfitBucket(bucket: any) {
    bucket.grossProfit = bucket.netRevenue - bucket.cogs;
    bucket.grossMargin =
      bucket.netRevenue > 0
        ? Math.round((bucket.grossProfit / bucket.netRevenue) * 10000) / 100
        : 0;
    return bucket;
  }

  private formatReportDay(date: Date) {
    return new Date(date).toISOString().slice(0, 10);
  }
}
