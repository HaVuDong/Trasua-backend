import { Injectable, NotFoundException, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tenant, TenantDocument, TenantStatus, SubscriptionStatus } from './schemas/tenant.schema';
import { User, UserDocument, Role, UserStatus } from '../users/schemas/user.schema';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { getSaasPlan } from '../billing/saas-plans';
import { randomBytes } from 'crypto';
// @ts-ignore
import * as bcrypt from 'bcrypt';

@Injectable()
export class TenantsService implements OnModuleInit {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  private normalizeEmail(email?: string) {
    return (email || '').trim().toLowerCase();
  }

  private generateTempPassword() {
    return randomBytes(12).toString('base64url').slice(0, 16);
  }

  async onModuleInit() {
    await this.backfillMissingSubscriptions();
  }

  private async backfillMissingSubscriptions() {
    const now = new Date();
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const plan = getSaasPlan('PRO');
    const result = await this.tenantModel.updateMany(
      {
        $or: [
          { subscription: { $exists: false } },
          { 'subscription.plan': { $exists: false } },
          { 'subscription.endDate': { $exists: false } },
        ],
      },
      {
        $set: {
          status: TenantStatus.ACTIVE,
          subscription: {
            plan: plan.id,
            status: SubscriptionStatus.ACTIVE,
            startDate: now,
            endDate,
            amount: plan.priceMonthly,
            currency: plan.currency,
            billingCycle: plan.billingCycle,
            lastPaymentAt: now,
          },
        },
        $push: {
          paymentHistory: {
            date: now,
            amount: 0,
            durationMonths: 1,
            notes: 'Automatic legacy subscription backfill',
          },
        },
      },
    ).exec();

    if (result.modifiedCount > 0) {
      this.logger.warn(`Backfilled subscription for ${result.modifiedCount} legacy tenant(s).`);
    }
  }

