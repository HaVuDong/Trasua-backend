import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InventoryService } from './inventory.service';
// @ts-ignore
import * as ExcelJS from 'exceljs';

function execResult<T>(value: T) {
  return {
    exec: jest.fn().mockResolvedValue(value),
  };
}

function selectLeanExecResult<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

function selectExecResult<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

async function createImportWorkbookBuffer(rows: any[][]) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Nguyen lieu');
  worksheet.addRow(['Ten nguyen lieu *', 'Don vi *', 'Danh muc *', 'Ton kho ban dau', 'Gia von don vi', 'Tong gia von ton kho', 'Nguong canh bao', 'Trang thai']);
  rows.forEach((row) => worksheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
}

describe('InventoryService stock and recipe safety', () => {
  let service: InventoryService;
  let itemModel: jest.Mock & {
    find: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    insertMany: jest.Mock;
  };
  let ticketModel: jest.Mock;
  let menuRecipeModel: {
    findOne: jest.Mock;
  };

  beforeEach(() => {
    itemModel = jest.fn() as typeof itemModel;
    itemModel.find = jest.fn();
    itemModel.findOne = jest.fn();
    itemModel.findOneAndUpdate = jest.fn();
    itemModel.insertMany = jest.fn();
    ticketModel = jest.fn().mockImplementation((payload) => ({
      ...payload,
      save: jest.fn().mockResolvedValue(payload),
    }));
    menuRecipeModel = {
      findOne: jest.fn(),
    };

    service = new InventoryService(itemModel as never, ticketModel as never, menuRecipeModel as never);
  });

  it('blocks deleting an ingredient used by an active recipe', async () => {
    const tenantId = new Types.ObjectId().toString();
    const itemId = new Types.ObjectId().toString();
    menuRecipeModel.findOne.mockReturnValue(selectLeanExecResult({ _id: new Types.ObjectId() }));

    await expect(service.deleteItem(tenantId, itemId)).rejects.toBeInstanceOf(BadRequestException);
    expect(itemModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('uses weighted average cost when importing stock', async () => {
    const tenantId = new Types.ObjectId().toString();
    const creatorId = new Types.ObjectId().toString();
    const itemId = new Types.ObjectId().toString();
    const itemDoc = {
      stock: 10,
      costPrice: 1000,
      save: jest.fn().mockResolvedValue(undefined),
    };
    itemModel.findOne.mockReturnValue(execResult(itemDoc));

    await service.importStock(tenantId, creatorId, {
      provider: 'Supplier',
      items: [{ itemId, quantity: 10, costPrice: 2000 }],
    });

    expect(itemDoc.stock).toBe(20);
    expect(itemDoc.costPrice).toBe(1500);
    expect(itemDoc.save).toHaveBeenCalled();
  });

  it('imports inventory ingredients from Excel', async () => {
    const tenantId = new Types.ObjectId().toString();
    const itemId = new Types.ObjectId();
    const buffer = await createImportWorkbookBuffer([
      ['Bot matcha', 'kg', 'DRINK', 5, 120000, '', 1, 'ACTIVE'],
    ]);

    itemModel.find.mockReturnValue(selectExecResult([]));
    itemModel.insertMany.mockResolvedValue([{ _id: itemId, name: 'Bot matcha' }]);

    const result = await service.importItemsFromExcel(tenantId, {
      originalname: 'inventory.xlsx',
      buffer,
    });

    expect(result.createdCount).toBe(1);
    expect(result.updatedCount).toBe(0);
    expect(itemModel.insertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: 'Bot matcha',
          unit: 'kg',
          category: 'DRINK',
          stock: 5,
          minStockLevel: 1,
          costPrice: 120000,
          sellingPrice: 120000,
          status: 'ACTIVE',
        }),
      ],
      { ordered: true },
    );
  });

  it('updates stock and weighted average cost when Excel row matches an existing ingredient', async () => {
    const tenantId = new Types.ObjectId().toString();
    const itemId = new Types.ObjectId();
    const buffer = await createImportWorkbookBuffer([
      ['Bot matcha', 'kg', 'DRINK', 10, 2000, '', 3, 'ACTIVE'],
    ]);
    const itemDoc = {
      _id: itemId,
      name: 'Bot matcha',
      unit: 'kg',
      category: 'DRINK',
      stock: 10,
      costPrice: 1000,
      sellingPrice: 1000,
      minStockLevel: 1,
      status: 'ACTIVE',
      save: jest.fn().mockResolvedValue(undefined),
    };

    itemModel.find.mockReturnValue(selectExecResult([itemDoc]));
    itemModel.insertMany.mockResolvedValue([]);

    const result = await service.importItemsFromExcel(tenantId, {
      originalname: 'inventory.xlsx',
      buffer,
    });

    expect(result.createdCount).toBe(0);
    expect(result.updatedCount).toBe(1);
    expect(itemDoc.stock).toBe(20);
    expect(itemDoc.costPrice).toBe(1500);
    expect(itemDoc.sellingPrice).toBe(1500);
    expect(itemDoc.minStockLevel).toBe(3);
    expect(itemDoc.save).toHaveBeenCalled();
    expect(itemModel.insertMany).not.toHaveBeenCalled();
  });

  it('rejects Excel import when an existing ingredient uses a different unit', async () => {
    const tenantId = new Types.ObjectId().toString();
    const buffer = await createImportWorkbookBuffer([
      ['Bot matcha', 'goi', 'DRINK', 5, 120000, '', 1, 'ACTIVE'],
    ]);
    const itemDoc = {
      _id: new Types.ObjectId(),
      name: 'Bot matcha',
      unit: 'kg',
      category: 'DRINK',
      stock: 10,
      costPrice: 1000,
      save: jest.fn().mockResolvedValue(undefined),
    };

    itemModel.find.mockReturnValue(selectExecResult([itemDoc]));

    await expect(
      service.importItemsFromExcel(tenantId, {
        originalname: 'inventory.xlsx',
        buffer,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(itemModel.insertMany).not.toHaveBeenCalled();
    expect(itemDoc.save).not.toHaveBeenCalled();
  });
});
