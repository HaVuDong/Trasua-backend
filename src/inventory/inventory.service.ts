import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { InventoryItem, InventoryItemDocument, ItemStatus } from './schemas/inventory.schema';
import { ImportTicket, ImportTicketDocument } from './schemas/import-ticket.schema';
import { MenuItemRecipe, MenuItemRecipeDocument, MenuRecipeStatus } from '../menu/schemas/menu-item-recipe.schema';
import { CreateItemDto } from './dto/create-item.dto';
import { CreateImportDto } from './dto/create-import.dto';

export interface StockValidationItem {
  itemId: string;
  quantity: number;
  itemName?: string;
}

export interface StockValidationDetail {
  itemId: string;
  itemName?: string;
  requestedQuantity: number;
  availableQuantity: number;
  message: string;
  readableMessage: string;
}

@Injectable()
export class InventoryService {
  constructor(
    @InjectModel(InventoryItem.name) private itemModel: Model<InventoryItemDocument>,
    @InjectModel(ImportTicket.name) private ticketModel: Model<ImportTicketDocument>,
    @InjectModel(MenuItemRecipe.name) private menuRecipeModel: Model<MenuItemRecipeDocument>,
  ) {}

  async createItem(tenantId: string, dto: CreateItemDto): Promise<InventoryItem> {
    const item = new this.itemModel({
      ...dto,
      tenantId: new Types.ObjectId(tenantId),
    });
    return item.save();
  }

  async findAllItems(tenantId: string, includeDeleted = false): Promise<InventoryItem[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (!includeDeleted) {
      query.status = { $ne: ItemStatus.DELETED };
    }
    return this.itemModel.find(query).exec();
  }

