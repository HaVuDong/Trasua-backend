import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { InventoryItem, InventoryItemDocument, ItemCategory, ItemStatus } from './schemas/inventory.schema';
import { ImportTicket, ImportTicketDocument } from './schemas/import-ticket.schema';
import { MenuItemRecipe, MenuItemRecipeDocument, MenuRecipeStatus } from '../menu/schemas/menu-item-recipe.schema';
import { CreateItemDto } from './dto/create-item.dto';
import { CreateImportDto } from './dto/create-import.dto';
// @ts-ignore
import * as ExcelJS from 'exceljs';

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

type InventoryImportField =
  | 'name'
  | 'unit'
  | 'category'
  | 'stock'
  | 'minStockLevel'
  | 'costPrice'
  | 'totalCostPrice'
  | 'status';

interface ParsedInventoryImportRow {
  rowNumber: number;
  dto: CreateItemDto & { status: ItemStatus };
  provided: {
    stock: boolean;
    minStockLevel: boolean;
    costPrice: boolean;
    totalCostPrice: boolean;
    status: boolean;
  };
}

export interface InventoryExcelImportError {
  row: number;
  field: string;
  message: string;
  value?: string;
}

export interface InventoryExcelImportResult {
  createdCount: number;
  updatedCount: number;
  stockImportedQuantity: number;
  importTicketId?: string;
  rows: Array<{
    row: number;
    id: string;
    name: string;
    action: 'CREATED' | 'UPDATED';
    previousStock: number;
    nextStock: number;
  }>;
  errors: InventoryExcelImportError[];
}

const INVENTORY_IMPORT_HEADERS: Array<{ header: string; key: InventoryImportField; width: number }> = [
  { header: 'Ten nguyen lieu *', key: 'name', width: 28 },
  { header: 'Don vi *', key: 'unit', width: 14 },
  { header: 'Danh muc *', key: 'category', width: 16 },
  { header: 'So luong nhap / ton ban dau', key: 'stock', width: 24 },
  { header: 'Gia von don vi', key: 'costPrice', width: 16 },
  { header: 'Tong gia von ton kho', key: 'totalCostPrice', width: 20 },
  { header: 'Nguong canh bao', key: 'minStockLevel', width: 18 },
  { header: 'Trang thai', key: 'status', width: 14 },
];

const IMPORT_HEADER_ALIASES: Record<string, InventoryImportField> = {
  name: 'name',
  ingredientname: 'name',
  itemname: 'name',
  ten: 'name',
  tenhang: 'name',
  tennguyenlieu: 'name',
  unit: 'unit',
  donvi: 'unit',
  donvitinh: 'unit',
  category: 'category',
  danhmuc: 'category',
  loai: 'category',
  nhom: 'category',
  stock: 'stock',
  quantity: 'stock',
  ton: 'stock',
  tonkho: 'stock',
  tonkhobandau: 'stock',
  soluongton: 'stock',
  soluongnhap: 'stock',
  nhapthem: 'stock',
  minstock: 'minStockLevel',
  minstocklevel: 'minStockLevel',
  min: 'minStockLevel',
  toithieu: 'minStockLevel',
  nguongcanhbao: 'minStockLevel',
  tonantoan: 'minStockLevel',
  costprice: 'costPrice',
  unitcost: 'costPrice',
  giavon: 'costPrice',
  giavondonvi: 'costPrice',
  giavondv: 'costPrice',
  gianhap: 'costPrice',
  totalcost: 'totalCostPrice',
  totalcostprice: 'totalCostPrice',
  tonggiavon: 'totalCostPrice',
  tonggiavontonkho: 'totalCostPrice',
  tongtien: 'totalCostPrice',
  status: 'status',
  trangthai: 'status',
};

const REQUIRED_IMPORT_FIELDS: InventoryImportField[] = ['name', 'unit', 'category'];

@Injectable()
export class InventoryService {
  constructor(
    @InjectModel(InventoryItem.name) private itemModel: Model<InventoryItemDocument>,
    @InjectModel(ImportTicket.name) private ticketModel: Model<ImportTicketDocument>,
    @InjectModel(MenuItemRecipe.name) private menuRecipeModel: Model<MenuItemRecipeDocument>,
  ) {}

