import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PaymentMethod } from '../common/domain/payment-method';
import { CashierService } from './cashier.service';
import {
  CashMovementSourceType,
  CashMovementType,
} from './schemas/cash-movement.schema';
import { CashierShiftStatus } from './schemas/cashier-shift.schema';

function execResult<T>(value: T) {
  return {
    exec: jest.fn().mockResolvedValue(value),
  };
}

describe('CashierService', () => {
  const tenantId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const shiftId = new Types.ObjectId().toString();

  let shiftModel: any;
  let movementModel: any;
  let service: CashierService;

  beforeEach(() => {
    shiftModel = jest.fn().mockImplementation((payload) => ({
      _id: new Types.ObjectId(shiftId),
      ...payload,
      save: jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId(shiftId), ...payload }),
    }));
    shiftModel.findOne = jest.fn().mockReturnValue(execResult(null));
    shiftModel.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    });

    movementModel = jest.fn().mockImplementation((payload) => ({
      _id: new Types.ObjectId(),
      ...payload,
      save: jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId(), ...payload }),
    }));
    movementModel.findOne = jest.fn().mockReturnValue(execResult(null));
    movementModel.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    });

    service = new CashierService({} as any, shiftModel, movementModel);
  });

  it('blocks opening a second active shift', async () => {
    shiftModel.findOne.mockReturnValueOnce(execResult({ _id: shiftId }));

    await expect(service.openShift(tenantId, userId, 100000)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('requires sourceId for automatic movements', async () => {
    await expect(
      service.recordMovement({
        tenantId,
        shiftId,
        createdBy: userId,
        type: CashMovementType.MANUAL_CHECKOUT,
        amount: 22000,
        paymentMethod: PaymentMethod.CASH,
        sourceType: CashMovementSourceType.TABLE_SESSION,
      }),
    ).rejects.toThrow('sourceId is required');
  });

  it('returns existing movement on idempotent duplicate', async () => {
    const existing = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(tenantId),
      shiftId: new Types.ObjectId(shiftId),
      sourceType: CashMovementSourceType.TABLE_SESSION,
      sourceId: 'session-1',
      type: CashMovementType.MANUAL_CHECKOUT,
    };
    movementModel.mockImplementationOnce((payload) => ({
      ...payload,
      save: jest.fn().mockRejectedValue({ code: 11000 }),
    }));
    movementModel.findOne.mockReturnValueOnce(execResult(existing));

    await expect(
      service.recordMovement({
        tenantId,
        shiftId,
        createdBy: userId,
        type: CashMovementType.MANUAL_CHECKOUT,
        amount: 22000,
        paymentMethod: PaymentMethod.CASH,
        sourceType: CashMovementSourceType.TABLE_SESSION,
        sourceId: 'session-1',
      }),
    ).resolves.toBe(existing);
  });

  it('calculates expected cash from cash movements only', () => {
    const shift = {
      openingCash: 100000,
      status: CashierShiftStatus.OPEN,
    } as any;
    const movements = [
      {
        type: CashMovementType.CASH_IN,
        amount: 50000,
        paymentMethod: PaymentMethod.CASH,
      },
      {
        type: CashMovementType.MANUAL_CHECKOUT,
        amount: 22000,
        paymentMethod: PaymentMethod.PAYOS,
      },
      {
        type: CashMovementType.CASH_OUT,
        amount: 10000,
        paymentMethod: PaymentMethod.CASH,
      },
    ] as any[];

    expect(service.calculateExpectedCash(shift, movements)).toBe(140000);
  });
});
