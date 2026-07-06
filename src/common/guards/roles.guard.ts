import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Role,
  User,
  UserDocument,
  UserStatus,
} from '../../users/schemas/user.schema';
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
  permissionVersion?: number;
  authVersion?: number;
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
  status?: UserStatus;
  permissionOverrides?: PermissionOverrides;
  permissionVersion?: number;
  authVersion?: number;
};

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

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
    if (user.tenantId) {
      if (Types.ObjectId.isValid(user.tenantId)) {
        query.tenantId = { $in: [new Types.ObjectId(user.tenantId), user.tenantId] };
      } else {
        query.tenantId = user.tenantId;
      }
    }

    const userDoc = (await this.userModel
      .findOne(query)
      .select(
        'role tenantId status permissionOverrides permissionVersion authVersion',
      )
      .lean()
      .exec()) as LeanPermissionUser | null;

    if (!userDoc) {
      this.logger.warn(`User not found for query: ${JSON.stringify(query)}`);
      throw new HttpException('RolesGuard: User not found', HttpStatus.UNAUTHORIZED);
    }
    if ((userDoc.status || UserStatus.ACTIVE) !== UserStatus.ACTIVE) {
      throw new HttpException(
        'Tai khoan khong con hoat dong',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if ((user.authVersion || 1) !== (userDoc.authVersion || 1)) {
      throw new HttpException(
        'Phien dang nhap da bi thu hoi',
        HttpStatus.UNAUTHORIZED,
      );
    }

    user.role = userDoc.role;
    user.tenantId = userDoc.tenantId
      ? userDoc.tenantId.toString()
      : user.tenantId;
    user.permissionOverrides = userDoc.permissionOverrides || {
      allow: [],
      deny: [],
    };
    user.permissionVersion = userDoc.permissionVersion || 1;
    user.authVersion = userDoc.authVersion || 1;
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
