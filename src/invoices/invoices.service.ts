import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { PaymentMethod } from '../common/domain/payment-method';
import { runTransactionSensitive } from '../common/domain/transaction';
import {
  Order,
  OrderDocument,
  OrderItemStatus,
  OrderStatus,
} from '../orders/schemas/order.schema';
import {
  TableSession,
  TableSessionDocument,
  TableSessionPaymentMethod,
  TableSessionPaymentStatus,
} from '../orders/schemas/table-session.schema';
import { Table, TableDocument } from '../tables/schemas/table.schema';
import {
  Invoice,
  InvoiceDocument,
  InvoicePaymentStatus,
  InvoiceStatus,
} from './schemas/invoice.schema';
import {
  InvoiceCounter,
  InvoiceCounterDocument,
} from './schemas/invoice-counter.schema';
import {
  OPEN_PRINT_JOB_STATUSES,
  PrintJob,
  PrintJobDocument,
  PrintJobStatus,
  PrintJobType,
} from './schemas/print-job.schema';

@Injectable()
export class InvoicesService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Invoice.name) private invoiceModel: Model<InvoiceDocument>,
    @InjectModel(InvoiceCounter.name)
    private invoiceCounterModel: Model<InvoiceCounterDocument>,
    @InjectModel(PrintJob.name) private printJobModel: Model<PrintJobDocument>,
    @InjectModel(TableSession.name)
    private tableSessionModel: Model<TableSessionDocument>,
    @InjectModel(Table.name) private tableModel: Model<TableDocument>,
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
  ) {}

  private toObjectId(value: string, message: string): Types.ObjectId {
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

  private vietnamDateKey(date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(date)
      .replace(/-/g, '');
  }

  private async nextInvoiceNumber(
    tenantId: Types.ObjectId,
    session: ClientSession,
  ): Promise<string> {
    const dateKey = this.vietnamDateKey();
    const counter = await this.invoiceCounterModel
      .findOneAndUpdate(
        { tenantId, dateKey },
        { $inc: { sequence: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .session(session)
      .exec();

    if (!counter) {
      throw new BadRequestException('Khong the tao so phieu tinh tien');
    }

    return `INV-${dateKey}-${String(counter.sequence).padStart(6, '0')}`;
  }

  async createForTableSession(
    tenantId: string,
    sessionId: string,
    issuedBy: string,
  ): Promise<InvoiceDocument> {
    return runTransactionSensitive(
      this.connection,
      async (session) => {
        const tenantObjectId = this.toObjectId(tenantId, 'Tenant khong hop le');
        const sessionObjectId = this.toObjectId(
          sessionId,
          'Phien ban khong hop le',
        );
        const issuedByObjectId = this.toObjectId(
          issuedBy,
          'Nguoi tao phieu khong hop le',
        );

        const tableSession = await this.tableSessionModel
          .findOne({ _id: sessionObjectId, tenantId: tenantObjectId })
          .session(session)
          .exec();
        if (!tableSession)
          throw new NotFoundException('Khong tim thay phien ban');

        const table = await this.tableModel
          .findOne({ _id: tableSession.tableId, tenantId: tenantObjectId })
          .session(session)
          .exec();
        if (!table) throw new NotFoundException('Khong tim thay ban');

        const orders = await this.orderModel
          .find({
            tenantId: tenantObjectId,
            sessionId: sessionObjectId,
            status: {
              $in: [
                OrderStatus.PENDING,
                OrderStatus.IN_PROGRESS,
                OrderStatus.COMPLETED,
              ],
            },
          })
          .sort({ createdAt: 1 })
          .session(session)
          .exec();

        if (orders.length === 0) {
          throw new BadRequestException('Phien ban chua co don de lap phieu');
        }

        const itemSnapshot = this.buildItemSnapshot(orders);
        if (itemSnapshot.length === 0) {
          throw new BadRequestException(
            'Phien ban chua co mon hop le de lap phieu',
          );
        }

        const invoiceNumber = await this.nextInvoiceNumber(
          tenantObjectId,
          session,
        );
        const subtotal = orders.reduce(
          (sum, order) => sum + Math.round(Number(order.totalAmount || 0)),
          0,
        );
        const discount = orders.reduce(
          (sum, order) => sum + Math.round(Number(order.discount || 0)),
          0,
        );
        const vat = orders.reduce(
          (sum, order) => sum + Math.round(Number(order.vat || 0)),
          0,
        );
        const serviceCharge = orders.reduce(
          (sum, order) => sum + Math.round(Number(order.serviceCharge || 0)),
          0,
        );
        const finalAmount = orders.reduce(
          (sum, order) => sum + Math.round(Number(order.finalAmount || 0)),
          0,
        );

        return new this.invoiceModel({
          tenantId: tenantObjectId,
          invoiceNumber,
          status: InvoiceStatus.ISSUED,
          sessionId: sessionObjectId,
          tableId: table._id,
          orderIds: orders.map((order) => order._id),
          customerSnapshot: {
            name: tableSession.customerName,
            phone: tableSession.customerPhone,
          },
          itemSnapshot,
          subtotal,
          discount,
          vat,
          serviceCharge,
          finalAmount,
          paymentMethod: this.mapPaymentMethod(tableSession.paymentMethod),
          paymentStatus:
            tableSession.paymentStatus === TableSessionPaymentStatus.PAID
              ? InvoicePaymentStatus.PAID
              : InvoicePaymentStatus.PENDING,
          issuedBy: issuedByObjectId,
          issuedAt: new Date(),
        }).save({ session });
      },
      `create invoice for table session ${sessionId}`,
    );
  }

  async getInvoice(
    tenantId: string,
    invoiceId: string,
  ): Promise<InvoiceDocument> {
    const invoice = await this.invoiceModel
      .findOne({
        _id: this.toObjectId(invoiceId, 'Phieu tinh tien khong hop le'),
        tenantId: this.toObjectId(tenantId, 'Tenant khong hop le'),
      })
      .exec();
    if (!invoice) throw new NotFoundException('Khong tim thay phieu tinh tien');
    return invoice;
  }

  async getLatestForSession(
    tenantId: string,
    sessionId: string,
  ): Promise<InvoiceDocument | null> {
    return this.invoiceModel
      .findOne({
        tenantId: this.toObjectId(tenantId, 'Tenant khong hop le'),
        sessionId: this.toObjectId(sessionId, 'Phien ban khong hop le'),
      })
      .sort({ issuedAt: -1 })
      .exec();
  }

  async requestPrintJob(
    tenantId: string,
    invoiceId: string,
    requestedBy: string,
    type: PrintJobType = PrintJobType.BILL,
  ): Promise<PrintJobDocument> {
    if (!Object.values(PrintJobType).includes(type)) {
      throw new BadRequestException('Loai lenh in khong hop le');
    }

    const invoice = await this.getInvoice(tenantId, invoiceId);
    if (invoice.status !== InvoiceStatus.ISSUED) {
      throw new BadRequestException('Chi co the in phieu dang hop le');
    }

    const existing = await this.findOpenPrintJob(tenantId, invoiceId, type);
    if (existing) return existing;

    try {
      return await new this.printJobModel({
        tenantId: invoice.tenantId,
        invoiceId: invoice._id,
        sessionId: invoice.sessionId,
        type,
        status: PrintJobStatus.REQUESTED,
        requestedBy: this.toObjectId(
          requestedBy,
          'Nguoi yeu cau in khong hop le',
        ),
      }).save();
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      const duplicate = await this.findOpenPrintJob(tenantId, invoiceId, type);
      if (!duplicate) throw error;
      return duplicate;
    }
  }

  async getPrintQueue(tenantId: string, status?: PrintJobStatus) {
    const query: Record<string, unknown> = {
      tenantId: this.toObjectId(tenantId, 'Tenant khong hop le'),
    };
    if (status) {
      if (!Object.values(PrintJobStatus).includes(status)) {
        throw new BadRequestException('Trang thai lenh in khong hop le');
      }
      query.status = status;
    } else {
      query.status = {
        $in: [
          PrintJobStatus.REQUESTED,
          PrintJobStatus.PRINTING,
          PrintJobStatus.FAILED,
        ],
      };
    }

    return this.printJobModel
      .find(query)
      .populate('invoiceId')
      .sort({ createdAt: 1 })
      .exec();
  }

  async updatePrintJobStatus(
    tenantId: string,
    jobId: string,
    handledBy: string,
    status: PrintJobStatus,
    errorMessage?: string,
  ): Promise<PrintJobDocument> {
    if (!Object.values(PrintJobStatus).includes(status)) {
      throw new BadRequestException('Trang thai lenh in khong hop le');
    }

    const tenantObjectId = this.toObjectId(tenantId, 'Tenant khong hop le');
    const jobObjectId = this.toObjectId(jobId, 'Lenh in khong hop le');
    const job = await this.printJobModel
      .findOne({ _id: jobObjectId, tenantId: tenantObjectId })
      .exec();
    if (!job) throw new NotFoundException('Khong tim thay lenh in');

    this.assertPrintTransition(job.status, status);

    const update: Record<string, unknown> = {
      $set: {
        status,
        handledBy: this.toObjectId(handledBy, 'Nguoi xu ly in khong hop le'),
      },
    };

    if (status === PrintJobStatus.FAILED) {
      (update.$set as Record<string, unknown>).errorMessage =
        errorMessage || 'In that bai';
    } else if (status === PrintJobStatus.REQUESTED) {
      update.$unset = { errorMessage: 1, handledBy: 1 };
    } else {
      update.$unset = { errorMessage: 1 };
    }

    const updated = await this.printJobModel
      .findOneAndUpdate(
        { _id: jobObjectId, tenantId: tenantObjectId, status: job.status },
        update,
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new BadRequestException('Lenh in da duoc xu ly boi nguoi khac');
    }
    return updated;
  }

  private buildItemSnapshot(orders: OrderDocument[]) {
    return orders.flatMap((order) =>
      order.items
        .filter((item) => item.status !== OrderItemStatus.CANCELLED)
        .map((item: any) => {
          const isFree = Boolean(order.isFree || item.isFree);
          const quantity = Number(item.quantity || 0);
          const unitPrice = isFree ? 0 : Math.round(Number(item.price || 0));
          return {
            itemId: item.itemId,
            nameSnapshot:
              item.menuItemNameSnapshot ||
              item.itemId?.name ||
              item.itemId?.toString?.() ||
              'Mon',
            quantity,
            unitPrice,
            lineTotal: Math.round(quantity * unitPrice),
            note: item.note,
          };
        }),
    );
  }

  private mapPaymentMethod(
    paymentMethod?: TableSessionPaymentMethod,
  ): PaymentMethod | undefined {
    if (paymentMethod === TableSessionPaymentMethod.CASH)
      return PaymentMethod.CASH;
    if (paymentMethod === TableSessionPaymentMethod.TRANSFER) {
      return PaymentMethod.BANK_TRANSFER;
    }
    if (paymentMethod === TableSessionPaymentMethod.MANUAL)
      return PaymentMethod.CASH;
    return undefined;
  }

  private async findOpenPrintJob(
    tenantId: string,
    invoiceId: string,
    type: PrintJobType,
  ) {
    return this.printJobModel
      .findOne({
        tenantId: this.toObjectId(tenantId, 'Tenant khong hop le'),
        invoiceId: this.toObjectId(invoiceId, 'Phieu tinh tien khong hop le'),
        type,
        status: { $in: [...OPEN_PRINT_JOB_STATUSES] },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  private assertPrintTransition(from: PrintJobStatus, to: PrintJobStatus) {
    if (from === to) return;
    const allowed: Record<PrintJobStatus, PrintJobStatus[]> = {
      [PrintJobStatus.REQUESTED]: [
        PrintJobStatus.PRINTING,
        PrintJobStatus.CANCELLED,
      ],
      [PrintJobStatus.PRINTING]: [
        PrintJobStatus.PRINTED,
        PrintJobStatus.FAILED,
      ],
      [PrintJobStatus.FAILED]: [PrintJobStatus.REQUESTED],
      [PrintJobStatus.PRINTED]: [],
      [PrintJobStatus.CANCELLED]: [],
    };

    if (!allowed[from].includes(to)) {
      throw new BadRequestException(
        `Khong the doi lenh in tu ${from} sang ${to}`,
      );
    }
  }
}
