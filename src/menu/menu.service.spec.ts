import { Types } from 'mongoose';
import { MenuService } from './menu.service';
import { MenuItemStatus } from './schemas/menu-item.schema';

function sortedExecResult<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

describe('MenuService', () => {
  let service: MenuService;
  let menuItemModel: jest.Mock & {
    countDocuments: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let menuRecipeModel: jest.Mock & {
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let inventoryModel: {
    find: jest.Mock;
  };

  beforeEach(() => {
    menuItemModel = jest.fn().mockImplementation((payload) => ({
      ...payload,
      save: jest.fn().mockResolvedValue(payload),
    })) as typeof menuItemModel;
    menuItemModel.countDocuments = jest.fn();
    menuItemModel.find = jest.fn();
    menuItemModel.findOne = jest.fn();
    menuItemModel.findOneAndUpdate = jest.fn();

    menuRecipeModel = jest.fn().mockImplementation((payload) => ({
      ...payload,
      save: jest.fn().mockResolvedValue(payload),
    })) as typeof menuRecipeModel;
    menuRecipeModel.find = jest.fn();
    menuRecipeModel.findOne = jest.fn();

    inventoryModel = {
      find: jest.fn(),
    };

    service = new MenuService(menuItemModel as never, menuRecipeModel as never, inventoryModel as never);
  });

  it('does not seed inventory items into an empty menu when listing menu items', async () => {
    const tenantId = new Types.ObjectId().toString();
    menuItemModel.find.mockReturnValue(sortedExecResult([]));

    const result = await service.findAllMenuItems(tenantId);

    expect(result).toEqual([]);
    expect(menuItemModel.find).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: expect.any(Types.ObjectId),
        status: { $ne: MenuItemStatus.DELETED },
      }),
    );
    expect(menuItemModel.countDocuments).not.toHaveBeenCalled();
    expect(inventoryModel.find).not.toHaveBeenCalled();
    expect(menuItemModel).not.toHaveBeenCalled();
    expect(menuRecipeModel).not.toHaveBeenCalled();
  });

  it('returns no availability rows when there are no explicit menu items', async () => {
    const tenantId = new Types.ObjectId().toString();
    menuItemModel.find.mockReturnValue(sortedExecResult([]));

    const result = await service.getAvailability(tenantId);

    expect(result).toEqual([]);
    expect(menuRecipeModel.find).not.toHaveBeenCalled();
    expect(inventoryModel.find).not.toHaveBeenCalled();
  });
});
