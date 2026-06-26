import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Types } from 'mongoose';
import { Role } from '../../users/schemas/user.schema';
import {
  SubscriptionStatus,
  TenantStatus,
} from '../../tenants/schemas/tenant.schema';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { Permission } from '../permissions/permission.enum';
import { RolesGuard } from './roles.guard';

function createQueryResult(result: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  };
}

function createContext(user: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn().mockReturnValue({
        user,
        route: { path: '/orders' },
        url: '/orders',
        originalUrl: '/orders',
      }),
    }),
  } as unknown as ExecutionContext;
}

function createTenant(overrides: Record<string, unknown> = {}) {
  return {
    status: TenantStatus.ACTIVE,
    subscription: {
      status: SubscriptionStatus.ACTIVE,
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    ...overrides,
  };
}

describe('RolesGuard permissions', () => {
  const tenantId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

  function createGuard(options: {
    roles?: Role[];
    permissions?: Permission[];
    userDoc?: Record<string, unknown>;
    tenant?: Record<string, unknown> | null;
  }) {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === ROLES_KEY) return options.roles;
        if (key === PERMISSIONS_KEY) return options.permissions;
        return undefined;
      }),
    } as unknown as Reflector;

    const userModel = {
      findOne: jest.fn().mockReturnValue(
        createQueryResult(
          options.userDoc || {
            _id: userId,
            tenantId,
            role: Role.USER,
            permissionOverrides: { allow: [], deny: [] },
          },
        ),
      ),
    };

    const tenantModel = {
      findById: jest
        .fn()
        .mockReturnValue(createQueryResult(options.tenant ?? createTenant())),
    };

    return new RolesGuard(reflector, userModel as any, tenantModel as any);
  }

  it('blocks USER direct API access without required permission', async () => {
    const guard = createGuard({
      roles: [Role.USER],
      permissions: [Permission.REPORT_VIEW],
      userDoc: {
        _id: userId,
        tenantId,
        role: Role.USER,
        permissionOverrides: { allow: [], deny: [] },
      },
    });

    await expect(
      guard.canActivate(createContext({ userId, tenantId, role: Role.USER })),
    ).resolves.toBe(false);
  });

  it('allows ADMIN because role default has full permissions', async () => {
    const guard = createGuard({
      roles: [Role.ADMIN],
      permissions: [Permission.PAYROLL_CONFIRM],
      userDoc: {
        _id: userId,
        tenantId,
        role: Role.ADMIN,
        permissionOverrides: { allow: [], deny: [] },
      },
    });

    await expect(
      guard.canActivate(createContext({ userId, tenantId, role: Role.ADMIN })),
    ).resolves.toBe(true);
  });

  it('honors allow override and deny override precedence', async () => {
    const allowGuard = createGuard({
      roles: [Role.USER],
      permissions: [Permission.ORDER_DISCOUNT],
      userDoc: {
        _id: userId,
        tenantId,
        role: Role.USER,
        permissionOverrides: { allow: [Permission.ORDER_DISCOUNT], deny: [] },
      },
    });
    const denyGuard = createGuard({
      roles: [Role.MANAGER],
      permissions: [Permission.REPORT_VIEW],
      userDoc: {
        _id: userId,
        tenantId,
        role: Role.MANAGER,
        permissionOverrides: { allow: [], deny: [Permission.REPORT_VIEW] },
      },
    });

    await expect(
      allowGuard.canActivate(
        createContext({ userId, tenantId, role: Role.USER }),
      ),
    ).resolves.toBe(true);
    await expect(
      denyGuard.canActivate(
        createContext({ userId, tenantId, role: Role.MANAGER }),
      ),
    ).resolves.toBe(false);
  });

  it('blocks expired tenants before permissions reach the handler', async () => {
    const guard = createGuard({
      roles: [Role.USER],
      permissions: [Permission.INVOICE_VIEW],
      tenant: createTenant({
        subscription: {
          status: SubscriptionStatus.EXPIRED,
          endDate: new Date(Date.now() - 1000),
        },
      }),
    });

    await expect(
      guard.canActivate(createContext({ userId, tenantId, role: Role.USER })),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
