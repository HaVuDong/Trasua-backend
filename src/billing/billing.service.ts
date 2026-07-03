import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, randomInt } from 'crypto';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument, TenantStatus, SubscriptionStatus } from '../tenants/schemas/tenant.schema';
import {
  CustomerPaymentProvider,
  CustomerPaymentStatus,
} from '../orders/schemas/customer-payment.schema';
import { getSaasPlan } from './saas-plans';
import { SaasPayment, SaasPaymentDocument } from './schemas/saas-payment.schema';
import { AuditLogService } from '../common/services/audit-log.service';

@Injectable()
export class BillingService {
  constructor(
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    @InjectModel(SaasPayment.name) private saasPaymentModel: Model<SaasPaymentDocument>,
    private auditLogService: AuditLogService,
  ) {}

  private assertPayosConfigured() {
    if (!process.env.PAYOS_CLIENT_ID || !process.env.PAYOS_API_KEY || !process.env.PAYOS_CHECKSUM_KEY) {
      throw new BadRequestException('payOS is not configured');
    }
  }

  private addMonths(date: Date, months: number) {
    const nextDate = new Date(date);
    nextDate.setMonth(nextDate.getMonth() + months);
    return nextDate;
  }

  private createPayosSignature(data: Record<string, unknown>, checksumKey: string): string {
    const rawData = Object.keys(data)
      .filter((key) => key !== 'signature' && data[key] !== undefined && data[key] !== null)
      .sort()
      .map((key) => `${key}=${this.stringifyPayosValue(data[key])}`)
      .join('&');

    return createHmac('sha256', checksumKey).update(rawData).digest('hex');
  }

