import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { Role } from './schemas/user.schema';
import { Permission } from '../common/permissions/permission.enum';

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
  model.find = jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue([]),
  });
  model.findOneAndUpdate = jest.fn().mockReturnValue({
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
      service.create(
        tenantId,
        { name: 'Admin 2', email: 'admin2@example.com', role: Role.ADMIN },
        Role.ADMIN,
      ),
    ).rejects.toThrow('Role khong hop le voi quyen hien tai');

    await expect(
      service.create(
        tenantId,
        { name: 'Owner', email: 'owner@example.com', role: Role.SYSTEM_OWNER },
        Role.ADMIN,
      ),
    ).rejects.toThrow('Cannot create System Owner');

    expect(userModel.findOne).not.toHaveBeenCalled();
  });

  it('allows MANAGER to create USER and KITCHEN only', async () => {
    const tenantId = new Types.ObjectId().toString();

    await expect(
      service.create(
        tenantId,
        { name: 'User', email: 'user@example.com', role: Role.USER },
        Role.MANAGER,
      ),
    ).resolves.toMatchObject({ email: 'user@example.com', role: Role.USER });

    await expect(
      service.create(
        tenantId,
        { name: 'Kitchen', email: 'kitchen@example.com', role: Role.KITCHEN },
        Role.MANAGER,
      ),
    ).resolves.toMatchObject({
      email: 'kitchen@example.com',
      role: Role.KITCHEN,
    });

    await expect(
      service.create(
        tenantId,
        {
          name: 'Manager 2',
          email: 'manager2@example.com',
          role: Role.MANAGER,
        },
        Role.MANAGER,
      ),
    ).rejects.toThrow('Role khong hop le voi quyen hien tai');

    await expect(
      service.create(
        tenantId,
        { name: 'Admin', email: 'admin@example.com', role: Role.ADMIN },
        Role.MANAGER,
      ),
    ).rejects.toThrow('Role khong hop le voi quyen hien tai');
  });

  it('requires globally unique normalized email', async () => {
    const tenantId = new Types.ObjectId().toString();
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        email: 'used@example.com',
      }),
    });

    await expect(
      service.create(
        tenantId,
        { name: 'Used', email: 'USED@Example.com', role: Role.USER },
        Role.ADMIN,
      ),
    ).rejects.toThrow('Email da duoc su dung');

    expect(userModel.findOne).toHaveBeenCalledWith({
      email: 'used@example.com',
    });
  });

  it('strips permission fields from generic user updates', async () => {
    const tenantId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    userModel.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: userId,
        name: 'Updated',
        role: Role.USER,
      }),
    });

    await service.updateUser(tenantId, userId, {
      name: 'Updated',
      permissionOverrides: { allow: [Permission.REPORT_VIEW] },
      permissionVersion: 99,
    });

    expect(userModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      {
        $set: {
          name: 'Updated',
        },
      },
      { new: true },
    );
  });

  it('marks reset password as temporary and clears trusted device state', async () => {
    const tenantId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    const userDoc = {
      passwordHash: 'old-hash',
      mustChangePassword: false,
      trustedDevices: [
        {
          deviceId: 'trusted',
          userAgent: 'ua',
          ip: '1.1.1.1',
          lastLogin: new Date(),
        },
      ],
      localOtpCode: '123456',
      localOtpExpires: new Date(),
      localOtpAttempts: 3,
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
    expect(userDoc.localOtpAttempts).toBe(0);
    expect(userDoc.save).toHaveBeenCalled();
  });

  it('updates allow and deny permission overrides with deny taking precedence', async () => {
    const tenantId = new Types.ObjectId().toString();
    const targetId = new Types.ObjectId();
    const adminId = new Types.ObjectId();
    const targetDoc: any = {
      _id: targetId,
      role: Role.USER,
      permissionOverrides: {},
      permissionVersion: 4,
      markModified: jest.fn(),
      save: jest.fn().mockImplementation(async function save(this: any) {
        return this;
      }),
    };
    const adminDoc = {
      _id: adminId,
      role: Role.ADMIN,
      permissionOverrides: {},
    };
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(targetDoc),
    });
    userModel.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([targetDoc, adminDoc]),
    });

    const updated = await service.updatePermissionOverrides(
      tenantId,
      targetId.toString(),
      adminId.toString(),
      {
        allow: [Permission.ORDER_DISCOUNT, Permission.REPORT_VIEW],
        deny: [Permission.REPORT_VIEW],
      },
    );

    expect(updated.permissionOverrides).toEqual({
      allow: [Permission.ORDER_DISCOUNT],
      deny: [Permission.REPORT_VIEW],
    });
    expect(targetDoc.markModified).toHaveBeenCalledWith('permissionOverrides');
    expect(updated.permissionVersion).toBe(5);
  });

  it('increments permission version when role changes', async () => {
    const tenantId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId();
    const userDoc: any = {
      _id: userId,
      role: Role.USER,
      permissionVersion: 8,
      save: jest.fn().mockImplementation(async function save(this: any) {
        return this;
      }),
    };
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const updated = await service.changeRole(
      tenantId,
      userId.toString(),
      Role.KITCHEN,
      Role.ADMIN,
    );

    expect(updated.role).toBe(Role.KITCHEN);
    expect(updated.permissionVersion).toBe(9);
    expect(userDoc.save).toHaveBeenCalled();
  });

  it('blocks self-denying the final permission management capability', async () => {
    const tenantId = new Types.ObjectId().toString();
    const adminId = new Types.ObjectId();
    const adminDoc: any = {
      _id: adminId,
      role: Role.ADMIN,
      permissionOverrides: {},
      markModified: jest.fn(),
      save: jest.fn(),
    };
    userModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(adminDoc),
    });

    await expect(
      service.updatePermissionOverrides(
        tenantId,
        adminId.toString(),
        adminId.toString(),
        { deny: [Permission.STAFF_PERMISSION_MANAGE] },
      ),
    ).rejects.toThrow('Khong the tu khoa quyen quan ly phan quyen');
    expect(adminDoc.save).not.toHaveBeenCalled();
  });
});
