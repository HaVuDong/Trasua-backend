import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PaymentMethod } from '../common/domain/payment-method';
import { OrderItemStatus, OrderStatus } from '../orders/schemas/order.schema';
import {
  TableSessionPaymentMethod,
  TableSessionPaymentStatus,
} from '../orders/schemas/table-session.schema';
import { InvoicesService } from './invoices.service';
import { InvoicePaymentStatus, InvoiceStatus } from './schemas/invoice.schema';
import {
  PrintJobSchema,
  PrintJobStatus,
  PrintJobType,
} from './schemas/print-job.schema';

function execResult<T>(value: T) {
  return {
    exec: jest.fn().mockResolvedValue(value),
  };
}

function sessionQuery<T>(value: T) {
  return {
    session: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

describe('InvoicesService', () => {
  const tenantId = new Types.ObjectId().toString();
  const sessionId = new Types.ObjectId().toString();
  const tableId = new Types.ObjectId();
  const userId = new Types.ObjectId().toString();
  const invoiceId = new Types.ObjectId().toString();

  let connection: any;
  let invoiceModel: any;
  let invoiceCounterModel: any;
  let printJobModel: any;
  let tableSessionModel: any;
  let tableModel: any;
  let orderModel: any;
  let service: InvoicesService;

  beforeEach(() => {
    const mongoSession = {
      withTransaction: jest.fn(async (callback) => callback()),
      endSession: jest.fn(),
    };
    connection = {
      startSession: jest.fn().mockResolvedValue(mongoSession),
    };

    invoiceModel = jest.fn().mockImplementation((payload) => ({
      _id: new Types.ObjectId(invoiceId),
      ...payload,
      save: jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId(invoiceId), ...payload }),
    }));
    invoiceModel.findOne = jest.fn();

    invoiceCounterModel = {
      findOneAndUpdate: jest
        .fn()
        .mockReturnValue(sessionQuery({ sequence: 7 })),
    };

    printJobModel = jest.fn().mockImplementation((payload) => ({
      _id: new Types.ObjectId(),
      ...payload,
      save: jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId(), ...payload }),
    }));
    printJobModel.findOne = jest.fn();
    printJobModel.find = jest.fn();
    printJobModel.findOneAndUpdate = jest.fn();

    tableSessionModel = {
      findOne: jest.fn().mockReturnValue(
        sessionQuery({
          _id: new Types.ObjectId(sessionId),
          tenantId: new Types.ObjectId(tenantId),
          tableId,
          customerName: 'Dong',
          customerPhone: '0900000000',
          paymentStatus: TableSessionPaymentStatus.PAID,
          paymentMethod: TableSessionPaymentMethod.TRANSFER,
        }),
      ),
    };
    tableModel = {
      findOne: jest
        .fn()
        .mockReturnValue(sessionQuery({ _id: tableId, name: 'Ban 1' })),
    };
    orderModel = {
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          {
            _id: new Types.ObjectId(),
            status: OrderStatus.IN_PROGRESS,
            totalAmount: 22000,
            discount: 0,
            vat: 0,
            serviceCharge: 0,
            finalAmount: 22000,
            items: [
              {
                itemId: new Types.ObjectId(),
                menuItemNameSnapshot: 'Tra sua truyen thong',
                quantity: 1,
                price: 22000,
                status: OrderItemStatus.PREPARING,
              },
            ],
          },
        ]),
      }),
    };

    service = new InvoicesService(
      connection,
      invoiceModel,
      invoiceCounterModel,
      printJobModel,
      tableSessionModel,
      tableModel,
      orderModel,
    );
  });

  it('enforces one open print job per invoice and type at schema level', () => {
    expect(PrintJobSchema.indexes()).toContainEqual([
      { tenantId: 1, invoiceId: 1, type: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: {
          status: { $in: [PrintJobStatus.REQUESTED, PrintJobStatus.PRINTING] },
        },
      }),
    ]);
  });

  it('creates an immutable bill snapshot with a tenant daily invoice number', async () => {
    const invoice = await service.createForTableSession(
      tenantId,
      sessionId,
      userId,
    );

    expect(invoice.invoiceNumber).toMatch(/^INV-\d{8}-000007$/);
    expect(invoice.itemSnapshot).toEqual([
      expect.objectContaining({
        nameSnapshot: 'Tra sua truyen thong',
        quantity: 1,
        unitPrice: 22000,
        lineTotal: 22000,
      }),
    ]);
    expect(invoice.paymentStatus).toBe(InvoicePaymentStatus.PAID);
    expect(invoice.paymentMethod).toBe(PaymentMethod.BANK_TRANSFER);
  });

  it('returns the open print job instead of creating duplicates', async () => {
    const invoice = {
      _id: new Types.ObjectId(invoiceId),
      tenantId: new Types.ObjectId(tenantId),
      sessionId: new Types.ObjectId(sessionId),
      status: InvoiceStatus.ISSUED,
    };
    const existing = {
      _id: new Types.ObjectId(),
      invoiceId: invoice._id,
      status: PrintJobStatus.REQUESTED,
    };
    invoiceModel.findOne.mockReturnValueOnce(execResult(invoice));
    printJobModel.findOne.mockReturnValueOnce({
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(existing),
    });

    await expect(
      service.requestPrintJob(tenantId, invoiceId, userId, PrintJobType.BILL),
    ).resolves.toBe(existing);
    expect(printJobModel).not.toHaveBeenCalled();
  });

  it('rejects invalid print job transitions', async () => {
    printJobModel.findOne.mockReturnValueOnce(
      execResult({
        _id: new Types.ObjectId(),
        tenantId: new Types.ObjectId(tenantId),
        status: PrintJobStatus.PRINTED,
      }),
    );

    await expect(
      service.updatePrintJobStatus(
        tenantId,
        new Types.ObjectId().toString(),
        userId,
        PrintJobStatus.REQUESTED,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('claims requested print jobs atomically', async () => {
    const job = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(tenantId),
      status: PrintJobStatus.REQUESTED,
    };
    const updated = { ...job, status: PrintJobStatus.PRINTING };
    printJobModel.findOne.mockReturnValueOnce(execResult(job));
    printJobModel.findOneAndUpdate.mockReturnValueOnce(execResult(updated));

    await expect(
      service.updatePrintJobStatus(
        tenantId,
        job._id.toString(),
        userId,
        PrintJobStatus.PRINTING,
      ),
    ).resolves.toBe(updated);

    expect(printJobModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: job._id,
        status: PrintJobStatus.REQUESTED,
      }),
      expect.any(Object),
      { new: true },
    );
  });
});
