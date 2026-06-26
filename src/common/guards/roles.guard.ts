import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Role, User, UserDocument } from '../../users/schemas/user.schema';
import {
  Tenant,
  TenantDocument,
  TenantStatus,
  SubscriptionStatus,
} from '../../tenants/schemas/tenant.schema';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { Permission } from '../permissions/permission.enum';
import {
  getEffectivePermissions,
  PermissionOverrides,
} from '../permissions/permissions';

type AuthRequestUser = {
  userId?: string;
  role?: Role;
  tenantId?: string;
  permissionOverrides?: PermissionOverrides;
  effectivePermissions?: Permission[];
};

type GuardRequest = {
  user?: AuthRequestUser;
  route?: { path?: string };
  url?: string;
  originalUrl?: string;
};

type LeanPermissionUser = {
  role: Role;
  tenantId?: Types.ObjectId;
  permissionOverrides?: PermissionOverrides;
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @Optional() @InjectModel(User.name) private userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(Tenant.name)
    private tenantModel?: Model<TenantDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const { user } = request;

    if (!user?.role) return false;

    await this.resolveUserPermissionContext(user);
    await this.ensureTenantSubscriptionAllowed(user, request);

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles && !requiredPermissions) return true;

    // System Owner can access everything, unless restricted specifically (which usually isn't)
    if (user.role === Role.SYSTEM_OWNER) {
      return true;
    }

    if (requiredRoles && !requiredRoles.some((role) => user.role === role)) {
      return false;
    }

    if (requiredPermissions) {
      const effectivePermissions = Array.isArray(user.effectivePermissions)
        ? user.effectivePermissions
        : getEffectivePermissions(user.role, user.permissionOverrides);
      return requiredPermissions.every((permission) =>
        effectivePermissions.includes(permission),
      );
    }

    return true;
  }

  private async resolveUserPermissionContext(user: AuthRequestUser) {
    if (!user?.userId || user.role === Role.SYSTEM_OWNER) {
      if (user?.role) {
        user.effectivePermissions = getEffectivePermissions(
          user.role,
          user.permissionOverrides,
        );
      }
      return;
    }

    if (!this.userModel) {
      if (!user.role) return;
      user.effectivePermissions = getEffectivePermissions(
        user.role,
        user.permissionOverrides,
      );
      return;
    }

    const query: Record<string, unknown> = { _id: user.userId };
    if (user.tenantId && Types.ObjectId.isValid(user.tenantId)) {
      query.tenantId = new Types.ObjectId(user.tenantId);
    }

    const userDoc = (await this.userModel
      .findOne(query)
      .select('role tenantId permissionOverrides')
      .lean()
      .exec()) as LeanPermissionUser | null;

    if (!userDoc) return;

    user.role = userDoc.role;
    user.tenantId = userDoc.tenantId
      ? userDoc.tenantId.toString()
      : user.tenantId;
    user.permissionOverrides = userDoc.permissionOverrides || {
      allow: [],
      deny: [],
    };
    user.effectivePermissions = getEffectivePermissions(
      user.role,
      user.permissionOverrides,
    );
  }

  private async ensureTenantSubscriptionAllowed(
    user: AuthRequestUser,
    request: GuardRequest,
  ) {
    if (!user || user.role === Role.SYSTEM_OWNER || !user.tenantId) {
      return;
    }

    const path = String(request.route?.path || request.url || '');
    const originalUrl = String(request.originalUrl || request.url || '');
    const allowExpired =
      originalUrl.startsWith('/billing') ||
      path.includes('change-password') ||
      originalUrl.includes('/change-password');

    if (allowExpired) {
      return;
    }

    if (!this.tenantModel) {
      return;
    }

    if (!Types.ObjectId.isValid(user.tenantId)) {
      throw new HttpException(
        'Tenant khong hop le',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const tenant = await this.tenantModel
      .findById(user.tenantId)
      .select('status subscription')
      .lean()
      .exec();
    const subscription = tenant?.subscription;
    const statusAllowed = tenant?.status === TenantStatus.ACTIVE;
    const subscriptionStatusAllowed =
      subscription?.status === SubscriptionStatus.TRIALING ||
      subscription?.status === SubscriptionStatus.ACTIVE;
    const endDate = subscription?.endDate
      ? new Date(subscription.endDate).getTime()
      : 0;
    const endDateAllowed = endDate >= Date.now();

    if (!statusAllowed || !subscriptionStatusAllowed || !endDateAllowed) {
      throw new HttpException(
        'Goi dich vu cua cua hang da het han. Vui long gia han de tiep tuc su dung.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }
}
