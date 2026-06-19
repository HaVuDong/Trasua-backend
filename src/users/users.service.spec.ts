import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { Role } from './schemas/user.schema';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

function buildModelMock() {
  const model: any = jest.fn().mockImplementation((doc: any) => {
    const saved: any = {
      _id: new Types.ObjectId(),
      status: 'ACTIVE',
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

describe('UsersService role creation policy', () => {
  let service: UsersService;
  let userModel: any;

  beforeEach(() => {
    userModel = buildModelMock();
    service = new UsersService(userModel);
    jest.clearAllMocks();
  });

  it('allows ADMIN to create MANAGER, USER, and KITCHEN with unique email', async () => {
    const tenantId = new Types.ObjectId().toString();

    for (const role of [Role.MANAGER, Role.USER, Role.KITCHEN]) {
      const created = await service.create(
        tenantId,
        {
          name: `${role} Staff`,
          email: `${role.toLowerCase()}@example.com`,
          phone: '0900000000',
          role,
        },
        Role.ADMIN,
      );

      expect(created.email).toBe(`${role.toLowerCase()}@example.com`);
      expect(created.role).toBe(role);
      expect(created.tempPassword).toBeTruthy();
      expect(created.passwordHash).toBeUndefined();
    }

    expect(userModel).toHaveBeenCalledTimes(3);
    expect(bcrypt.hash).toHaveBeenCalledTimes(3);
  });

  it('blocks ADMIN from creating ADMIN or SYSTEM_OWNER', async () => {
    const tenantId = new Types.ObjectId().toString();

    await expect(
      service.create(tenantId, { name: 'Admin 2', email: 'admin2@example.com', role: Role.ADMIN }, Role.ADMIN),
    ).rejects.toThrow('Role khong hop le voi quyen hien tai');

    await expect(
      service.create(tenantId, { name: 'Owner', email: 'owner@example.com', role: Role.SYSTEM_OWNER }, Role.ADMIN),
    ).rejects.toThrow('Cannot create System Owner');

    expect(userModel.findOne).not.toHaveBeenCalled();
  });

  it('allows MANAGER to create USER and KITCHEN only', async () => {
    const tenantId = new Types.ObjectId().toString();

    await expect(
      service.create(tenantId, { name: 'User', email: 'user@example.com', role: Role.USER }, Role.MANAGER),
    ).resolves.toMatchObject({ email: 'user@example.com', role: Role.USER });

    await expect(
      service.create(tenantId, { name: 'Kitchen', email: 'kitchen@example.com', role: Role.KITCHEN }, Role.MANAGER),
    ).resolves.toMatchObject({ email: 'kitchen@example.com', role: Role.KITCHEN });

    await expect(
      service.create(tenantId, { name: 'Manager 2', email: 'manager2@example.com', role: Role.MANAGER }, Role.MANAGER),
    ).rejects.toThrow('Role khong hop le voi quyen hien tai');

    await expect(
      service.create(tenantId, { name: 'Admin', email: 'admin@example.com', role: Role.ADMIN }, Role.MANAGER),
    ).rejects.toThrow('Role khong hop le voi quyen hien tai');
  });

  it('requires globally unique normalized email', async () => {
    const tenantId = new Types.ObjectId().toString();
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(), email: 'used@example.com' }),
    });

    await expect(
      service.create(tenantId, { name: 'Used', email: 'USED@Example.com', role: Role.USER }, Role.ADMIN),
    ).rejects.toThrow('Email da duoc su dung');

    expect(userModel.findOne).toHaveBeenCalledWith({ email: 'used@example.com' });
  });

  it('marks reset password as temporary and clears trusted device state', async () => {
    const tenantId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    const userDoc = {
      passwordHash: 'old-hash',
      mustChangePassword: false,
      trustedDevices: [{ deviceId: 'trusted', userAgent: 'ua', ip: '1.1.1.1', lastLogin: new Date() }],
      localOtpCode: '123456',
      localOtpExpires: new Date(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.resetPassword(tenantId, userId);

    expect(result.tempPassword).toBeTruthy();
    expect(userDoc.passwordHash).toBe('hashed-password');
    expect(userDoc.mustChangePassword).toBe(true);
    expect(userDoc.trustedDevices).toEqual([]);
    expect(userDoc.localOtpCode).toBeUndefined();
    expect(userDoc.localOtpExpires).toBeUndefined();
    expect(userDoc.save).toHaveBeenCalled();
  });
});
