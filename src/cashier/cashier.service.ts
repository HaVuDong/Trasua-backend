import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { assertIntegerVnd } from '../common/domain/money';
import { PaymentMethod } from '../common/domain/payment-method';
import { runTransactionSensitive } from '../common/domain/transaction';
import {
  CashierShift,
  CashierShiftDocument,
  CashierShiftStatus,
} from './schemas/cashier-shift.schema';
import {
  CashMovement,
  CashMovementDocument,
  CashMovementSourceType,
  CashMovementType,
} from './schemas/cash-movement.schema';

type CreateMovementInput = {
  tenantId: string;
  shiftId: string;
  type: CashMovementType;
  amount: number;
  paymentMethod: PaymentMethod;
  sourceType: CashMovementSourceType;
  sourceId?: string;
  reason?: string;
  createdBy: string;
  session?: ClientSession;
};

@Injectable()
export class CashierService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(CashierShift.name)
    private shiftModel: Model<CashierShiftDocument>,
    @InjectModel(CashMovement.name)
    private movementModel: Model<CashMovementDocument>,
  ) {}

  private toObjectId(value: string, message: string) {
    if (!Types.ObjectId.isValid(value)) throw new BadRequestException(message);
    return new Types.ObjectId(value);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      (error as { code?: number }).code === 11000,
    );
  }

  private applySession<T>(query: T, session?: ClientSession): T {
    if (
      session &&
      query &&
      typeof (query as { session?: unknown }).session === 'function'
    ) {
      (query as unknown as { session: (session: ClientSession) => T }).session(
        session,
      );
    }
    return query;
  }

  async openShift(tenantId: string, openedBy: string, openingCash = 0) {
    assertIntegerVnd(openingCash, 'openingCash');
    const tenantObjectId = this.toObjectId(tenantId, 'Tenant khong hop le');
    const userObjectId = this.toObjectId(openedBy, 'Nguoi mo ca khong hop le');

    const existing = await this.shiftModel
      .findOne({ tenantId: tenantObjectId, status: CashierShiftStatus.OPEN })
      .exec();
    if (existing) throw new BadRequestException('Dang co ca quay dang mo');

    try {
      return await new this.shiftModel({
        tenantId: tenantObjectId,
        status: CashierShiftStatus.OPEN,
        openedBy: userObjectId,
        openingCash,
        openedAt: new Date(),
      }).save();
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new BadRequestException('Dang co ca quay dang mo');
      }
      throw error;
    }
  }

  async getCurrentShift(tenantId: string) {
    const tenantObjectId = this.toObjectId(tenantId, 'Tenant khong hop le');
    const shift = await this.shiftModel
      .findOne({ tenantId: tenantObjectId, status: CashierShiftStatus.OPEN })
      .exec();
    if (!shift) return null;
    const movements = await this.movementModel
      .find({ tenantId: tenantObjectId, shiftId: shift._id })
      .sort({ createdAt: 1 })
      .exec();
    return this.toShiftSummary(shift, movements);
  }

  async requireOpenShift(
    tenantId: string,
    session?: ClientSession,
    userRole?: string,
  ): Promise<CashierShiftDocument | null> {
    const query = this.shiftModel.findOne({
      tenantId: this.toObjectId(tenantId, 'Tenant khong hop le'),
      status: CashierShiftStatus.OPEN,
    });
    this.applySession(query, session);
    const shift = await query.exec();
    if (!shift) {
      if (userRole === 'ADMIN') return null;
      throw new BadRequestException('Can mo ca quay truoc khi thanh toan');
    }
    return shift;
  }

  async recordMovement(
    input: CreateMovementInput,
  ): Promise<CashMovementDocument> {
    assertIntegerVnd(input.amount, 'amount');
    if (input.sourceType !== CashMovementSourceType.MANUAL && !input.sourceId) {
      throw new BadRequestException(
        'sourceId is required for automatic cash movements',
      );
    }

    const tenantObjectId = this.toObjectId(
      input.tenantId,
      'Tenant khong hop le',
    );
    const shiftObjectId = this.toObjectId(
      input.shiftId,
      'Ca quay khong hop le',
    );
    const createdByObjectId = this.toObjectId(
      input.createdBy,
      'Nguoi thao tac khong hop le',
    );
    const movement = new this.movementModel({
      tenantId: tenantObjectId,
      shiftId: shiftObjectId,
      type: input.type,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      reason: input.reason,
      createdBy: createdByObjectId,
    });

    try {
      return await movement.save(
        input.session ? { session: input.session } : undefined,
      );
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      const query = this.movementModel.findOne({
        tenantId: tenantObjectId,
        shiftId: shiftObjectId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        type: input.type,
      });
      this.applySession(query, input.session);
      const existing = await query.exec();
      if (!existing) throw error;
      return existing;
    }
  }

  async createManualMovement(
    tenantId: string,
    shiftId: string,
    createdBy: string,
    dto: any,
  ) {
    const shift = await this.shiftModel
      .findOne({
        _id: this.toObjectId(shiftId, 'Ca quay khong hop le'),
        tenantId: this.toObjectId(tenantId, 'Tenant khong hop le'),
        status: CashierShiftStatus.OPEN,
      })
      .exec();
    if (!shift) throw new NotFoundException('Ca quay dang mo khong ton tai');

    return this.recordMovement({
      tenantId,
      shiftId,
      createdBy,
      type: dto?.type,
      amount: Number(dto?.amount || 0),
      paymentMethod: dto?.paymentMethod || PaymentMethod.CASH,
      sourceType: CashMovementSourceType.MANUAL,
      sourceId: dto?.sourceId,
      reason: dto?.reason,
    });
  }

  async closeShift(
    tenantId: string,
    shiftId: string,
    closedBy: string,
    countedCash: number,
    differenceReason?: string,
  ) {
    assertIntegerVnd(countedCash, 'countedCash');

    return runTransactionSensitive(
      this.connection,
      async (session) => {
        const tenantObjectId = this.toObjectId(tenantId, 'Tenant khong hop le');
        const shift = await this.shiftModel
          .findOne({
            _id: this.toObjectId(shiftId, 'Ca quay khong hop le'),
            tenantId: tenantObjectId,
            status: CashierShiftStatus.OPEN,
          })
          .session(session)
          .exec();
        if (!shift)
          throw new NotFoundException('Ca quay dang mo khong ton tai');

        const movements = await this.movementModel
          .find({ tenantId: tenantObjectId, shiftId: shift._id })
          .session(session)
          .exec();
        const expectedCash = this.calculateExpectedCash(shift, movements);
        shift.status = CashierShiftStatus.CLOSED;
        shift.closedBy = this.toObjectId(
          closedBy,
          'Nguoi dong ca khong hop le',
        );
        shift.closedAt = new Date();
        shift.expectedCashSnapshot = expectedCash;
        shift.countedCash = countedCash;
        shift.cashDifference = countedCash - expectedCash;
        shift.differenceReason = differenceReason;
        return shift.save({ session });
      },
      `close cashier shift ${shiftId}`,
    );
  }

  async getHistory(tenantId: string, limit = 30) {
    return this.shiftModel
      .find({ tenantId: this.toObjectId(tenantId, 'Tenant khong hop le') })
      .sort({ openedAt: -1 })
      .limit(Math.max(1, Math.min(100, limit)))
      .exec();
  }

  calculateExpectedCash(
    shift: CashierShiftDocument | CashierShift,
    movements: CashMovement[],
  ) {
    return movements.reduce((sum, movement) => {
      if (movement.paymentMethod !== PaymentMethod.CASH) return sum;
      if (
        movement.type === CashMovementType.CASH_IN ||
        movement.type === CashMovementType.MANUAL_CHECKOUT
      ) {
        return sum + movement.amount;
      }
      if (
        movement.type === CashMovementType.CASH_OUT ||
        movement.type === CashMovementType.REFUND
      ) {
        return sum - movement.amount;
      }
      if (movement.type === CashMovementType.ADJUSTMENT) {
        return sum + movement.amount;
      }
      return sum;
    }, shift.openingCash || 0);
  }

  toShiftSummary(shift: CashierShiftDocument, movements: CashMovement[]) {
    const summary = movements.reduce(
      (acc, movement) => {
        acc.total += movement.amount;
        if (movement.paymentMethod === PaymentMethod.CASH)
          acc.cash += movement.amount;
        if (movement.paymentMethod === PaymentMethod.BANK_TRANSFER)
          acc.bankTransfer += movement.amount;
        if (movement.paymentMethod === PaymentMethod.PAYOS)
          acc.payos += movement.amount;
        if (movement.paymentMethod === PaymentMethod.OTHER)
          acc.other += movement.amount;
        return acc;
      },
      { total: 0, cash: 0, bankTransfer: 0, payos: 0, other: 0 },
    );

    return {
      shift,
      movements,
      summary: {
        ...summary,
        expectedCash: this.calculateExpectedCash(shift, movements),
      },
    };
  }
}
