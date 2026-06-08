import { ItemCategory } from '../../inventory/schemas/inventory.schema';
import { ManualAvailabilityOverride, MenuItemStatus } from '../schemas/menu-item.schema';

export class CreateMenuItemDto {
  name: string;
  category: ItemCategory;
  description?: string;
  sellingPrice: number;
  imageUrl?: string;
  status?: MenuItemStatus;
  manualAvailabilityOverride?: ManualAvailabilityOverride;
  legacyInventoryItemId?: string;
}
