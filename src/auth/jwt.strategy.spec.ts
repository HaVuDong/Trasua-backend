import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { Role, UserStatus } from '../users/schemas/user.schema';

function createUserQuery(result: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  };
}

describe('JwtStrategy', () => {
  const userId = '507f1f77bcf86cd799439011';
  const tenantId = '507f1f77bcf86cd799439012';
  const baseUser = {
    _id: { toString: () => userId },
    email: 'staff@example.com',
    phone: '0900000000',
    role: Role.USER,
    tenantId: { toString: () => tenantId },
    status: UserStatus.ACTIVE,
    permissionOverrides: { allow: [], deny: [] },
    permissionVersion: 3,
    authVersion: 2,
  };

  let userModel: { findById: jest.Mock };
  let strategy: JwtStrategy;

  beforeEach(() => {
    userModel = {
      findById: jest.fn().mockReturnValue(createUserQuery(baseUser)),
    };
    strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('secret') } as any,
      userModel as any,
    );
  });

  it('rehydrates user, tenant, permissions and authVersion from DB', async () => {
    const result = await strategy.validate({
      sub: userId,
      email: 'stale@example.com',
      role: Role.ADMIN,
      tenantId,
      authVersion: 2,
    });

    expect(result).toMatchObject({
      userId,
      email: baseUser.email,
      phone: baseUser.phone,
      role: Role.USER,
      tenantId,
      permissionVersion: 3,
      authVersion: 2,
    });
    expect(result.effectivePermissions).toEqual(expect.any(Array));
  });

  it('rejects locked users', async () => {
    userModel.findById.mockReturnValueOnce(
      createUserQuery({ ...baseUser, status: UserStatus.LOCKED }),
    );

    await expect(
      strategy.validate({
        sub: userId,
        email: baseUser.email,
        role: Role.USER,
        tenantId,
        authVersion: 2,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects stale authVersion tokens', async () => {
    await expect(
      strategy.validate({
        sub: userId,
        email: baseUser.email,
        role: Role.USER,
        tenantId,
        authVersion: 1,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
