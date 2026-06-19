import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InventoryService } from './inventory.service';

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

describe('InventoryService stock and recipe safety', () => {
  let service: InventoryService;
  let itemModel: jest.Mock & {
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let ticketModel: jest.Mock;
  let menuRecipeModel: {
    findOne: jest.Mock;
  };

  beforeEach(() => {
    itemModel = jest.fn() as typeof itemModel;
    itemModel.findOne = jest.fn();
    itemModel.findOneAndUpdate = jest.fn();
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
});