  private stringifyPayosValue(value: unknown): string {
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    }
    return String(value);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private getOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private async generateUniquePayosOrderCode(): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const orderCode = Date.now() * 1000 + randomInt(0, 1000);
      const exists = await this.saasPaymentModel.exists({ orderCode }).exec();
      if (!exists) return orderCode;
    }
    throw new BadRequestException('Unable to generate payment order code');
  }

  private toPublicPayment(payment: SaasPaymentDocument | any) {
    return {
      paymentId: payment._id.toString(),
      provider: payment.provider,
      status: payment.status,
      orderCode: payment.orderCode,
      amount: payment.amount,
      plan: payment.plan,
      months: payment.months,
      description: payment.description,
      checkoutUrl: payment.checkoutUrl,
      qrCode: payment.qrCode,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
    };
  }

  async getBillingMe(tenantId: string) {
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    const plan = getSaasPlan(tenant.subscription?.plan);
    const endDate = tenant.subscription?.endDate ? new Date(tenant.subscription.endDate) : null;
    const daysRemaining = endDate
      ? Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : 0;
    const latestPayments = await this.saasPaymentModel.find({ tenantId: new Types.ObjectId(tenantId) })
      .sort({ createdAt: -1 })
      .limit(5)
      .exec();

    return {
      tenant: {
        _id: tenant._id.toString(),
        name: tenant.name,
        status: tenant.status,
      },
      subscription: tenant.subscription,
      plan,
      daysRemaining,
      payments: latestPayments.map((payment) => this.toPublicPayment(payment)),
    };
  }

  async createPayosPayment(tenantId: string, months = 1) {
    const normalizedMonths = Number(months || 1);
    if (!Number.isInteger(normalizedMonths) || normalizedMonths <= 0 || normalizedMonths > 12) {
      throw new BadRequestException('So thang thanh toan khong hop le');
    }

    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    const plan = getSaasPlan(tenant.subscription?.plan);
    const amount = plan.priceMonthly * normalizedMonths;
    this.assertPayosConfigured();

    const orderCode = await this.generateUniquePayosOrderCode();
    const description = `TraSua SaaS ${plan.id}`;
    const payment = new this.saasPaymentModel({
      tenantId: tenant._id as Types.ObjectId,
      plan: plan.id,
      months: normalizedMonths,
      amount,
      provider: CustomerPaymentProvider.PAYOS,
      status: CustomerPaymentStatus.PENDING,
      orderCode,
      description,
    });
    const savedPayment = await payment.save();

    try {
      const providerResponse = await this.createPayosPaymentRequest({
        orderCode,
        amount,
        description,
      });
      savedPayment.providerResponse = providerResponse;
      savedPayment.providerPaymentLinkId = this.getOptionalString(providerResponse.paymentLinkId);
      savedPayment.checkoutUrl = this.getOptionalString(providerResponse.checkoutUrl);
      savedPayment.qrCode = this.getOptionalString(providerResponse.qrCode);

      const providerStatus = this.getOptionalString(providerResponse.status)?.toUpperCase();
      if (providerStatus === CustomerPaymentStatus.PAID) {
        savedPayment.status = CustomerPaymentStatus.PAID;
        savedPayment.paidAt = new Date();
        await this.applyPaidSubscription(savedPayment);
      }

      const updatedPayment = await savedPayment.save();
      return this.toPublicPayment(updatedPayment);
    } catch (error) {
      savedPayment.status = CustomerPaymentStatus.FAILED;
      await savedPayment.save();
      throw error;
    }
  }

  async getPaymentStatus(paymentId: string, tenantId: string) {
    if (!Types.ObjectId.isValid(paymentId)) {
      throw new BadRequestException('Invalid payment');
    }
    let payment = await this.saasPaymentModel.findOne({
      _id: new Types.ObjectId(paymentId),
      tenantId: new Types.ObjectId(tenantId),
    }).exec();
    if (!payment) throw new NotFoundException('Payment not found');

    if (payment.status === CustomerPaymentStatus.PENDING) {
      payment = (await this.syncPayosPayment(payment)) as any;
    }

    return this.toPublicPayment(payment);
  }

  private async syncPayosPayment(payment: SaasPaymentDocument): Promise<SaasPaymentDocument> {
    try {
      const paymentIdOrCode = payment.providerPaymentLinkId || payment.orderCode;
      const response = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${paymentIdOrCode}`, {
        method: 'GET',
        headers: {
          'x-client-id': process.env.PAYOS_CLIENT_ID || '',
          'x-api-key': process.env.PAYOS_API_KEY || '',
        },
      });

      if (response.ok) {
        const body = await response.json();
        const data = this.asRecord(body?.data);
        const providerStatus = this.getOptionalString(data?.status)?.toUpperCase();
        
        if (providerStatus === 'PAID') {
          payment.status = CustomerPaymentStatus.PAID;
          payment.paidAt = payment.paidAt || new Date();
          await this.applyPaidSubscription(payment);
          
          await this.auditLogService.logSystem(payment.tenantId.toString(), 'SAAS_PAYMENT_PAID_SYNC', {
            paymentId: payment._id.toString(),
            orderCode: payment.orderCode,
            amount: payment.amount,
            plan: payment.plan,
            months: payment.months,
            provider: payment.provider,
          });
          
          await payment.save();
        } else if (providerStatus === 'CANCELLED') {
          payment.status = CustomerPaymentStatus.CANCELLED;
          await payment.save();
        }
      }
    } catch (error) {
      // Ignore sync errors and just return current payment state
    }
    return payment;
  }

  async handlePayosWebhookIfSaas(body: Record<string, unknown>) {
    const data = this.asRecord(body?.data);
    const receivedSignature = typeof body?.signature === 'string' ? body.signature : '';
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY;

    if (!checksumKey || !receivedSignature) {
      throw new BadRequestException('Invalid payOS webhook signature');
    }

    const expectedSignature = this.createPayosSignature(data, checksumKey);
    if (expectedSignature !== receivedSignature) {
      throw new BadRequestException('Invalid payOS webhook signature');
    }

    const orderCode = Number(data.orderCode);
    if (!Number.isFinite(orderCode)) {
      throw new BadRequestException('Invalid payOS order code');
    }

    const payment = await this.saasPaymentModel.findOne({ orderCode }).exec();
    if (!payment) {
      return { handled: false };
    }

    payment.webhookPayload = body;
    const webhookCode = String(data.code || body.code || '');
    const isPaid = body.success === true || webhookCode === '00';
    const isCancelled = data.cancel === true || String(data.status || '').toUpperCase() === 'CANCELLED';

    if (isPaid) {
      const wasAlreadyPaid = payment.status === CustomerPaymentStatus.PAID;
      payment.status = CustomerPaymentStatus.PAID;
      payment.paidAt = payment.paidAt || new Date();
      if (!wasAlreadyPaid) {
        await this.applyPaidSubscription(payment);
        await this.auditLogService.logSystem(payment.tenantId.toString(), 'SAAS_PAYMENT_PAID', {
          paymentId: payment._id.toString(),
          orderCode: payment.orderCode,
          amount: payment.amount,
          plan: payment.plan,
          months: payment.months,
          provider: payment.provider,
        });
      }
    } else if (isCancelled && payment.status !== CustomerPaymentStatus.PAID) {
      payment.status = CustomerPaymentStatus.CANCELLED;
    }

    await payment.save();
    return { handled: true, response: { success: true } };
  }

  private async applyPaidSubscription(payment: SaasPaymentDocument) {
    const tenant = await this.tenantModel.findById(payment.tenantId).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    const plan = getSaasPlan(payment.plan);
    const now = new Date();
    const currentEndDate = tenant.subscription?.endDate ? new Date(tenant.subscription.endDate) : now;
    const baseDate = currentEndDate.getTime() > now.getTime() ? currentEndDate : now;
    const nextEndDate = this.addMonths(baseDate, payment.months);

    tenant.status = TenantStatus.ACTIVE;
    tenant.subscription = {
      ...(tenant.subscription || ({} as any)),
      plan: plan.id,
      status: SubscriptionStatus.ACTIVE,
      startDate: tenant.subscription?.startDate || now,
      endDate: nextEndDate,
      trialEndsAt: tenant.subscription?.trialEndsAt,
      amount: plan.priceMonthly,
      currency: plan.currency,
      billingCycle: plan.billingCycle,
      lastPaymentAt: now,
    };
    tenant.paymentHistory = tenant.paymentHistory || [];
    tenant.paymentHistory.push({
      date: now,
      amount: payment.amount,
      durationMonths: payment.months,
      performedBy: 'payOS',
      notes: `${plan.id} subscription payment`,
    });

    await tenant.save();
  }

  private async createPayosPaymentRequest(payload: {
    orderCode: number;
    amount: number;
    description: string;
  }): Promise<Record<string, unknown>> {
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY || '';
    const requestBody: Record<string, unknown> = {
      orderCode: payload.orderCode,
      amount: payload.amount,
      description: payload.description,
      returnUrl: process.env.SAAS_PAYOS_RETURN_URL || 'https://app-ql-tra-sua.vercel.app',
      cancelUrl: process.env.SAAS_PAYOS_CANCEL_URL || 'https://app-ql-tra-sua.vercel.app',
    };
    requestBody.signature = this.createPayosSignature(requestBody, checksumKey);

    const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': process.env.PAYOS_CLIENT_ID || '',
        'x-api-key': process.env.PAYOS_API_KEY || '',
      },
      body: JSON.stringify(requestBody),
    });

    const responseBody = await response.json().catch(() => ({}));
    const responseRecord = this.asRecord(responseBody);
    const responseCode = this.getOptionalString(responseRecord.code);

    if (!response.ok || (responseCode && responseCode !== '00')) {
      const message = this.getOptionalString(responseRecord.desc)
        || this.getOptionalString(responseRecord.message)
        || 'Unable to create payOS payment';
      throw new BadRequestException(message);
    }

    return this.asRecord(responseRecord.data);
  }
}
