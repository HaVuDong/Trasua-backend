export class ImportItemDto {
  itemId: string;
  quantity: number;
  costPrice: number;
}

export class CreateImportDto {
  items: ImportItemDto[];
  provider: string;
  date?: Date;
  notes?: string;
}