  async findOneItem(tenantId: string, id: string): Promise<InventoryItem> {
    const item = await this.itemModel.findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!item) throw new NotFoundException('Inventory item not found');
    return item;
  }

  async updateItem(tenantId: string, id: string, dto: any): Promise<InventoryItem> {
    const updated = await this.itemModel.findOneAndUpdate(
      { _id: id, tenantId: new Types.ObjectId(tenantId) },
      { $set: dto },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException('Inventory item not found');
    return updated;
  }

  async deleteItem(tenantId: string, id: string): Promise<InventoryItem> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Inventory item id is invalid');
    }

    const activeRecipe = await this.menuRecipeModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      status: MenuRecipeStatus.ACTIVE,
      'ingredients.inventoryItemId': new Types.ObjectId(id),
    }).select('_id menuItemId').lean().exec();

    if (activeRecipe) {
      throw new BadRequestException('Nguyen lieu dang duoc dung trong cong thuc menu. Vui long go khoi cong thuc truoc.');
    }

    return this.updateItem(tenantId, id, { status: ItemStatus.DELETED });
  }

  async importStock(tenantId: string, creatorId: string, dto: CreateImportDto): Promise<ImportTicket> {
    const ticketItems = dto.items.map(item => ({
      itemId: new Types.ObjectId(item.itemId),
      quantity: item.quantity,
      costPrice: item.costPrice,
    }));

    const ticket = new this.ticketModel({
      tenantId: new Types.ObjectId(tenantId),
      items: ticketItems,
      provider: dto.provider,
      date: dto.date || new Date(),
      notes: dto.notes,
      createdBy: new Types.ObjectId(creatorId),
    });

    const savedTicket = await ticket.save();

    // Update stocks and weighted average costPrice
    for (const itemDto of dto.items) {
      const item = await this.itemModel.findOne({
        _id: itemDto.itemId,
        tenantId: new Types.ObjectId(tenantId),
        status: { $ne: ItemStatus.DELETED },
      }).exec();

      if (!item) {
        throw new NotFoundException('Inventory item not found');
      }

      const currentStock = Number(item.stock || 0);
      const currentCost = Number(item.costPrice || 0);
      const incomingQuantity = Number(itemDto.quantity || 0);
      const incomingCost = Number(itemDto.costPrice || 0);
      if (!Number.isFinite(incomingQuantity) || incomingQuantity <= 0) {
        throw new BadRequestException('Import quantity must be greater than 0');
      }
      if (!Number.isFinite(incomingCost) || incomingCost < 0) {
        throw new BadRequestException('Import cost price must be non-negative');
      }

      const nextStock = currentStock + incomingQuantity;
      const nextCost =
        nextStock > 0
          ? Number((((currentStock * currentCost) + (incomingQuantity * incomingCost)) / nextStock).toFixed(4))
          : incomingCost;

      item.stock = nextStock;
      item.costPrice = nextCost;
      await item.save();
    }

    return savedTicket;
  }

  async validateStockAvailability(tenantId: string, items: StockValidationItem[], session?: ClientSession): Promise<void> {
    const requestedByItem = new Map<string, number>();

    for (const entry of items) {
      const requestedQuantity = Number(entry.quantity);
      if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
        throw new BadRequestException(`Invalid quantity for item ${entry.itemId}`);
      }

      requestedByItem.set(entry.itemId, (requestedByItem.get(entry.itemId) || 0) + requestedQuantity);
    }

    for (const [itemId, requestedQuantity] of requestedByItem.entries()) {
      const item = await this.itemModel.findOne({
        _id: itemId,
        tenantId: new Types.ObjectId(tenantId),
        status: ItemStatus.ACTIVE,
      }).session(session || null).exec();

      if (!item) {
        throw new NotFoundException(`Inventory item ${itemId} not found or unavailable`);
      }

      if (item.stock < requestedQuantity) {
        throw this.buildInsufficientStockException({
          itemId,
          itemName: item.name,
          requestedQuantity,
          availableQuantity: item.stock,
          message: 'Khong du so luong ton kho',
          readableMessage: `${item.name}: yeu cau ${requestedQuantity}, ton kho hien tai ${item.stock}`,
        });
      }
    }
  }

  async deductStock(
    tenantId: string,
    itemId: string,
    quantity: number,
    options?: { session?: ClientSession; itemName?: string },
  ): Promise<void> {
    const normalizedQuantity = Number(quantity);
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      throw new BadRequestException(`Invalid deduction quantity for item ${itemId}`);
    }

    const updated = await this.itemModel.findOneAndUpdate(
      {
        _id: itemId,
        tenantId: new Types.ObjectId(tenantId),
        status: ItemStatus.ACTIVE,
        stock: { $gte: normalizedQuantity },
      },
      { $inc: { stock: -normalizedQuantity } },
      { new: true, session: options?.session },
    ).exec();

    if (updated) {
      return;
    }

    const existingItem = await this.itemModel.findOne({
      _id: itemId,
      tenantId: new Types.ObjectId(tenantId),
    }).session(options?.session || null).exec();

    if (!existingItem) {
      throw new NotFoundException(`Inventory item ${itemId} not found for deduction`);
    }

    if (existingItem.status !== ItemStatus.ACTIVE) {
      throw new BadRequestException({
        message: 'Mon da ngung ban',
        itemId,
        itemName: existingItem.name || options?.itemName,
        requestedQuantity: normalizedQuantity,
        availableQuantity: existingItem.stock || 0,
        readableMessage: `${existingItem.name || itemId}: mon khong con hoat dong`,
      });
    }

    throw this.buildInsufficientStockException({
      itemId,
      itemName: existingItem.name || options?.itemName,
      requestedQuantity: normalizedQuantity,
      availableQuantity: existingItem.stock,
      message: 'Khong du so luong ton kho',
      readableMessage: `${existingItem.name || itemId}: yeu cau ${normalizedQuantity}, ton kho hien tai ${existingItem.stock}`,
    });
  }

  async getLowStockAlerts(tenantId: string): Promise<InventoryItem[]> {
    return this.itemModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: ItemStatus.ACTIVE,
      $expr: { $lt: ['$stock', '$minStockLevel'] }
    }).exec();
  }

  async getInventoryStatus(tenantId: string): Promise<any> {
    const items = await this.findAllItems(tenantId);
    const lowStock = items.filter(i => i.stock < i.minStockLevel && i.status === ItemStatus.ACTIVE);
    const totalValue = items.reduce((sum, item) => sum + (item.stock * item.costPrice), 0);

    return {
      totalItems: items.length,
      lowStockCount: lowStock.length,
      totalValue,
      statusSummary: {
        inStock: items.filter(i => i.stock >= i.minStockLevel).length,
        lowStock: lowStock.length,
        outOfStock: items.filter(i => i.stock <= 0).length,
      }
    };
  }

  async getImportHistory(tenantId: string): Promise<ImportTicket[]> {
    return this.ticketModel.find({ tenantId: new Types.ObjectId(tenantId) })
      .populate('items.itemId')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }

  private buildInsufficientStockException(detail: StockValidationDetail) {
    return new BadRequestException(detail);
  }
}
