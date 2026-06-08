import { ItemCategory } from '../schemas/inventory.schema';

export class CreateItemDto {
  name: string;
  unit: string;
  category: ItemCategory;
  imageUrl?: string;
  costPrice: number;
  sellingPrice: number;
  stock?: number;
  minStockLevel?: number;
}