  async createTenant(createTenantDto: CreateTenantDto): Promise<any> {
    const adminName = createTenantDto.admin?.name?.trim() || createTenantDto.ownerName?.trim();
    const adminEmail = this.normalizeEmail(createTenantDto.admin?.email || createTenantDto.email);
    const adminPhone = createTenantDto.admin?.phone?.trim() || createTenantDto.phone?.trim();
    const tenantEmail = this.normalizeEmail(createTenantDto.email || adminEmail);
    const tenantPhone = createTenantDto.phone?.trim() || adminPhone;

    if (!adminName) {
      throw new BadRequestException('Ten admin dau tien la bat buoc');
    }
    if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      throw new BadRequestException('Email admin khong hop le');
    }
    if (!tenantEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tenantEmail)) {
      throw new BadRequestException('Email tenant khong hop le');
    }
    if (!tenantPhone) {
      throw new BadRequestException('So dien thoai tenant la bat buoc');
    }

    const existingAdminEmail = await this.userModel.findOne({ email: adminEmail }).exec();
    if (existingAdminEmail) {
      throw new BadRequestException('Email admin da duoc su dung');
    }
    const existingTenantEmail = await this.tenantModel.findOne({ email: tenantEmail }).exec();
    if (existingTenantEmail) {
      throw new BadRequestException('Email tenant da duoc su dung');
    }

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + (createTenantDto.subscriptionDurationMonths || 1));
    const plan = getSaasPlan(createTenantDto.subscriptionPlan);

    const newTenant = new this.tenantModel({
      name: createTenantDto.name,
      subdomain: createTenantDto.subdomain || createTenantDto.slug,
      address: createTenantDto.address,
      ownerName: adminName,
      email: tenantEmail,
      phone: tenantPhone,
      status: createTenantDto.status || TenantStatus.ACTIVE,
      subscription: {
        plan: plan.id,
        status: SubscriptionStatus.ACTIVE,
        startDate,
        endDate,
        amount: plan.priceMonthly,
        currency: plan.currency,
        billingCycle: plan.billingCycle,
        lastPaymentAt: startDate,
      },
      paymentHistory: [{
        date: startDate,
        amount: 0,
        durationMonths: createTenantDto.subscriptionDurationMonths || 1,
        notes: 'Initial subscription',
      }],
    });

    const savedTenant = await newTenant.save();

    // Create Admin User for this tenant
    const tempPassword = createTenantDto.admin?.password?.trim() || this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const adminUser = new this.userModel({
      tenantId: savedTenant._id,
      name: adminName,
      email: adminEmail,
      phone: adminPhone,
      passwordHash,
      role: Role.ADMIN,
      mustChangePassword: true,
    });
    const savedAdmin = await adminUser.save();
    const { passwordHash: _passwordHash, localOtpCode, localOtpExpires, localOtpAttempts, ...safeAdmin } = savedAdmin.toObject();

    return {
      tenant: savedTenant,
      admin: safeAdmin,
      tempPassword,
    };
  }

  async findAll(): Promise<Tenant[]> {
    return this.tenantModel.find().exec();
  }

  async findOne(id: string): Promise<Tenant> {
    const tenant = await this.tenantModel.findById(id).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }

  async updateTenant(id: string, updates: Partial<Tenant>): Promise<Tenant> {
    // Prevent updating critical fields directly
    delete (updates as any)._id;
    delete (updates as any).subscription;
    delete (updates as any).paymentHistory;

    const updated = await this.tenantModel.findByIdAndUpdate(id, { $set: updates }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Tenant not found');
    return updated;
  }

  async updateStatus(id: string, status: TenantStatus): Promise<Tenant> {
    const updated = await this.tenantModel.findByIdAndUpdate(id, { status }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Tenant not found');
    return updated;
  }

  async lockTenant(id: string): Promise<Tenant> {
    const tenant = await this.tenantModel.findByIdAndUpdate(
      id,
      { status: TenantStatus.SUSPENDED },
      { new: true },
    ).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    // Lock all users under this tenant
    await this.userModel.updateMany(
      { tenantId: tenant._id },
      { status: UserStatus.LOCKED },
    ).exec();

    return tenant;
  }

  async unlockTenant(id: string): Promise<Tenant> {
    const tenant = await this.tenantModel.findByIdAndUpdate(
      id,
      { status: TenantStatus.ACTIVE },
      { new: true },
    ).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    // Unlock all users under this tenant
    await this.userModel.updateMany(
      { tenantId: tenant._id, status: UserStatus.LOCKED },
      { status: UserStatus.ACTIVE },
    ).exec();

    return tenant;
  }

  async deleteTenant(id: string): Promise<{ message: string }> {
    const tenant = await this.tenantModel.findById(id).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    // Soft delete: mark as DELETED
    tenant.status = TenantStatus.DELETED;
    await tenant.save();

    // Lock all users
    await this.userModel.updateMany(
      { tenantId: tenant._id },
      { status: UserStatus.DELETED },
    ).exec();

    return { message: `Tenant ${tenant.name} has been deleted permanently` };
  }

  async renewSubscription(id: string, months: number, amount: number, performedBy?: string, notes?: string): Promise<Tenant> {
    const tenant = await this.tenantModel.findById(id).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    // Extend from current end date or now (whichever is later)
    const baseDate = tenant.subscription.endDate > new Date()
      ? new Date(tenant.subscription.endDate)
      : new Date();

    baseDate.setMonth(baseDate.getMonth() + months);
    tenant.subscription.endDate = baseDate;
    tenant.subscription.status = SubscriptionStatus.ACTIVE;
    tenant.subscription.lastPaymentAt = new Date();
    const plan = getSaasPlan(tenant.subscription.plan);
    tenant.subscription.amount = plan.priceMonthly;
    tenant.subscription.currency = plan.currency;
    tenant.subscription.billingCycle = plan.billingCycle;

    // If expired, reactivate
    if (tenant.status === TenantStatus.EXPIRED || tenant.status === TenantStatus.SUSPENDED) {
      tenant.status = TenantStatus.ACTIVE;
    }

    // Record payment
    tenant.paymentHistory.push({
      date: new Date(),
      amount,
      durationMonths: months,
      performedBy,
      notes,
    });

    return tenant.save();
  }

  async updateBranding(id: string, branding: {
    logoUrl?: string;
    backgroundUrl?: string;
    bannerUrl?: string;
    brandName?: string;
    primaryColor?: string;
  }): Promise<Tenant> {
    const tenant = await this.tenantModel.findById(id).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    if (!tenant.settings) tenant.settings = {} as any;
    if (branding.logoUrl !== undefined) tenant.settings.logoUrl = branding.logoUrl;
    if (branding.backgroundUrl !== undefined) tenant.settings.backgroundUrl = branding.backgroundUrl;
    if (branding.bannerUrl !== undefined) tenant.settings.bannerUrl = branding.bannerUrl;
    if (branding.brandName !== undefined) tenant.settings.brandName = branding.brandName;
    if (branding.primaryColor !== undefined) tenant.settings.primaryColor = branding.primaryColor;

    tenant.markModified('settings');
    return tenant.save();
  }

  async updateSettings(id: string, settings: {
    vatRate?: number;
    serviceCharge?: number;
    ipWhitelist?: string[];
    lateThresholdMinutes?: number;
    standardHoursPerDay?: number;
  }): Promise<Tenant> {
    const tenant = await this.tenantModel.findById(id).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');

    if (!tenant.settings) tenant.settings = {} as any;
    if (settings.vatRate !== undefined) tenant.settings.vatRate = settings.vatRate;
    if (settings.serviceCharge !== undefined) tenant.settings.serviceCharge = settings.serviceCharge;
    if (settings.ipWhitelist !== undefined) tenant.settings.ipWhitelist = settings.ipWhitelist;
    if (settings.lateThresholdMinutes !== undefined) tenant.settings.lateThresholdMinutes = settings.lateThresholdMinutes;
    if (settings.standardHoursPerDay !== undefined) tenant.settings.standardHoursPerDay = settings.standardHoursPerDay;

    tenant.markModified('settings');
    return tenant.save();
  }

  async getExpiringSoon(days: number = 7): Promise<Tenant[]> {
    const now = new Date();
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + days);

    return this.tenantModel.find({
      status: TenantStatus.ACTIVE,
      'subscription.endDate': { $gte: now, $lte: threshold },
    }).exec();
  }

  async getPaymentHistory(id: string): Promise<any[]> {
    const tenant = await this.tenantModel.findById(id).exec();
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant.paymentHistory || [];
  }

  async resetAdminPassword(tenantId: string): Promise<{ tempPassword: string }> {
    const admin = await this.userModel.findOne({ tenantId, role: Role.ADMIN }).exec();
    if (!admin) throw new NotFoundException('Admin user not found for this tenant');

    const tempPassword = this.generateTempPassword();
    admin.passwordHash = await bcrypt.hash(tempPassword, 10);
    admin.mustChangePassword = true;
    admin.authVersion = (admin.authVersion || 1) + 1;
    admin.trustedDevices = [];
    admin.localOtpCode = undefined;
    admin.localOtpExpires = undefined;
    admin.localOtpAttempts = 0;
    await admin.save();

    return { tempPassword };
  }
}
