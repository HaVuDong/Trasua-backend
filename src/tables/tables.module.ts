import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TablesService } from './tables.service';
import { TablesController } from './tables.controller';
import { Table, TableSchema } from './schemas/table.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { TableSession, TableSessionSchema } from '../orders/schemas/table-session.schema';
import { Tenant, TenantSchema } from '../tenants/schemas/tenant.schema';
import { MenuItem, MenuItemSchema } from '../menu/schemas/menu-item.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Table.name, schema: TableSchema },
      { name: Order.name, schema: OrderSchema },
      { name: TableSession.name, schema: TableSessionSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: MenuItem.name, schema: MenuItemSchema },
    ]),
  ],
  controllers: [TablesController],
  providers: [TablesService],
  exports: [TablesService],
})
export class TablesModule {}
