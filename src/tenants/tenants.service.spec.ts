import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { TenantsService } from './tenants.service';
import { TenantStatus } from './schemas/tenant.schema';
import { Role } from '../users/schemas/user.schema';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

function buildModelMock() {
  const model: any = jest.fn().mockImplementation((doc: any) => {
    const saved: any = {
      _id: new Types.ObjectId(),
      ...doc,
      save: jest.fn(),
      toObject() {
        const { save, toObject, ...data } = this;
        return data;
      },
    };
    saved.save.mockResolvedValue(saved);
    return saved;
  });

  model.findOne = jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue(null),
  });

  return model;
}

describe('TenantsService createTenant', () => {
  let service: TenantsService;
  let tenantModel: any;
  let userModel: any;

  beforeEach(() => {
    tenantModel = buildModelMock();
    userModel = buildModelMock();
    service = new TenantsService(tenantModel, userModel);
    jest.clearAllMocks();
  });

  it('creates a tenant first, then creates the first ADMIN with the new tenantId', async () => {
    const result = await service.createTenant({
      name: 'Milk Tea One',
      slug: 'milk-tea-one',
      address: '123 Street',
      phone: '0900000000',
      status: TenantStatus.ACTIVE,
      subscriptionPlan: 'PRO',
      subscriptionDurationMonths: 6,
      admin: {
        name: 'Store Admin',
        email: 'Admin@One.Example',
        phone: '0911111111',
        password: 'Temp@123456',
      },
    });

    expect(tenantModel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Milk Tea One',
        subdomain: 'milk-tea-one',
        address: '123 Street',
        ownerName: 'Store Admin',
        email: 'admin@one.example',
        phone: '0900000000',
        status: TenantStatus.ACTIVE,
      }),
    );
    expect(userModel).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: result.tenant._id,
        name: 'Store Admin',
        email: 'admin@one.example',
        phone: '0911111111',
        role: Role.ADMIN,
        mustChangePassword: true,
      }),
    );
    expect(result.admin.tenantId).toBe(result.tenant._id);
    expect(result.admin.passwordHash).toBeUndefined();
    expect(result.tempPassword).toBe('Temp@123456');
    expect(bcrypt.hash).toHaveBeenCalledWith('Temp@123456', 10);
  });

  it('blocks duplicate admin email before creating tenant', async () => {
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(), email: 'admin@example.com' }),
    });

    await expect(
      service.createTenant({
        name: 'Duplicate Shop',
        phone: '0900000000',
        admin: {
          name: 'Admin',
          email: 'admin@example.com',
        },
      }),
    ).rejects.toThrow('Email admin da duoc su dung');

    expect(tenantModel).not.toHaveBeenCalled();
  });
});
