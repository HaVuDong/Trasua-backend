export class UpsertMenuRecipeIngredientDto {
  inventoryItemId: string;
  requiredQuantity: number;
  wastePercent?: number;
  isOptional?: boolean;
}

export class UpsertMenuRecipeDto {
  ingredients: UpsertMenuRecipeIngredientDto[];
}
