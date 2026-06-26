import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { Role, UserStatus } from '../users/schemas/user.schema';
import { Permission } from '../common/permissions/permission.enum';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

function buildUserDoc(overrides: Partial<any> = {}) {
  const now = new Date();
  return {
    _id: new Types.ObjectId(),
    email: 'admin@example.com',
    phone: '0123456789',
    role: Role.ADMIN,
    tenantId: new Types.ObjectId(),
    passwordHash: 'hashed',
    status: UserStatus.ACTIVE,
    trustedDevices: [],
    loginAttempts: 0,
    lockUntil: undefined,
    mustChangePassword: false,
    permissionVersion: 1,
    localOtpCode: undefined,
    localOtpExpires: undefined,
    localOtpAttempts: 0,
    save: jest.fn().mockResolvedValue(undefined),
    markModified: jest.fn(),
    toObject: function toObject() {
      return {
        _id: this._id,
        email: this.email,
        phone: this.phone,
        role: this.role,
        tenantId: this.tenantId,
        passwordHash: this.passwordHash,
        status: this.status,
        trustedDevices: this.trustedDevices,
        loginAttempts: this.loginAttempts,
        lockUntil: this.lockUntil,
        mustChangePassword: this.mustChangePassword,
        permissionVersion: this.permissionVersion,
      };
    },
    ...overrides,
    createdAt: now,
    updatedAt: now,
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let userModel: any;
  let jwtService: any;
  let auditLogService: any;
  let emailService: any;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    userModel = {
      findOne: jest.fn(),
      findById: jest.fn(),
    };
    jwtService = {
      sign: jest.fn().mockReturnValue('signed-token'),
    };
    auditLogService = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    emailService = {
      shouldSkipDeviceOtp: jest.fn().mockReturnValue(false),
      sendDeviceOtp: jest
        .fn()
        .mockResolvedValue({ delivered: false, devOtp: '123456' }),
    };
    service = new AuthService(
      userModel,
      jwtService,
      auditLogService,
      emailService,
    );
    jest.clearAllMocks();
    (bcrypt.hash as jest.Mock).mockImplementation(
      async (value: string) => `hashed:${value}`,
    );
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('validateUser checks email only', async () => {
    userModel.findOne.mockResolvedValue(null);

    await expect(
      service.validateUser('a@example.com', 'Admin@123'),
    ).rejects.toThrow('Invalid credentials');

    expect(userModel.findOne).toHaveBeenCalledWith({ email: 'a@example.com' });
  });

  it('requires OTP for ADMIN on new device', async () => {
    const userDoc = buildUserDoc({
      role: Role.ADMIN,
      trustedDevices: [
        {
          deviceId: 'old-device',
          userAgent: 'old',
          ip: '1.1.1.1',
          lastLogin: new Date(),
        },
      ],
    });
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.checkDeviceAndLogin(
      { _id: userDoc._id.toString() },
      'new-device',
      'test-agent',
      '2.2.2.2',
    );

    expect(result.requiresDeviceVerification).toBe(true);
    expect(result.userId).toBe(userDoc._id.toString());
    expect(result.devOtp).toBe('123456');
    expect(emailService.sendDeviceOtp).toHaveBeenCalledWith(
      userDoc.email,
      expect.stringMatching(/^\d{6}$/),
      undefined,
    );
    expect(
      userDoc.trustedDevices.some((d: any) => d.deviceId === 'new-device'),
    ).toBe(false);
    expect(userDoc.save).toHaveBeenCalled();
  });

  it('keeps OTP flow for MANAGER on new device', async () => {
    const userDoc = buildUserDoc({
      role: Role.MANAGER,
      trustedDevices: [
        {
          deviceId: 'old-device',
          userAgent: 'old',
          ip: '1.1.1.1',
          lastLogin: new Date(),
        },
      ],
    });
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.checkDeviceAndLogin(
      { _id: userDoc._id.toString() },
      'new-device',
      'test-agent',
      '2.2.2.2',
    );

    expect(result.requiresDeviceVerification).toBe(true);
    expect(result.userId).toBe(userDoc._id.toString());
    expect(userDoc.localOtpCode).toMatch(/^hashed:\d{6}$/);
    expect(userDoc.localOtpAttempts).toBe(0);
    expect(userDoc.localOtpExpires).toBeInstanceOf(Date);
    expect(emailService.sendDeviceOtp).toHaveBeenCalledWith(
      userDoc.email,
      expect.stringMatching(/^\d{6}$/),
      undefined,
    );
  });

  it('trusts new device immediately when device OTP is disabled', async () => {
    emailService.shouldSkipDeviceOtp.mockReturnValue(true);
    const userDoc = buildUserDoc({
      role: Role.USER,
      trustedDevices: [],
    });
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.checkDeviceAndLogin(
      { _id: userDoc._id.toString() },
      'new-device',
      'test-agent',
      '2.2.2.2',
    );

    expect(result.access_token).toBe('signed-token');
    expect(emailService.sendDeviceOtp).not.toHaveBeenCalled();
    expect(userDoc.trustedDevices).toHaveLength(1);
    expect(userDoc.trustedDevices[0]).toMatchObject({
      deviceId: 'new-device',
      userAgent: 'test-agent',
      ip: '2.2.2.2',
    });
  });

  it('requires OTP for first login device', async () => {
    const userDoc = buildUserDoc({
      role: Role.USER,
      trustedDevices: [],
    });
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.checkDeviceAndLogin(
      { _id: userDoc._id.toString() },
      'new-device',
      'test-agent',
      '2.2.2.2',
    );

    expect(result.requiresDeviceVerification).toBe(true);
    expect(result.userId).toBe(userDoc._id.toString());
    expect(userDoc.trustedDevices).toEqual([]);
  });

  it('requires OTP again for legacy trusted devices that were never OTP verified', async () => {
    const userDoc = buildUserDoc({
      role: Role.ADMIN,
      trustedDevices: [
        {
          deviceId: 'legacy-bypassed-device',
          userAgent: 'old',
          ip: '1.1.1.1',
          lastLogin: new Date(),
        },
      ],
    });
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.checkDeviceAndLogin(
      { _id: userDoc._id.toString() },
      'legacy-bypassed-device',
      'test-agent',
      '2.2.2.2',
    );

    expect(result.requiresDeviceVerification).toBe(true);
    expect(emailService.sendDeviceOtp).toHaveBeenCalledWith(
      userDoc.email,
      expect.stringMatching(/^\d{6}$/),
      undefined,
    );
  });

  it('logs in directly for devices already verified by OTP', async () => {
    const userDoc = buildUserDoc({
      role: Role.ADMIN,
      trustedDevices: [
        {
          deviceId: 'otp-verified-device',
          userAgent: 'old',
          ip: '1.1.1.1',
          lastLogin: new Date(),
          verifiedAt: new Date(),
          trustMethod: 'OTP',
        },
      ],
    });
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.checkDeviceAndLogin(
      { _id: userDoc._id.toString() },
      'otp-verified-device',
      'test-agent',
      '2.2.2.2',
    );

    expect(result.access_token).toBe('signed-token');
    expect(emailService.sendDeviceOtp).not.toHaveBeenCalled();
    expect(userDoc.trustedDevices[0]).toMatchObject({
      userAgent: 'test-agent',
      ip: '2.2.2.2',
    });
  });

  it('includes effective permissions in access tokens', async () => {
    const userDoc = buildUserDoc({
      role: Role.MANAGER,
      permissionOverrides: {
        allow: [Permission.PAYROLL_CONFIRM],
        deny: [Permission.REPORT_VIEW],
      },
      permissionVersion: 7,
      trustedDevices: [
        {
          deviceId: 'otp-verified-device',
          userAgent: 'old',
          ip: '1.1.1.1',
          lastLogin: new Date(),
          verifiedAt: new Date(),
          trustMethod: 'OTP',
        },
      ],
    });
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    await service.checkDeviceAndLogin(
      { _id: userDoc._id.toString() },
      'otp-verified-device',
      'test-agent',
      '2.2.2.2',
    );

    const payload = jwtService.sign.mock.calls[0][0];
    expect(payload.effectivePermissions).toContain(Permission.PAYROLL_CONFIRM);
    expect(payload.effectivePermissions).not.toContain(Permission.REPORT_VIEW);
    expect(payload.permissionVersion).toBe(7);
  });

  it('returns a fresh permission snapshot from the database', async () => {
    const userDoc = buildUserDoc({
      role: Role.USER,
      permissionVersion: 3,
      permissionOverrides: {
        allow: [Permission.ORDER_DISCOUNT],
        deny: [],
      },
    });
    userModel.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.getPermissionSnapshot(userDoc._id.toString());

    expect(result).toEqual({
      userId: userDoc._id.toString(),
      role: Role.USER,
      tenantId: userDoc.tenantId.toString(),
      effectivePermissions: expect.arrayContaining([Permission.ORDER_DISCOUNT]),
      permissionVersion: 3,
    });
  });

  it('returns password-change token after OTP when user must change password', async () => {
    const userDoc = buildUserDoc({
      role: Role.USER,
      mustChangePassword: true,
      localOtpCode: 'hashed:123456',
      localOtpExpires: new Date(Date.now() + 60000),
      trustedDevices: [],
    });
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });

    const result = await service.verifyDevice(
      userDoc._id.toString(),
      '123456',
      'new-device',
      'test-agent',
      '2.2.2.2',
    );

    expect(result.requiresPasswordChange).toBe(true);
    expect(result.tempToken).toBe('signed-token');
    expect(jwtService.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'password_change',
        tenantId: userDoc.tenantId.toString(),
      }),
      { expiresIn: '5m' },
    );
    expect(userDoc.trustedDevices).toHaveLength(1);
    expect(userDoc.trustedDevices[0]).toMatchObject({
      verifiedAt: expect.any(Date),
      trustMethod: 'OTP',
    });
    expect(userDoc.localOtpCode).toBeUndefined();
    expect(userDoc.localOtpExpires).toBeUndefined();
    expect(userDoc.localOtpAttempts).toBe(0);
  });

  it('expires device OTP after too many wrong attempts', async () => {
    const userDoc = buildUserDoc({
      localOtpCode: 'hashed:123456',
      localOtpExpires: new Date(Date.now() + 60000),
      localOtpAttempts: 4,
      trustedDevices: [],
    });
    userModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(userDoc),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

    await expect(
      service.verifyDevice(
        userDoc._id.toString(),
        '000000',
        'new-device',
        'test-agent',
        '2.2.2.2',
      ),
    ).rejects.toThrow('OTP code has expired');

    expect(userDoc.localOtpCode).toBeUndefined();
    expect(userDoc.localOtpExpires).toBeUndefined();
    expect(userDoc.localOtpAttempts).toBe(0);
    expect(userDoc.trustedDevices).toHaveLength(0);
    expect(userDoc.save).toHaveBeenCalled();
  });

  it('validateUser resets attempts when password matches', async () => {
    const userDoc = buildUserDoc({
      loginAttempts: 3,
      lockUntil: new Date(Date.now() - 10000),
    });
    userModel.findOne.mockResolvedValue(userDoc);
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await service.validateUser('admin@example.com', 'Admin@123');

    expect(result.email).toBe('admin@example.com');
    expect(userDoc.loginAttempts).toBe(0);
    expect(userDoc.lockUntil).toBeUndefined();
    expect(userDoc.save).toHaveBeenCalled();
  });
});
