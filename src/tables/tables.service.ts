import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Table, TableDocument, TableStatus } from './schemas/table.schema';
import { Order, OrderDocument, OrderStatus } from '../orders/schemas/order.schema';
import { TableSession, TableSessionDocument, TableSessionStatus } from '../orders/schemas/table-session.schema';
import { CreateTableDto } from './dto/create-table.dto';
import { Tenant, TenantDocument } from '../tenants/schemas/tenant.schema';
import { MenuItem, MenuItemDocument, MenuItemStatus } from '../menu/schemas/menu-item.schema';
import { getSaasPlan } from '../billing/saas-plans';
import * as crypto from 'crypto';

@Injectable()
export class TablesService {
  constructor(
    @InjectModel(Table.name) private tableModel: Model<TableDocument>,
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(TableSession.name) private tableSessionModel: Model<TableSessionDocument>,
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    @InjectModel(MenuItem.name) private menuItemModel: Model<MenuItemDocument>,
  ) {}

  private normalizeTableNumber(rawValue: unknown): string {
    const trimmed = String(rawValue ?? '').trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new BadRequestException('So ban khong hop le');
    }
    const withoutLeadingZeros = trimmed.replace(/^0+/, '');
    return withoutLeadingZeros || '0';
  }

  private extractTableNumberFromName(name?: string): string | null {
    if (!name || typeof name !== 'string') return null;
    const match = name.trim().match(/\d+/);
    if (!match) return null;
    return this.normalizeTableNumber(match[0]);
  }

  private resolveTableNumberForValidation(input: { tableNumber?: unknown; name?: unknown }): string {
    if (input.tableNumber !== undefined && input.tableNumber !== null && String(input.tableNumber).trim()) {
      return this.normalizeTableNumber(input.tableNumber);
    }

    if (typeof input.name === 'string' && input.name.trim()) {
      const parsedFromName = this.extractTableNumberFromName(input.name);
      if (parsedFromName) return parsedFromName;
    }

    throw new BadRequestException('So ban khong hop le');
  }

  private buildDuplicateTableNumberException(tableNumber: string): BadRequestException {
    return new BadRequestException({
      code: 'DUPLICATE_TABLE_NUMBER',
      message: 'So ban da ton tai',
      tableNumber,
    });
  }

  private isDuplicateTableNumberMongoError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as any;
    if (err.code !== 11000) return false;
    const errorText = `${err?.message || ''} ${err?.errmsg || ''}`;
    return errorText.includes('tableNumber');
  }

  private async assertUniqueTableNumber(
    tenantId: string,
    tableNumber: string,
    excludeTableId?: string,
  ): Promise<void> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const query: any = {
      tenantId: tenantObjectId,
      tableNumber,
    };
    if (excludeTableId) {
      query._id = { $ne: new Types.ObjectId(excludeTableId) };
    }

    const directDuplicate = await this.tableModel.findOne(query).select('_id').lean().exec();
    if (directDuplicate) {
      throw this.buildDuplicateTableNumberException(tableNumber);
    }

    // Compatibility guard for legacy records that may not have tableNumber persisted yet.
    const legacyQuery: any = {
      tenantId: tenantObjectId,
      $or: [{ tableNumber: { $exists: false } }, { tableNumber: null }, { tableNumber: '' }],
    };
    if (excludeTableId) {
      legacyQuery._id = { $ne: new Types.ObjectId(excludeTableId) };
    }

    const legacyTables = await this.tableModel.find(legacyQuery).select('name').lean().exec();

    const duplicated = legacyTables.some((table: any) => {
      const existingNumber = this.extractTableNumberFromName(table?.name);
      return existingNumber === tableNumber;
    });

    if (duplicated) {
      throw this.buildDuplicateTableNumberException(tableNumber);
    }
  }

  private async assertTableLimit(tenantId: string) {
    const tenant = await this.tenantModel.findById(tenantId).select('subscription').lean().exec();
    if (!tenant) throw new BadRequestException('Tenant not found');
    const plan = getSaasPlan((tenant as any).subscription?.plan);
    const tableCount = await this.tableModel.countDocuments({ tenantId: new Types.ObjectId(tenantId) }).exec();

    if (tableCount >= plan.maxTables) {
      throw new BadRequestException(`Goi ${plan.id} chi cho phep toi da ${plan.maxTables} ban`);
    }
  }

  private async assertCanMarkTableEmpty(tenantId: string, tableId: Types.ObjectId) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const [openSession, activeOrder] = await Promise.all([
      this.tableSessionModel.findOne({
        tenantId: tenantObjectId,
        tableId,
        status: TableSessionStatus.OPEN,
      }).select('_id').lean().exec(),
      this.orderModel.findOne({
        tenantId: tenantObjectId,
        tableId,
        status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
      }).select('_id').lean().exec(),
    ]);

    if (openSession || activeOrder) {
      throw new BadRequestException('Cannot mark table empty while it has an open session or active orders');
    }
  }

  async create(tenantId: string, createTableDto: CreateTableDto): Promise<Table> {
    const tableNumber = this.resolveTableNumberForValidation(createTableDto);
    await this.assertTableLimit(tenantId);
    await this.assertUniqueTableNumber(tenantId, tableNumber);

    const qrCodeToken = crypto.randomUUID();
    const normalizedName = createTableDto.name?.trim() || `Ban ${tableNumber}`;
    const { tableNumber: _tableNumber, ...payload } = createTableDto as any;
    const newTable = new this.tableModel({
      ...payload,
      name: normalizedName,
      tableNumber,
      tenantId: new Types.ObjectId(tenantId),
      qrCodeToken,
    });

    try {
      return await newTable.save();
    } catch (error) {
      if (this.isDuplicateTableNumberMongoError(error)) {
        throw this.buildDuplicateTableNumberException(tableNumber);
      }
      throw error;
    }
  }

  async findAllByTenant(tenantId: string): Promise<Table[]> {
    return this.tableModel.find({ tenantId: new Types.ObjectId(tenantId) }).exec();
  }

  async findOne(tenantId: string, id: string): Promise<Table> {
    const table = await this.tableModel.findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!table) throw new NotFoundException('Table not found');
    return table;
  }

  async updateTable(tenantId: string, id: string, updates: any): Promise<Table> {
    const existing = await this.tableModel.findOne({
      _id: id,
      tenantId: new Types.ObjectId(tenantId),
    }).exec();
    if (!existing) throw new NotFoundException('Table not found');

    delete updates._id;
    delete updates.tenantId;
    delete updates.qrCodeToken;

    if (updates.status !== undefined) {
      if (!Object.values(TableStatus).includes(updates.status)) {
        throw new BadRequestException('Trang thai ban khong hop le');
      }
      if (updates.status === TableStatus.EMPTY) {
        await this.assertCanMarkTableEmpty(tenantId, existing._id as Types.ObjectId);
      }
    }

    const hasExplicitTableNumberChange = Object.prototype.hasOwnProperty.call(updates, 'tableNumber');
    const hasNameChange = Object.prototype.hasOwnProperty.call(updates, 'name');
    const hasTableNumberChangeRequest = hasExplicitTableNumberChange || hasNameChange;
    let nextTableNumber: string | null = null;

    if (hasTableNumberChangeRequest) {
      const fallbackNumber = existing.tableNumber || this.extractTableNumberFromName(existing.name);
      nextTableNumber = this.resolveTableNumberForValidation({
        tableNumber: hasExplicitTableNumberChange ? updates.tableNumber : fallbackNumber,
        name: typeof updates.name === 'string' ? updates.name : existing.name,
      });
      await this.assertUniqueTableNumber(tenantId, nextTableNumber, id);
    }

    if (nextTableNumber) {
      updates.tableNumber = nextTableNumber;
    } else {
      delete updates.tableNumber;
    }
    if (typeof updates.name === 'string') {
      updates.name = updates.name.trim();
    }

    let updated: TableDocument | null = null;
    try {
      updated = await this.tableModel.findOneAndUpdate(
        { _id: id, tenantId: new Types.ObjectId(tenantId) },
        { $set: updates },
        { new: true },
      ).exec();
    } catch (error) {
      if (this.isDuplicateTableNumberMongoError(error)) {
        throw this.buildDuplicateTableNumberException(nextTableNumber || '');
      }
      throw error;
    }
    if (!updated) throw new NotFoundException('Table not found');
    return updated;
  }

  async deleteTable(tenantId: string, id: string): Promise<{ message: string }> {
    const tableObjectId = new Types.ObjectId(id);
    const tenantObjectId = new Types.ObjectId(tenantId);
    const [activeOrders, openSessions] = await Promise.all([
      this.orderModel.countDocuments({
        tableId: tableObjectId,
        tenantId: tenantObjectId,
        status: { $in: [OrderStatus.PENDING, OrderStatus.IN_PROGRESS] },
      }).exec(),
      this.tableSessionModel.countDocuments({
        tableId: tableObjectId,
        tenantId: tenantObjectId,
        status: TableSessionStatus.OPEN,
      }).exec(),
    ]);

    if (activeOrders > 0 || openSessions > 0) {
      throw new BadRequestException('Cannot delete table with open sessions or active orders');
    }

    const deleted = await this.tableModel.findOneAndDelete({
      _id: tableObjectId,
      tenantId: tenantObjectId,
    }).exec();

    if (!deleted) throw new NotFoundException('Table not found');
    return { message: `Table ${deleted.name} has been deleted` };
  }

  async setDefaultItems(tenantId: string, tableId: string, defaultItems: { itemId: string; quantity: number }[]): Promise<Table> {
    const table = await this.tableModel.findOne({ _id: tableId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!table) throw new NotFoundException('Table not found');

    const normalizedItems = (defaultItems || []).map((item) => {
      if (!Types.ObjectId.isValid(item.itemId)) {
        throw new BadRequestException('Default item must be a valid menu item');
      }
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException('Default item quantity must be greater than 0');
      }
      return {
        itemId: new Types.ObjectId(item.itemId),
        quantity,
      };
    });

    const uniqueMenuItemIds = [...new Set(normalizedItems.map((item) => item.itemId.toString()))];
    if (uniqueMenuItemIds.length > 0) {
      const activeMenuItemCount = await this.menuItemModel.countDocuments({
        _id: { $in: uniqueMenuItemIds.map((id) => new Types.ObjectId(id)) },
        tenantId: new Types.ObjectId(tenantId),
        status: MenuItemStatus.ACTIVE,
      }).exec();
      if (activeMenuItemCount !== uniqueMenuItemIds.length) {
        throw new BadRequestException('Default items must be active menu items in this tenant');
      }
    }

    table.defaultItems = normalizedItems;

    return table.save();
  }

  async toggleVisibility(tenantId: string, id: string): Promise<Table> {
    const table = await this.tableModel.findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!table) throw new NotFoundException('Table not found');

    table.isHidden = !table.isHidden;
    return table.save();
  }

  async resetQr(tenantId: string, id: string): Promise<Table> {
    const table = await this.findOne(tenantId, id);
    table.qrCodeToken = crypto.randomUUID();
    return (table as any).save();
  }

  async validateQrToken(tenantId: string, qrToken: string): Promise<Table> {
    const table = await this.tableModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      qrCodeToken: qrToken,
    }).exec();

    if (!table) throw new NotFoundException('Invalid or expired QR code');
    if (table.isHidden) throw new BadRequestException('This table is currently unavailable');

    return table;
  }

  async updateStatus(tenantId: string, id: string, status: TableStatus): Promise<Table> {
    const table = await this.tableModel.findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!table) throw new NotFoundException('Table not found');

    if (!Object.values(TableStatus).includes(status)) {
      throw new BadRequestException('Trang thai ban khong hop le');
    }

    if (status === TableStatus.EMPTY) {
      await this.assertCanMarkTableEmpty(tenantId, table._id as Types.ObjectId);
    }

    table.status = status;
    return table.save();
  }
}
