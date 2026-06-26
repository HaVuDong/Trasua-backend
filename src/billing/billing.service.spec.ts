import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Types } from 'mongoose';
import { BillingService } from './billing.service';
import {
  CustomerPaymentProvider,
  CustomerPaymentStatus,
} from '../orders/schemas/customer-payment.schema';
import {
  SubscriptionStatus,
  TenantStatus,
} from '../tenants/schemas/tenant.schema';

function execResult<T>(value: T) {
  return {
    exec: jest.fn().mockResolvedValue(value),
  };
}

function signPayosData(
  data: Record<string, unknown>,
  checksumKey: string,
): string {
  const rawData = Object.keys(data)
    .filter(
      (key) =>
        key !== 'signature' && data[key] !== undefined && data[key] !== null,
    )
    .sort()
    .map(
      (key) =>
        `${key}=${typeof data[key] === 'object' ? JSON.stringify(data[key]) : String(data[key])}`,
    )
    .join('&');

  return createHmac('sha256', checksumKey).update(rawData).digest('hex');
}

describe('BillingService payOS webhook', () => {
  let service: BillingService;
  let tenantModel: { findById: jest.Mock };
  let saasPaymentModel: { findOne: jest.Mock };
  let auditLogService: { logSystem: jest.Mock };

  beforeEach(() => {
    tenantModel = {
      findById: jest.fn(),
    };
    saasPaymentModel = {
      findOne: jest.fn(),
    };
    auditLogService = {
      logSystem: jest.fn().mockResolvedValue(undefined),
    };
    service = new BillingService(
      tenantModel as never,
      saasPaymentModel as never,
      auditLogService as never,
    );
    process.env.PAYOS_CHECKSUM_KEY = 'checksum';
  });

  it('marks SaaS payments paid idempotently and extends subscription once', async () => {
    const tenantId = new Types.ObjectId();
    const payment: any = {
      _id: new Types.ObjectId(),
      tenantId,
      plan: 'PRO',
      months: 1,
      amount: 399000,
      provider: CustomerPaymentProvider.PAYOS,
      status: CustomerPaymentStatus.PENDING,
      orderCode: 777001,
      save: jest.fn().mockImplementation(async () => payment),
    };
    const tenant: any = {
      _id: tenantId,
      name: 'Tra sua test',
      status: TenantStatus.ACTIVE,
      subscription: {
        plan: 'PRO',
        status: SubscriptionStatus.TRIALING,
        endDate: new Date('2026-06-20T00:00:00.000Z'),
      },
      paymentHistory: [],
      save: jest.fn().mockImplementation(async () => tenant),
    };
    saasPaymentModel.findOne.mockReturnValue(execResult(payment));
    tenantModel.findById.mockReturnValue(execResult(tenant));
    const data = { orderCode: payment.orderCode, code: '00' };
    const body = {
      data,
      success: true,
      signature: signPayosData(data, 'checksum'),
    };

    await service.handlePayosWebhookIfSaas(body);
    await service.handlePayosWebhookIfSaas(body);

    expect(payment.status).toBe(CustomerPaymentStatus.PAID);
    expect(payment.paidAt).toBeInstanceOf(Date);
    expect(tenant.subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(tenant.paymentHistory).toHaveLength(1);
    expect(tenant.save).toHaveBeenCalledTimes(1);
    expect(auditLogService.logSystem).toHaveBeenCalledTimes(1);
  });

  it('does not let cancelled webhook overwrite an already paid SaaS payment', async () => {
    const paidAt = new Date('2026-06-20T09:00:00.000Z');
    const payment: any = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(),
      plan: 'PRO',
      months: 1,
      amount: 399000,
      provider: CustomerPaymentProvider.PAYOS,
      status: CustomerPaymentStatus.PAID,
      paidAt,
      orderCode: 777002,
      save: jest.fn().mockImplementation(async () => payment),
    };
    saasPaymentModel.findOne.mockReturnValue(execResult(payment));
    const data = {
      orderCode: payment.orderCode,
      cancel: true,
      status: 'CANCELLED',
    };
    const body = {
      data,
      signature: signPayosData(data, 'checksum'),
    };

    await service.handlePayosWebhookIfSaas(body);

    expect(payment.status).toBe(CustomerPaymentStatus.PAID);
    expect(payment.paidAt).toBe(paidAt);
    expect(tenantModel.findById).not.toHaveBeenCalled();
    expect(auditLogService.logSystem).not.toHaveBeenCalled();
  });

  it('rejects invalid SaaS payOS webhook signatures', async () => {
    const body = {
      data: { orderCode: 777003, code: '00' },
      signature: 'bad-signature',
    };

    await expect(service.handlePayosWebhookIfSaas(body)).rejects.toThrow(
      BadRequestException,
    );
  });
});