  async buildItemsImportTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TraSua POS';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Nguyen lieu');
    worksheet.columns = INVENTORY_IMPORT_HEADERS.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width,
    }));
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    worksheet.addRows([
      {
        name: 'Tran chau den',
        unit: 'kg',
        category: ItemCategory.DRINK,
        stock: 10,
        costPrice: 35000,
        totalCostPrice: '',
        minStockLevel: 2,
        status: ItemStatus.ACTIVE,
      },
      {
        name: 'Sua tuoi',
        unit: 'lit',
        category: ItemCategory.DRINK,
        stock: 20,
        costPrice: 28000,
        totalCostPrice: '',
        minStockLevel: 5,
        status: ItemStatus.ACTIVE,
      },
    ]);

    for (let rowNumber = 2; rowNumber <= 300; rowNumber += 1) {
      worksheet.getCell(`C${rowNumber}`).dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: ['"DRINK,FOOD,FRUIT,OTHER"'],
      };
      worksheet.getCell(`H${rowNumber}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"ACTIVE,HIDDEN"'],
      };
    }

    worksheet.getColumn('D').numFmt = '#,##0.####';
    worksheet.getColumn('E').numFmt = '#,##0';
    worksheet.getColumn('F').numFmt = '#,##0';
    worksheet.getColumn('G').numFmt = '#,##0.####';

    const guide = workbook.addWorksheet('Huong dan');
    guide.columns = [
      { header: 'Cot', key: 'field', width: 26 },
      { header: 'Mo ta', key: 'description', width: 72 },
    ];
    guide.addRows([
      { field: 'Ten nguyen lieu *', description: 'Bat buoc. Neu ten da ton tai va don vi/danh muc khop, he thong se nhap them vao ton kho hien co.' },
      { field: 'Don vi *', description: 'Bat buoc. Vi du: kg, g, lit, ml, goi, hop, chai. Nguyen lieu da co phai trung don vi moi duoc cong ton.' },
      { field: 'Danh muc *', description: 'Bat buoc. Gia tri hop le: DRINK, FOOD, FRUIT, OTHER. Nguyen lieu da co phai trung danh muc moi duoc cong ton.' },
      { field: 'So luong nhap / ton ban dau', description: 'Khong bat buoc. Nguyen lieu moi: ton ban dau. Nguyen lieu da co: so luong nhap them. Phai la so khong am.' },
      { field: 'Gia von don vi', description: 'Khong bat buoc. Gia von cho 1 don vi nhap. Neu nhap them hang, he thong tinh lai gia von binh quan.' },
      { field: 'Tong gia von ton kho', description: 'Tuy chon. Neu khong nhap Gia von don vi, he thong co the lay tong gia von chia cho so luong nhap.' },
      { field: 'Nguong canh bao', description: 'Khong bat buoc. Nguyen lieu moi mac dinh 0. Nguyen lieu da co chi cap nhat khi cot nay co gia tri.' },
      { field: 'Trang thai', description: 'Khong bat buoc. Gia tri hop le: ACTIVE hoac HIDDEN. Nguyen lieu da co chi cap nhat khi cot nay co gia tri.' },
    ]);
    guide.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
  }

  async importItemsFromExcel(tenantId: string, file: any, creatorId?: string): Promise<InventoryExcelImportResult> {
    if (!file?.buffer) {
      throw new BadRequestException('Vui long chon file Excel can nhap');
    }

    const originalName = String(file.originalname || '').toLowerCase();
    if (!originalName.endsWith('.xlsx')) {
      throw new BadRequestException('Chi ho tro file Excel dinh dang .xlsx');
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file.buffer as any);
    } catch {
      throw new BadRequestException('Khong the doc file Excel. Vui long tai lai mau va kiem tra dinh dang file.');
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('File Excel khong co sheet du lieu');
    }

    const headerMap = this.buildImportHeaderMap(worksheet.getRow(1));
    const missingFields = REQUIRED_IMPORT_FIELDS.filter((field) => !headerMap.has(field));
    if (missingFields.length > 0) {
      throw new BadRequestException({
        message: 'File Excel thieu cot bat buoc',
        errors: missingFields.map((field) => ({
          row: 1,
          field,
          message: `Thieu cot ${field}`,
        })),
      });
    }

    const tenantObjectId = new Types.ObjectId(tenantId);
    const existingItems = await this.itemModel
      .find({ tenantId: tenantObjectId, status: { $ne: ItemStatus.DELETED } })
      .select('name unit category stock costPrice sellingPrice minStockLevel status')
      .exec();
    const existingByName = new Map(existingItems.map((item: any) => [this.normalizeComparableName(item.name), item] as const));
    const fileNames = new Set<string>();

    const parsedRows: ParsedInventoryImportRow[] = [];
    const errors: InventoryExcelImportError[] = [];
    const rowsToCreate: ParsedInventoryImportRow[] = [];
    const rowsToUpdate: Array<{ parsed: ParsedInventoryImportRow; item: any }> = [];

    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      if (this.isImportRowEmpty(row, headerMap)) {
        continue;
      }

      const parsed = this.parseInventoryImportRow(row, rowNumber, headerMap, errors);
      if (!parsed) {
        continue;
      }

      const normalizedName = this.normalizeComparableName(parsed.dto.name);
      if (fileNames.has(normalizedName)) {
        errors.push({
          row: rowNumber,
          field: 'name',
          message: 'Ten nguyen lieu bi trung trong file Excel',
          value: parsed.dto.name,
        });
      }
      fileNames.add(normalizedName);

      const existingItem = existingByName.get(normalizedName);
      if (existingItem) {
        if (this.normalizeImportKey(existingItem.unit) !== this.normalizeImportKey(parsed.dto.unit)) {
          errors.push({
            row: rowNumber,
            field: 'unit',
            message: `Don vi khong khop voi nguyen lieu dang co (${existingItem.unit})`,
            value: parsed.dto.unit,
          });
        }
        if (existingItem.category !== parsed.dto.category) {
          errors.push({
            row: rowNumber,
            field: 'category',
            message: `Danh muc khong khop voi nguyen lieu dang co (${existingItem.category})`,
            value: parsed.dto.category,
          });
        }
        rowsToUpdate.push({ parsed, item: existingItem });
      } else {
        rowsToCreate.push(parsed);
      }
      parsedRows.push(parsed);
    }

    if (parsedRows.length === 0 && errors.length === 0) {
      throw new BadRequestException('File Excel chua co dong nguyen lieu nao de nhap');
    }

    if (parsedRows.length > 500) {
      errors.push({
        row: 0,
        field: 'file',
        message: 'Moi lan chi nen nhap toi da 500 nguyen lieu',
      });
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'File Excel co loi. Vui long sua cac dong duoc bao va nhap lai.',
        errors,
      });
    }

    const resultRows: InventoryExcelImportResult['rows'] = [];
    const ticketItems: Array<{ itemId: Types.ObjectId; quantity: number; costPrice: number }> = [];

    const insertedItems = rowsToCreate.length > 0
      ? await this.itemModel.insertMany(
          rowsToCreate.map((entry) => ({
            ...entry.dto,
            tenantId: tenantObjectId,
          })),
          { ordered: true },
        )
      : [];

    insertedItems.forEach((item: any, index: number) => {
      const parsed = rowsToCreate[index];
      const nextStock = Number(item.stock || parsed.dto.stock || 0);
      const importedQuantity = Number(parsed.dto.stock || 0);
      resultRows.push({
        row: parsed.rowNumber,
        id: String(item._id),
        name: item.name,
        action: 'CREATED',
        previousStock: 0,
        nextStock,
      });
      if (importedQuantity > 0) {
        ticketItems.push({
          itemId: new Types.ObjectId(String(item._id)),
          quantity: importedQuantity,
          costPrice: Number(parsed.dto.costPrice || 0),
        });
      }
    });

    for (const { parsed, item } of rowsToUpdate) {
      const previousStock = Number(item.stock || 0);
      const previousCost = Number(item.costPrice || 0);
      const importedQuantity = Number(parsed.dto.stock || 0);
      const importedCost = Number(parsed.dto.costPrice || 0);
      const nextStock = previousStock + importedQuantity;
      const nextCost =
        importedQuantity > 0 && nextStock > 0
          ? Number((((previousStock * previousCost) + (importedQuantity * importedCost)) / nextStock).toFixed(4))
          : previousCost;

      item.stock = nextStock;
      item.costPrice = nextCost;
      item.sellingPrice = nextCost;
      if (parsed.provided.minStockLevel) {
        item.minStockLevel = parsed.dto.minStockLevel;
      }
      if (parsed.provided.status) {
        item.status = parsed.dto.status;
      }
      await item.save();

      resultRows.push({
        row: parsed.rowNumber,
        id: String(item._id),
        name: item.name,
        action: 'UPDATED',
        previousStock,
        nextStock,
      });

      if (importedQuantity > 0) {
        ticketItems.push({
          itemId: new Types.ObjectId(String(item._id)),
          quantity: importedQuantity,
          costPrice: importedCost,
        });
      }
    }

    let importTicketId: string | undefined;
    if (ticketItems.length > 0) {
      const ticketPayload: any = {
        tenantId: tenantObjectId,
        items: ticketItems,
        provider: 'Excel import',
        date: new Date(),
        notes: `Imported from ${file.originalname || 'Excel file'}`,
      };
      if (creatorId && Types.ObjectId.isValid(creatorId)) {
        ticketPayload.createdBy = new Types.ObjectId(creatorId);
      }
      const ticket = await new this.ticketModel(ticketPayload).save();
      importTicketId = String((ticket as any)._id || '');
    }

    return {
      createdCount: insertedItems.length,
      updatedCount: rowsToUpdate.length,
      stockImportedQuantity: ticketItems.reduce((sum, item) => sum + item.quantity, 0),
      importTicketId,
      rows: resultRows.sort((a, b) => a.row - b.row),
      errors: [],
    };
  }

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

  private buildImportHeaderMap(headerRow: any): Map<InventoryImportField, number> {
    const headerMap = new Map<InventoryImportField, number>();

    headerRow.eachCell((cell: any, colNumber: number) => {
      const normalizedHeader = this.normalizeImportKey(this.getCellText(cell.value));
      const field = IMPORT_HEADER_ALIASES[normalizedHeader];
      if (field && !headerMap.has(field)) {
        headerMap.set(field, colNumber);
      }
    });

    return headerMap;
  }

  private isImportRowEmpty(row: any, headerMap: Map<InventoryImportField, number>): boolean {
    for (const colNumber of headerMap.values()) {
      if (this.getCellText(row.getCell(colNumber).value).trim()) {
        return false;
      }
    }
    return true;
  }

  private parseInventoryImportRow(
    row: any,
    rowNumber: number,
    headerMap: Map<InventoryImportField, number>,
    errors: InventoryExcelImportError[],
  ): ParsedInventoryImportRow | null {
    const name = this.getMappedCellText(row, headerMap, 'name');
    const unit = this.getMappedCellText(row, headerMap, 'unit');
    const categoryText = this.getMappedCellText(row, headerMap, 'category');
    const statusText = this.getMappedCellText(row, headerMap, 'status');
    const stockText = this.getMappedCellText(row, headerMap, 'stock');
    const minStockText = this.getMappedCellText(row, headerMap, 'minStockLevel');
    const costPriceText = this.getMappedCellText(row, headerMap, 'costPrice');
    const totalCostPriceText = this.getMappedCellText(row, headerMap, 'totalCostPrice');
    const provided = {
      stock: stockText !== '',
      minStockLevel: minStockText !== '',
      costPrice: costPriceText !== '',
      totalCostPrice: totalCostPriceText !== '',
      status: statusText !== '',
    };

    if (!name) {
      errors.push({ row: rowNumber, field: 'name', message: 'Ten nguyen lieu la bat buoc' });
    }
    if (!unit) {
      errors.push({ row: rowNumber, field: 'unit', message: 'Don vi tinh la bat buoc' });
    }

    const category = this.parseImportCategory(categoryText);
    if (!category) {
      errors.push({
        row: rowNumber,
        field: 'category',
        message: 'Danh muc khong hop le. Dung DRINK, FOOD, FRUIT hoac OTHER',
        value: categoryText,
      });
    }

    const status = this.parseImportStatus(statusText);
    if (!status) {
      errors.push({
        row: rowNumber,
        field: 'status',
        message: 'Trang thai khong hop le. Dung ACTIVE hoac HIDDEN',
        value: statusText,
      });
    }

    const stock = this.parseOptionalImportNumber(stockText, 0);
    if (stock === null || stock < 0) {
      errors.push({ row: rowNumber, field: 'stock', message: 'Ton kho phai la so khong am', value: stockText });
    }

    const minStockLevel = this.parseOptionalImportNumber(minStockText, 0);
    if (minStockLevel === null || minStockLevel < 0) {
      errors.push({
        row: rowNumber,
        field: 'minStockLevel',
        message: 'Nguong canh bao phai la so khong am',
        value: minStockText,
      });
    }

    let costPrice = this.parseOptionalImportNumber(costPriceText, 0);
    if ((costPrice === null || costPriceText === '') && totalCostPriceText) {
      const totalCostPrice = this.parseOptionalImportNumber(totalCostPriceText, 0);
      if (totalCostPrice === null || totalCostPrice < 0) {
        errors.push({
          row: rowNumber,
          field: 'totalCostPrice',
          message: 'Tong gia von ton kho phai la so khong am',
          value: totalCostPriceText,
        });
      } else if (stock && stock > 0) {
        costPrice = Number((totalCostPrice / stock).toFixed(4));
      } else if (totalCostPrice > 0) {
        errors.push({
          row: rowNumber,
          field: 'totalCostPrice',
          message: 'Can nhap ton kho ban dau lon hon 0 neu dung tong gia von',
          value: totalCostPriceText,
        });
      }
    }
    if (costPrice === null || costPrice < 0) {
      errors.push({
        row: rowNumber,
        field: 'costPrice',
        message: 'Gia von don vi phai la so khong am',
        value: costPriceText,
      });
    }

    if (errors.some((error) => error.row === rowNumber)) {
      return null;
    }

    return {
      rowNumber,
      dto: {
        name,
        unit,
        category: category as ItemCategory,
        stock: stock as number,
        minStockLevel: minStockLevel as number,
        costPrice: costPrice as number,
        sellingPrice: costPrice as number,
        status: status as ItemStatus,
      },
      provided,
    };
  }

  private getMappedCellText(row: any, headerMap: Map<InventoryImportField, number>, field: InventoryImportField): string {
    const colNumber = headerMap.get(field);
    if (!colNumber) {
      return '';
    }
    return this.getCellText(row.getCell(colNumber).value).trim();
  }

  private getCellText(value: any): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'object') {
      if ('result' in value) {
        return this.getCellText(value.result);
      }
      if ('text' in value) {
        return String(value.text || '');
      }
      if ('richText' in value && Array.isArray(value.richText)) {
        return value.richText.map((entry: any) => entry.text || '').join('');
      }
    }
    return String(value);
  }

  private parseImportCategory(value: string): ItemCategory | null {
    const key = this.normalizeImportKey(value);
    if (!key) {
      return null;
    }

    const map: Record<string, ItemCategory> = {
      drink: ItemCategory.DRINK,
      douong: ItemCategory.DRINK,
      douongnguyenlieu: ItemCategory.DRINK,
      trasua: ItemCategory.DRINK,
      cafe: ItemCategory.DRINK,
      coffee: ItemCategory.DRINK,
      food: ItemCategory.FOOD,
      doan: ItemCategory.FOOD,
      topping: ItemCategory.FOOD,
      banh: ItemCategory.FOOD,
      snack: ItemCategory.FOOD,
      fruit: ItemCategory.FRUIT,
      traicay: ItemCategory.FRUIT,
      hoaqua: ItemCategory.FRUIT,
      other: ItemCategory.OTHER,
      khac: ItemCategory.OTHER,
    };

    return map[key] || null;
  }

  private parseImportStatus(value: string): ItemStatus | null {
    const key = this.normalizeImportKey(value || ItemStatus.ACTIVE);
    if (!key) {
      return ItemStatus.ACTIVE;
    }

    const map: Record<string, ItemStatus> = {
      active: ItemStatus.ACTIVE,
      dangdung: ItemStatus.ACTIVE,
      hoatdong: ItemStatus.ACTIVE,
      danghoatdong: ItemStatus.ACTIVE,
      hidden: ItemStatus.HIDDEN,
      an: ItemStatus.HIDDEN,
      tamngung: ItemStatus.HIDDEN,
      ngungdung: ItemStatus.HIDDEN,
    };

    return map[key] || null;
  }

  private parseOptionalImportNumber(value: string, defaultValue: number): number | null {
    const raw = String(value || '').trim();
    if (!raw) {
      return defaultValue;
    }

    const numericText = raw.replace(/[^\d,.-]/g, '');
    if (!numericText) {
      return null;
    }

    const normalized = this.normalizeNumberText(numericText);
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private normalizeNumberText(value: string): string {
    const lastComma = value.lastIndexOf(',');
    const lastDot = value.lastIndexOf('.');

    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) {
        return value.replace(/\./g, '').replace(',', '.');
      }
      return value.replace(/,/g, '');
    }

    if (lastComma >= 0) {
      const fractionLength = value.length - lastComma - 1;
      return fractionLength === 3 ? value.replace(/,/g, '') : value.replace(',', '.');
    }

    if (lastDot >= 0) {
      const fractionLength = value.length - lastDot - 1;
      return fractionLength === 3 ? value.replace(/\./g, '') : value;
    }

    return value;
  }

  private normalizeImportKey(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  private normalizeComparableName(value: string): string {
    return this.normalizeImportKey(value).replace(/\s+/g, '');
  }

  private buildInsufficientStockException(detail: StockValidationDetail) {
    return new BadRequestException(detail);
  }
}
