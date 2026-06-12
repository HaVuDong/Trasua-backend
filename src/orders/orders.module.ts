import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order, OrderSchema } from './schemas/order.schema';
import { Table, TableSchema } from '../tables/schemas/table.schema';
import { InventoryItem, InventoryItemSchema } from '../inventory/schemas/inventory.schema';
import { Tenant, TenantSchema } from '../tenants/schemas/tenant.schema';
import { InventoryModule } from '../inventory/inventory.module';
import { ChatModule } from '../chat/chat.module';
import { MenuModule } from '../menu/menu.module';
import { MenuItem, MenuItemSchema } from '../menu/schemas/menu-item.schema';
import { MenuItemRecipe, MenuItemRecipeSchema } from '../menu/schemas/menu-item-recipe.schema';
import { TableSession, TableSessionSchema } from './schemas/table-session.schema';
import { CustomerRequest, CustomerRequestSchema } from './schemas/customer-request.schema';
import { CustomerPayment, CustomerPaymentSchema } from './schemas/customer-payment.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Table.name, schema: TableSchema },
      { name: InventoryItem.name, schema: InventoryItemSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: MenuItem.name, schema: MenuItemSchema },
      { name: MenuItemRecipe.name, schema: MenuItemRecipeSchema },
      { name: TableSession.name, schema: TableSessionSchema },
      { name: CustomerRequest.name, schema: CustomerRequestSchema },
      { name: CustomerPayment.name, schema: CustomerPaymentSchema },
    ]),
    InventoryModule,
    MenuModule,
    ChatModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
