import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import {
  Attendance,
  AttendanceSchema,
} from '../attendance/schemas/attendance.schema';
import { Payroll, PayrollSchema } from '../attendance/schemas/payroll.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  InventoryItem,
  InventoryItemSchema,
} from '../inventory/schemas/inventory.schema';
import { MenuItem, MenuItemSchema } from '../menu/schemas/menu-item.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Attendance.name, schema: AttendanceSchema },
      { name: Payroll.name, schema: PayrollSchema },
      { name: User.name, schema: UserSchema },
      { name: InventoryItem.name, schema: InventoryItemSchema },
      { name: MenuItem.name, schema: MenuItemSchema },
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
