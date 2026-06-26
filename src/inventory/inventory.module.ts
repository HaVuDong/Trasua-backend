import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { InventoryItem, InventoryItemSchema } from './schemas/inventory.schema';
import {
  ImportTicket,
  ImportTicketSchema,
} from './schemas/import-ticket.schema';
import {
  MenuItemRecipe,
  MenuItemRecipeSchema,
} from '../menu/schemas/menu-item-recipe.schema';
import {
  InventoryAdjustment,
  InventoryAdjustmentSchema,
} from './schemas/inventory-adjustment.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: InventoryItem.name, schema: InventoryItemSchema },
      { name: ImportTicket.name, schema: ImportTicketSchema },
      { name: MenuItemRecipe.name, schema: MenuItemRecipeSchema },
      { name: InventoryAdjustment.name, schema: InventoryAdjustmentSchema },
    ]),
  ],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
