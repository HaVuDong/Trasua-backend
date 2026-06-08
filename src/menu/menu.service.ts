import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { InventoryItem, InventoryItemDocument, ItemStatus } from '../inventory/schemas/inventory.schema';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { UpsertMenuRecipeDto } from './dto/upsert-menu-recipe.dto';
import {
  ManualAvailabilityOverride,
  MenuItem,
  MenuItemDocument,
  MenuItemStatus,
} from './schemas/menu-item.schema';
import {
  MenuItemRecipe,
  MenuItemRecipeDocument,
  MenuRecipeIngredient,
  MenuRecipeStatus,
} from './schemas/menu-item-recipe.schema';

export interface MenuItemAvailabilityIssue {
  inventoryItemId: string;
  name: string;
  unit: string;
  requestedQuantity: number;
  availableQuantity: number;
  reason: string;
}

export interface MenuItemAvailabilityResult {
  menuItemId: string;
  name: string;
  quantity: number;
  available: boolean;
  status: 'AVAILABLE' | 'OUT_OF_STOCK' | 'INACTIVE';
  reason?: string;
  issues: MenuItemAvailabilityIssue[];
}

@Injectable()
export class MenuService {
  constructor(
    @InjectModel(MenuItem.name) private menuItemModel: Model<MenuItemDocument>,
    @InjectModel(MenuItemRecipe.name) private menuRecipeModel: Model<MenuItemRecipeDocument>,
    @InjectModel(InventoryItem.name) private inventoryModel: Model<InventoryItemDocument>,
  ) {}

  async createMenuItem(tenantId: string, actorId: string, dto: CreateMenuItemDto): Promise<MenuItem> {
    const name = dto.name?.trim();
    const sellingPrice = Number(dto.sellingPrice);
    if (!name) {
      throw new BadRequestException('Ten mon la bat buoc');
    }
    if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
      throw new BadRequestException('Gia ban khong hop le');
    }

    const menuItem = new this.menuItemModel({
      ...dto,
      name,
      sellingPrice,
      tenantId: new Types.ObjectId(tenantId),
      createdBy: new Types.ObjectId(actorId),
      updatedBy: new Types.ObjectId(actorId),
      legacyInventoryItemId: dto.legacyInventoryItemId ? new Types.ObjectId(dto.legacyInventoryItemId) : undefined,
      status: dto.status || MenuItemStatus.ACTIVE,
    });

