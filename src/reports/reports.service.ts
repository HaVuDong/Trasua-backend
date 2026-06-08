import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument, OrderStatus, OrderItemStatus } from '../orders/schemas/order.schema';
import { Attendance, AttendanceDocument } from '../attendance/schemas/attendance.schema';
import { Payroll, PayrollDocument } from '../attendance/schemas/payroll.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { InventoryItem, InventoryItemDocument, ItemStatus } from '../inventory/schemas/inventory.schema';
import { MenuItem, MenuItemDocument } from '../menu/schemas/menu-item.schema';

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Attendance.name) private attendanceModel: Model<AttendanceDocument>,
    @InjectModel(Payroll.name) private payrollModel: Model<PayrollDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(InventoryItem.name) private itemModel: Model<InventoryItemDocument>,
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
    const todayOrders = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      createdAt: { $gte: todayStart, $lte: todayEnd },
    }).exec();

    // Completed orders today are revenue source-of-truth and must match revenue-by-hour.
    const completedToday = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: OrderStatus.COMPLETED,
      completedAt: { $gte: todayStart, $lte: todayEnd },
    }).exec();
    const todayRevenue = completedToday.reduce((sum, o) => sum + (o.finalAmount || 0), 0);

    // Yesterday revenue for comparison
    const yesterdayOrders = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: OrderStatus.COMPLETED,
      completedAt: { $gte: yesterdayStart, $lte: yesterdayEnd },
    }).exec();
    const yesterdayRevenue = yesterdayOrders.reduce((sum, o) => sum + (o.finalAmount || 0), 0);

    // Last 7 days average
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const weekOrders = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: OrderStatus.COMPLETED,
      completedAt: { $gte: sevenDaysAgo, $lte: todayEnd },
    }).exec();
    const weekRevenue = weekOrders.reduce((sum, o) => sum + (o.finalAmount || 0), 0);
    const avgDailyRevenue = Math.round(weekRevenue / 7);

    // Top 5 items today
    const itemCountMap = new Map<string, { name: string; count: number; revenue: number }>();
    completedToday.forEach(order => {
      order.items.forEach(item => {
        if (item.status !== OrderItemStatus.CANCELLED && !item.isFree) {
          const key = ((item.itemId as any)?._id || item.itemId).toString();
          const existing = itemCountMap.get(key) || {
            name: item.menuItemNameSnapshot || key,
            count: 0,
            revenue: 0,
          };
          existing.count += item.quantity;
          existing.revenue += item.quantity * item.price;
          if (item.menuItemNameSnapshot) existing.name = item.menuItemNameSnapshot;
          itemCountMap.set(key, existing);
        }
      });
    });

    const top5Items = Array.from(itemCountMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([itemId, data]) => ({ itemId, ...data }));

    // Populate item names from MenuItem because order items reference menu_items.
    for (const item of top5Items) {
      const menuItem = await this.menuItemModel.findById(item.itemId).select('name').exec();
      if (menuItem) item.name = menuItem.name;
    }

    // Stock alerts
    const lowStockItems = await this.itemModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: ItemStatus.ACTIVE,
      $expr: { $lt: ['$stock', '$minStockLevel'] },
    }).select('name stock minStockLevel unit').exec();

    // Active tables count (from orders)
    const activeOrderCount = await this.orderModel.countDocuments({
      tenantId: new Types.ObjectId(tenantId),
      status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
    }).exec();

    return {
      today: {
        revenue: todayRevenue,
        yesterdayRevenue,
        avgDailyRevenue,
        completedOrders: completedToday.length,
        pendingOrders: todayOrders.filter(o => o.status === OrderStatus.PENDING).length,
        inProgressOrders: todayOrders.filter(o => o.status === OrderStatus.IN_PROGRESS).length,
        cancelledOrders: todayOrders.filter(o => o.status === OrderStatus.CANCELLED).length,
        activeOrders: activeOrderCount,
      },
      topItems: top5Items,
      stockAlerts: lowStockItems,
    };
  }

  async getRevenueReport(tenantId: string, startDate: Date, endDate: Date): Promise<any> {
    const orders = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: OrderStatus.COMPLETED,
      completedAt: { $gte: startDate, $lte: endDate },
    }).exec();

    const totalRevenue = orders.reduce((sum, o) => sum + (o.finalAmount || 0), 0);
    const totalVAT = orders.reduce((sum, o) => sum + (o.vat || 0), 0);
    const totalServiceCharge = orders.reduce((sum, o) => sum + (o.serviceCharge || 0), 0);
    const totalDiscount = orders.reduce((sum, o) => sum + (o.discount || 0), 0);
    const orderCount = orders.length;

    return {
      totalRevenue,
      totalVAT,
      totalServiceCharge,
      totalDiscount,
      orderCount,
      orders: orders.map(o => ({
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

    const orders = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: OrderStatus.COMPLETED,
      completedAt: { $gte: dayStart, $lte: dayEnd },
    }).exec();

    // Group by hour
    const hourlyData: { hour: number; revenue: number; orderCount: number }[] = [];
    for (let h = 0; h < 24; h++) {
      const hourOrders = orders.filter(o => {
        const completedHour = o.completedAt ? new Date(o.completedAt).getHours() : -1;
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

  async getTopItems(tenantId: string, startDate: Date, endDate: Date, limit = 10): Promise<any> {
    const orders = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: OrderStatus.COMPLETED,
      completedAt: { $gte: startDate, $lte: endDate },
    }).exec();

    const itemCountMap = new Map<string, { count: number; revenue: number }>();

    orders.forEach(order => {
      order.items.forEach(item => {
        if (item.status !== OrderItemStatus.CANCELLED && !item.isFree) {
          const key = item.itemId.toString();
          const existing = itemCountMap.get(key) || { count: 0, revenue: 0 };
          existing.count += item.quantity;
          existing.revenue += item.quantity * item.price;
          itemCountMap.set(key, existing);
        }
      });
    });

    const sorted = Array.from(itemCountMap.entries())
      .sort((a, b) => b[1].count - a[1].count);

    const topSelling = sorted.slice(0, limit);
    const leastSelling = sorted.reverse().slice(0, limit);

    // Populate item names
    const populateItems = async (items: [string, any][]) => {
      const result = [];
      for (const [itemId, data] of items) {
        const menuItem = await this.menuItemModel.findById(itemId).select('name category').exec();
        result.push({
          itemId,
          name: menuItem?.name || 'Unknown',
          category: menuItem?.category || 'Unknown',
          ...data,
        });
      }
      return result;
    };

    return {
      topSelling: await populateItems(topSelling),
      leastSelling: await populateItems(leastSelling),
    };
  }

  async getFinancialReport(tenantId: string, startDate: Date, endDate: Date): Promise<any> {
    // Revenue
    const revenueData = await this.getRevenueReport(tenantId, startDate, endDate);

    // Material cost (from inventory deductions — simplified using completed orders)
    let materialCost = 0;
    const orders = await this.orderModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: OrderStatus.COMPLETED,
      completedAt: { $gte: startDate, $lte: endDate },
    }).exec();

    for (const order of orders) {
      for (const item of order.items) {
        if (item.status !== OrderItemStatus.CANCELLED) {
          const invItem = await this.itemModel.findById(item.itemId).exec();
          if (invItem) {
            materialCost += item.quantity * invItem.costPrice;
          }
        }
      }
    }

    // Labor cost (from payroll)
    const monthStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;
    const payrolls = await this.payrollModel.find({
      tenantId: new Types.ObjectId(tenantId),
      month: monthStr,
    }).exec();
    const laborCost = payrolls.reduce((sum, p) => sum + (p.finalSalary || 0), 0);

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
    };
  }

  async getEmployeeReport(tenantId: string, startDate: Date, endDate: Date): Promise<any[]> {
    const users = await this.userModel.find({ tenantId: new Types.ObjectId(tenantId) }).exec();
    const reports = [];

    for (const user of users) {
      if (user.role === 'SYSTEM_OWNER') continue;

      // Calculate total orders generated by this employee
      const orders = await this.orderModel.find({
        tenantId: new Types.ObjectId(tenantId),
        createdBy: user._id,
        status: OrderStatus.COMPLETED,
        completedAt: { $gte: startDate, $lte: endDate },
      }).exec();

      const totalSales = orders.reduce((sum, o) => sum + (o.finalAmount || 0), 0);

      // Attendance details
      const attendances = await this.attendanceModel.find({
        tenantId: new Types.ObjectId(tenantId),
        userId: user._id,
        date: { $gte: startDate, $lte: endDate },
      }).exec();

      const workedHours = attendances.reduce((sum, a) => sum + (a.totalHours || 0), 0);
      const shifts = attendances.length;
      const lateDays = attendances.filter(a => a.status === 'LATE').length;

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
}
