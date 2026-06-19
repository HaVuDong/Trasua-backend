import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Role } from '../../users/schemas/user.schema';
import { Tenant, TenantDocument, TenantStatus, SubscriptionStatus } from '../../tenants/schemas/tenant.schema';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @Optional() @InjectModel(Tenant.name) private tenantModel?: Model<TenantDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const { user } = request;

    await this.ensureTenantSubscriptionAllowed(user, request);

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) {
      return true;
    }

    // System Owner can access everything, unless restricted specifically (which usually isn't)
    if (user.role === Role.SYSTEM_OWNER) {
      return true;
    }

    return requiredRoles.some((role) => user.role === role);
  }

  private async ensureTenantSubscriptionAllowed(user: any, request: any) {
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
      throw new HttpException('Tenant khong hop le', HttpStatus.PAYMENT_REQUIRED);
    }

    const tenant = await this.tenantModel.findById(user.tenantId).select('status subscription').lean().exec();
    const subscription = tenant?.subscription;
    const statusAllowed = tenant?.status === TenantStatus.ACTIVE;
    const subscriptionStatusAllowed =
      subscription?.status === SubscriptionStatus.TRIALING ||
      subscription?.status === SubscriptionStatus.ACTIVE;
    const endDate = subscription?.endDate ? new Date(subscription.endDate).getTime() : 0;
    const endDateAllowed = endDate >= Date.now();

    if (!statusAllowed || !subscriptionStatusAllowed || !endDateAllowed) {
      throw new HttpException(
        'Goi dich vu cua cua hang da het han. Vui long gia han de tiep tuc su dung.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }
}