    return menuItem.save();
  }

  async findAllMenuItems(tenantId: string, filters?: { category?: string; search?: string; includeDeleted?: boolean }) {
    await this.ensureMenuSeededFromInventory(tenantId);

    const query: any = {
      tenantId: new Types.ObjectId(tenantId),
    };

    if (!filters?.includeDeleted) {
      query.status = { $ne: MenuItemStatus.DELETED };
    }
    if (filters?.category) {
      query.category = filters.category;
    }
    if (filters?.search?.trim()) {
      query.name = { $regex: filters.search.trim(), $options: 'i' };
    }

    return this.menuItemModel.find(query).sort({ createdAt: -1 }).exec();
  }

  async findMenuItemById(tenantId: string, menuItemId: string) {
    const item = await this.menuItemModel.findOne({
      _id: menuItemId,
      tenantId: new Types.ObjectId(tenantId),
    }).exec();

    if (!item || item.status === MenuItemStatus.DELETED) {
      throw new NotFoundException('Menu item not found');
    }

    return item;
  }

  async updateMenuItem(tenantId: string, actorId: string, menuItemId: string, dto: UpdateMenuItemDto) {
    const updates: Record<string, any> = {};
    if (dto.name !== undefined) {
      const normalizedName = dto.name.trim();
      if (!normalizedName) {
        throw new BadRequestException('Ten mon la bat buoc');
      }
      updates.name = normalizedName;
    }
    if (dto.category !== undefined) {
      updates.category = dto.category;
    }
    if (dto.description !== undefined) {
      updates.description = dto.description?.trim() || undefined;
    }
    if (dto.imageUrl !== undefined) {
      updates.imageUrl = dto.imageUrl?.trim() || undefined;
    }
    if (dto.status !== undefined) {
      updates.status = dto.status;
    }
    if (dto.manualAvailabilityOverride !== undefined) {
      updates.manualAvailabilityOverride = dto.manualAvailabilityOverride;
    }
    if (dto.sellingPrice !== undefined) {
      const sellingPrice = Number(dto.sellingPrice);
      if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
        throw new BadRequestException('Gia ban khong hop le');
      }
      updates.sellingPrice = sellingPrice;
    }

    updates.updatedBy = new Types.ObjectId(actorId);

    const updated = await this.menuItemModel.findOneAndUpdate(
      {
        _id: menuItemId,
        tenantId: new Types.ObjectId(tenantId),
        status: { $ne: MenuItemStatus.DELETED },
      },
      { $set: updates },
      { new: true },
    ).exec();

    if (!updated) {
      throw new NotFoundException('Menu item not found');
    }

    return updated;
  }

  async deleteMenuItem(tenantId: string, actorId: string, menuItemId: string) {
    return this.updateMenuItem(tenantId, actorId, menuItemId, { status: MenuItemStatus.DELETED });
  }

  async getActiveRecipeForMenuItem(tenantId: string, menuItemId: string) {
    await this.findMenuItemById(tenantId, menuItemId);
    return this.menuRecipeModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      menuItemId: new Types.ObjectId(menuItemId),
      status: MenuRecipeStatus.ACTIVE,
    }).exec();
  }

  async upsertRecipe(tenantId: string, actorId: string, menuItemId: string, dto: UpsertMenuRecipeDto) {
    await this.findMenuItemById(tenantId, menuItemId);

    if (!Array.isArray(dto.ingredients) || dto.ingredients.length === 0) {
      throw new BadRequestException('Cong thuc mon phai co it nhat 1 nguyen lieu');
    }

    const inventoryIds = dto.ingredients.map((ing) => ing.inventoryItemId?.trim()).filter((id) => !!id) as string[];
    if (inventoryIds.length !== dto.ingredients.length) {
      throw new BadRequestException('Nguyen lieu khong hop le');
    }

    const seen = new Set<string>();
    for (const inventoryItemId of inventoryIds) {
      if (seen.has(inventoryItemId)) {
        throw new BadRequestException(`Trung nguyen lieu ${inventoryItemId} trong cong thuc`);
      }
      seen.add(inventoryItemId);
    }

    const inventoryItems = await this.inventoryModel.find({
      _id: { $in: inventoryIds.map((id) => new Types.ObjectId(id)) },
      tenantId: new Types.ObjectId(tenantId),
      status: { $ne: ItemStatus.DELETED },
    }).exec();

    const inventoryById = new Map<string, InventoryItemDocument>();
    inventoryItems.forEach((item) => inventoryById.set(item._id.toString(), item));

    const recipeIngredients: MenuRecipeIngredient[] = dto.ingredients.map((ingredient) => {
      const inventoryItem = inventoryById.get(ingredient.inventoryItemId);
      if (!inventoryItem) {
        throw new BadRequestException(`Nguyen lieu ${ingredient.inventoryItemId} khong ton tai`);
      }

      const requiredQuantity = Number(ingredient.requiredQuantity);
      if (!Number.isFinite(requiredQuantity) || requiredQuantity <= 0) {
        throw new BadRequestException(`So luong nguyen lieu ${inventoryItem.name} khong hop le`);
      }

      const wastePercent = ingredient.wastePercent === undefined ? undefined : Number(ingredient.wastePercent);
      if (wastePercent !== undefined && (!Number.isFinite(wastePercent) || wastePercent < 0 || wastePercent > 100)) {
        throw new BadRequestException(`Ty le hao hut cua ${inventoryItem.name} khong hop le`);
      }

      return {
        inventoryItemId: inventoryItem._id as Types.ObjectId,
        inventoryItemNameSnapshot: inventoryItem.name,
        requiredQuantity,
        unitSnapshot: inventoryItem.unit,
        wastePercent,
        isOptional: Boolean(ingredient.isOptional),
      };
    });

    const existingActiveRecipe = await this.menuRecipeModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      menuItemId: new Types.ObjectId(menuItemId),
      status: MenuRecipeStatus.ACTIVE,
    }).exec();

    if (!existingActiveRecipe) {
      const created = new this.menuRecipeModel({
        tenantId: new Types.ObjectId(tenantId),
        menuItemId: new Types.ObjectId(menuItemId),
        ingredients: recipeIngredients,
        version: 1,
        status: MenuRecipeStatus.ACTIVE,
        createdBy: new Types.ObjectId(actorId),
        updatedBy: new Types.ObjectId(actorId),
      });
      return created.save();
    }

    existingActiveRecipe.ingredients = recipeIngredients;
    existingActiveRecipe.version = (existingActiveRecipe.version || 1) + 1;
    existingActiveRecipe.updatedBy = new Types.ObjectId(actorId);
    return existingActiveRecipe.save();
  }

  async checkAvailability(tenantId: string, menuItemId: string, quantity = 1): Promise<MenuItemAvailabilityResult> {
    const normalizedQuantity = Number(quantity);
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      throw new BadRequestException('So luong kiem tra khong hop le');
    }

    const item = await this.findMenuItemById(tenantId, menuItemId);
    const recipe = await this.menuRecipeModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      menuItemId: item._id,
      status: MenuRecipeStatus.ACTIVE,
    }).exec();

    const ingredientIds = recipe?.ingredients?.map((ingredient) => ingredient.inventoryItemId.toString()) || [];
    const inventoryItems = ingredientIds.length
      ? await this.inventoryModel.find({
          _id: { $in: ingredientIds.map((id) => new Types.ObjectId(id)) },
          tenantId: new Types.ObjectId(tenantId),
          status: { $ne: ItemStatus.DELETED },
        }).exec()
      : [];

    const inventoryById = new Map<string, InventoryItemDocument>();
    inventoryItems.forEach((inventoryItem) => inventoryById.set(inventoryItem._id.toString(), inventoryItem));

    return this.evaluateAvailability(item, recipe, inventoryById, normalizedQuantity);
  }

  async getAvailability(tenantId: string, quantity = 1): Promise<MenuItemAvailabilityResult[]> {
    await this.ensureMenuSeededFromInventory(tenantId);

    const normalizedQuantity = Number(quantity);
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      throw new BadRequestException('So luong kiem tra khong hop le');
    }

    const menuItems = await this.findAllMenuItems(tenantId, { includeDeleted: false });
    if (menuItems.length === 0) return [];

    const menuItemIds = menuItems.map((item) => item._id);
    const recipes = await this.menuRecipeModel.find({
      tenantId: new Types.ObjectId(tenantId),
      menuItemId: { $in: menuItemIds },
      status: MenuRecipeStatus.ACTIVE,
    }).exec();

    const recipeByItemId = new Map<string, MenuItemRecipeDocument>();
    const inventoryItemIdSet = new Set<string>();

    recipes.forEach((recipe) => {
      recipeByItemId.set(recipe.menuItemId.toString(), recipe);
      recipe.ingredients.forEach((ingredient) => {
        inventoryItemIdSet.add(ingredient.inventoryItemId.toString());
      });
    });

    const inventoryItems = inventoryItemIdSet.size
      ? await this.inventoryModel.find({
          _id: { $in: Array.from(inventoryItemIdSet).map((id) => new Types.ObjectId(id)) },
          tenantId: new Types.ObjectId(tenantId),
          status: { $ne: ItemStatus.DELETED },
        }).exec()
      : [];

    const inventoryById = new Map<string, InventoryItemDocument>();
    inventoryItems.forEach((item) => inventoryById.set(item._id.toString(), item));

    return menuItems.map((menuItem) => {
      const recipe = recipeByItemId.get(menuItem._id.toString()) || null;
      return this.evaluateAvailability(menuItem, recipe, inventoryById, normalizedQuantity);
    });
  }

  private evaluateAvailability(
    menuItem: MenuItemDocument,
    recipe: MenuItemRecipeDocument | null,
    inventoryById: Map<string, InventoryItemDocument>,
    quantity: number,
  ): MenuItemAvailabilityResult {
    const baseResult: MenuItemAvailabilityResult = {
      menuItemId: menuItem._id.toString(),
      name: menuItem.name,
      quantity,
      available: false,
      status: 'OUT_OF_STOCK',
      issues: [],
    };

    if (menuItem.status !== MenuItemStatus.ACTIVE) {
      return {
        ...baseResult,
        status: 'INACTIVE',
        reason: 'MON_DANG_TAM_NGUNG',
      };
    }

    if (menuItem.manualAvailabilityOverride === ManualAvailabilityOverride.FORCE_UNAVAILABLE) {
      return {
        ...baseResult,
        status: 'OUT_OF_STOCK',
        reason: 'MANUAL_UNAVAILABLE',
      };
    }

    if (menuItem.manualAvailabilityOverride === ManualAvailabilityOverride.FORCE_AVAILABLE) {
      return {
        ...baseResult,
        available: true,
        status: 'AVAILABLE',
        reason: 'MANUAL_AVAILABLE',
      };
    }

    if (!recipe || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      return {
        ...baseResult,
        status: 'OUT_OF_STOCK',
        reason: 'RECIPE_MISSING',
      };
    }

    const issues: MenuItemAvailabilityIssue[] = [];
    for (const ingredient of recipe.ingredients) {
      const inventoryItem = inventoryById.get(ingredient.inventoryItemId.toString());
      const wasteMultiplier = 1 + (Number(ingredient.wastePercent) || 0) / 100;
      const requestedQuantity = Number((ingredient.requiredQuantity * quantity * wasteMultiplier).toFixed(4));

      if (!inventoryItem || inventoryItem.status !== ItemStatus.ACTIVE) {
        if (!ingredient.isOptional) {
          issues.push({
            inventoryItemId: ingredient.inventoryItemId.toString(),
            name: ingredient.inventoryItemNameSnapshot,
            unit: ingredient.unitSnapshot,
            requestedQuantity,
            availableQuantity: 0,
            reason: 'INGREDIENT_UNAVAILABLE',
          });
        }
        continue;
      }

      if (!ingredient.isOptional && inventoryItem.stock < requestedQuantity) {
        issues.push({
          inventoryItemId: inventoryItem._id.toString(),
          name: inventoryItem.name,
          unit: inventoryItem.unit,
          requestedQuantity,
          availableQuantity: inventoryItem.stock,
          reason: 'INSUFFICIENT_STOCK',
        });
      }
    }

    if (issues.length === 0) {
      return {
        ...baseResult,
        available: true,
        status: 'AVAILABLE',
        issues: [],
      };
    }

    return {
      ...baseResult,
      available: false,
      status: 'OUT_OF_STOCK',
      reason: 'INSUFFICIENT_INGREDIENTS',
      issues,
    };
  }

  private async ensureMenuSeededFromInventory(tenantId: string) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const existingCount = await this.menuItemModel.countDocuments({
      tenantId: tenantObjectId,
      status: { $ne: MenuItemStatus.DELETED },
    });
    if (existingCount > 0) return;

    const inventoryItems = await this.inventoryModel.find({
      tenantId: tenantObjectId,
      status: { $ne: ItemStatus.DELETED },
    }).exec();

    if (inventoryItems.length === 0) return;

    for (const inventoryItem of inventoryItems) {
      const existed = await this.menuItemModel.findOne({
        tenantId: tenantObjectId,
        legacyInventoryItemId: inventoryItem._id,
      }).exec();

      if (existed) continue;

      const menuItem = new this.menuItemModel({
        tenantId: tenantObjectId,
        name: inventoryItem.name,
        category: inventoryItem.category,
        description: undefined,
        sellingPrice: inventoryItem.sellingPrice,
        imageUrl: inventoryItem.imageUrl,
        status: inventoryItem.status === ItemStatus.ACTIVE ? MenuItemStatus.ACTIVE : MenuItemStatus.HIDDEN,
        legacyInventoryItemId: inventoryItem._id,
      });

      const savedMenuItem = await menuItem.save();

      const recipe = new this.menuRecipeModel({
        tenantId: tenantObjectId,
        menuItemId: savedMenuItem._id,
        ingredients: [
          {
            inventoryItemId: inventoryItem._id,
            inventoryItemNameSnapshot: inventoryItem.name,
            requiredQuantity: 1,
            unitSnapshot: inventoryItem.unit,
            isOptional: false,
          },
        ],
        version: 1,
        status: MenuRecipeStatus.ACTIVE,
      });

      await recipe.save();
    }
  }
}
