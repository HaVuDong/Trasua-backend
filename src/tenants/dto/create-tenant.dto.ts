import { TenantStatus } from '../schemas/tenant.schema';

export class CreateTenantAdminDto {
  name: string;
  email: string;
  phone?: string;
  password?: string;
}

export class CreateTenantDto {
  name: string;
  subdomain?: string;
  slug?: string;
  address?: string;
  ownerName: string;
  email: string;
  phone: string;
  status?: TenantStatus;
  subscriptionPlan: string;
  subscriptionDurationMonths: number;
  admin?: CreateTenantAdminDto;
}
