import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { Tenant, TenantDocument, TenantStatus, SubscriptionStatus } from '../tenants/schemas/tenant.schema';
import { User, UserDocument, Role } from '../users/schemas/user.schema';
import { EmailService } from '../common/services/email.service';
import { getSaasPlan, isSaasPlanId, SAAS_PLANS, SAAS_TRIAL_DAYS } from '../billing/saas-plans';
import { ResendSignupOtpDto, StartSignupDto, VerifySignupDto } from './dto/signup.dto';
import { SignupRequest, SignupRequestDocument, SignupRequestStatus } from './schemas/signup-request.schema';

@Injectable()
export class PublicSignupService {
  constructor(
    @InjectModel(SignupRequest.name) private signupRequestModel: Model<SignupRequestDocument>,
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly emailService: EmailService,
  ) {}

  getPlans() {
    return SAAS_PLANS;
  }

  private normalizeEmail(email?: string) {
    return String(email || '').trim().toLowerCase();
  }

  private normalizePhone(phone?: string) {
    return String(phone || '').trim();
  }

  private normalizeSubdomain(subdomain?: string) {
    const value = String(subdomain || '').trim().toLowerCase();
    return value || undefined;
  }

  private validateEmail(email: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  private validatePhone(phone: string) {
    return /^[+0-9][0-9\s.-]{7,20}$/.test(phone);
  }

  private validatePassword(password: string) {
    return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  }

  private validateSubdomain(subdomain?: string) {
    return !subdomain || /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(subdomain);
  }

  private createOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  private addMinutes(date: Date, minutes: number) {
    return new Date(date.getTime() + minutes * 60 * 1000);
  }

  private addDays(date: Date, days: number) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private async assertUniqueSignupIdentity(adminEmail: string, tenantEmail: string, subdomain?: string) {
    const [existingUser, existingTenantEmail, existingSubdomain] = await Promise.all([
      this.userModel.findOne({ email: adminEmail }).select('_id').lean().exec(),
      this.tenantModel.findOne({ email: tenantEmail }).select('_id').lean().exec(),
      subdomain
        ? this.tenantModel.findOne({ subdomain }).select('_id').lean().exec()
        : Promise.resolve(null),
    ]);

    if (existingUser) throw new BadRequestException('Email admin da duoc su dung');
    if (existingTenantEmail) throw new BadRequestException('Email cua hang da duoc su dung');
    if (existingSubdomain) throw new BadRequestException('Ten mien phu da duoc su dung');
  }

  async startSignup(dto: StartSignupDto, ip?: string) {
    const storeName = String(dto?.storeName || '').trim();
    const phone = this.normalizePhone(dto?.phone);
    const subdomain = this.normalizeSubdomain(dto?.subdomain);
    const adminName = String(dto?.admin?.name || '').trim();
    const adminEmail = this.normalizeEmail(dto?.admin?.email);
    const adminPhone = this.normalizePhone(dto?.admin?.phone);
    const password = String(dto?.admin?.password || '').trim();
    const selectedPlan = String(dto?.plan || '').trim().toUpperCase();

    if (!storeName) throw new BadRequestException('Ten cua hang la bat buoc');
    if (!this.validatePhone(phone)) throw new BadRequestException('So dien thoai cua hang khong hop le');
    if (subdomain && !this.validateSubdomain(subdomain)) {
      throw new BadRequestException('Ten mien phu chi gom chu thuong, so va dau gach ngang');
    }
    if (!adminName) throw new BadRequestException('Ten admin la bat buoc');
    if (!this.validateEmail(adminEmail)) throw new BadRequestException('Email admin khong hop le');
    if (adminPhone && !this.validatePhone(adminPhone)) throw new BadRequestException('So dien thoai admin khong hop le');
    if (!this.validatePassword(password)) {
      throw new BadRequestException('Mat khau phai co it nhat 8 ky tu, gom chu va so');
    }
    if (!isSaasPlanId(selectedPlan)) throw new BadRequestException('Goi dich vu khong hop le');

    await this.assertUniqueSignupIdentity(adminEmail, adminEmail, subdomain);

    const recentRequest = await this.signupRequestModel.findOne({
      adminEmail,
      status: SignupRequestStatus.OTP_PENDING,
    }).sort({ createdAt: -1 }).exec();

    const now = new Date();
    if (recentRequest?.otpSentAt && now.getTime() - new Date(recentRequest.otpSentAt).getTime() < 60 * 1000) {
      throw new BadRequestException('Vui long doi 60 giay truoc khi gui lai OTP');
    }

    const otp = this.createOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const passwordHash = await bcrypt.hash(password, 10);

    const signupRequest = new this.signupRequestModel({
      storeName,
      subdomain,
      address: String(dto?.address || '').trim() || undefined,
      phone,
      adminName,
      adminEmail,
      adminPhone: adminPhone || undefined,
      passwordHash,
      selectedPlan,
      otpHash,
      otpExpiresAt: this.addMinutes(now, 15),
      otpSentAt: now,
      status: SignupRequestStatus.OTP_PENDING,
      ip,
    });

    const saved = await signupRequest.save();
    const emailResult = await this.emailService.sendSignupOtp(adminEmail, otp, adminName);

    return {
      signupId: saved._id.toString(),
      otpExpiresAt: saved.otpExpiresAt,
      delivered: emailResult.delivered,
      devOtp: emailResult.devOtp,
    };
  }

  async resendOtp(dto: ResendSignupOtpDto) {
    const signup = await this.signupRequestModel.findById(dto.signupId).exec();
    if (!signup || signup.status !== SignupRequestStatus.OTP_PENDING) {
      throw new NotFoundException('Dang ky khong ton tai hoac da hoan tat');
    }

    const now = new Date();
    if (signup.otpSentAt && now.getTime() - new Date(signup.otpSentAt).getTime() < 60 * 1000) {
      throw new BadRequestException('Vui long doi 60 giay truoc khi gui lai OTP');
    }

    const otp = this.createOtp();
    signup.otpHash = await bcrypt.hash(otp, 10);
    signup.otpExpiresAt = this.addMinutes(now, 15);
    signup.otpSentAt = now;
    signup.attempts = 0;
    const saved = await signup.save();
    const emailResult = await this.emailService.sendSignupOtp(signup.adminEmail, otp, signup.adminName);

    return {
      signupId: saved._id.toString(),
      otpExpiresAt: saved.otpExpiresAt,
      delivered: emailResult.delivered,
      devOtp: emailResult.devOtp,
    };
  }

  async verifySignup(dto: VerifySignupDto) {
    const signup = await this.signupRequestModel.findById(dto.signupId).exec();
    if (!signup || signup.status !== SignupRequestStatus.OTP_PENDING) {
      throw new NotFoundException('Dang ky khong ton tai hoac da hoan tat');
    }

    if (new Date(signup.otpExpiresAt).getTime() < Date.now()) {
      signup.status = SignupRequestStatus.EXPIRED;
      await signup.save();
      throw new BadRequestException('Ma OTP da het han');
    }

    if (signup.attempts >= 5) {
      signup.status = SignupRequestStatus.CANCELLED;
      await signup.save();
      throw new BadRequestException('Dang ky da bi khoa do nhap sai OTP qua so lan');
    }

    const otpCode = String(dto.otpCode || '').trim();
    const matches = await bcrypt.compare(otpCode, signup.otpHash);
    if (!matches) {
      signup.attempts += 1;
      await signup.save();
      throw new BadRequestException('Ma OTP khong dung');
    }

    await this.assertUniqueSignupIdentity(signup.adminEmail, signup.adminEmail, signup.subdomain);

    const plan = getSaasPlan(signup.selectedPlan);
    const startDate = new Date();
    const trialEndsAt = this.addDays(startDate, SAAS_TRIAL_DAYS);

    const tenant = new this.tenantModel({
      name: signup.storeName,
      subdomain: signup.subdomain,
      address: signup.address,
      ownerName: signup.adminName,
      email: signup.adminEmail,
      phone: signup.phone,
      status: TenantStatus.ACTIVE,
      subscription: {
        plan: plan.id,
        status: SubscriptionStatus.TRIALING,
        startDate,
        endDate: trialEndsAt,
        trialEndsAt,
        amount: plan.priceMonthly,
        currency: plan.currency,
        billingCycle: plan.billingCycle,
      },
      paymentHistory: [{
        date: startDate,
        amount: 0,
        durationMonths: 0,
        notes: `Initial ${SAAS_TRIAL_DAYS}-day trial`,
      }],
    });

    const savedTenant = await tenant.save();
    const adminUser = new this.userModel({
      tenantId: savedTenant._id as Types.ObjectId,
      name: signup.adminName,
      email: signup.adminEmail,
      phone: signup.adminPhone,
      passwordHash: signup.passwordHash,
      role: Role.ADMIN,
      mustChangePassword: false,
    });
    const savedAdmin = await adminUser.save();

    signup.status = SignupRequestStatus.VERIFIED;
    await signup.save();

    const { passwordHash: _passwordHash, localOtpCode, localOtpExpires, ...safeAdmin } = savedAdmin.toObject();
    return {
      tenant: savedTenant,
      admin: safeAdmin,
      trialEndsAt,
    };
  }
}
