import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument, Role, UserStatus } from './schemas/user.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { Tenant, TenantDocument } from '../tenants/schemas/tenant.schema';
import { getSaasPlan } from '../billing/saas-plans';
// @ts-ignore
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Tenant.name) private tenantModel?: Model<TenantDocument>,
  ) {}

  private normalizeEmail(email?: string) {
    return (email || '').trim().toLowerCase();
  }

  private assertCanCreateRole(actorRole: Role, targetRole: Role) {
    if (targetRole === Role.SYSTEM_OWNER) {
      throw new BadRequestException('Cannot create System Owner from staff management');
    }

    const allowedByRole: Record<string, Role[]> = {
      [Role.ADMIN]: [Role.MANAGER, Role.USER, Role.KITCHEN],
      [Role.MANAGER]: [Role.USER, Role.KITCHEN],
    };

    const allowedRoles = allowedByRole[actorRole] || [];
    if (!allowedRoles.includes(targetRole)) {
      throw new BadRequestException('Role khong hop le voi quyen hien tai');
    }
  }

  private generateTempPassword() {
    return Math.random().toString(36).slice(-10);
  }

  private async assertStaffLimit(tenantId: string) {
    if (!this.tenantModel) return;
    const tenant = await this.tenantModel.findById(tenantId).select('subscription').lean().exec();
    if (!tenant) throw new BadRequestException('Tenant not found');
    const plan = getSaasPlan((tenant as any).subscription?.plan);
    const activeUsers = await this.userModel.countDocuments({
      tenantId: new Types.ObjectId(tenantId),
      role: { $ne: Role.SYSTEM_OWNER },
      status: { $ne: UserStatus.DELETED },
    }).exec();

    if (activeUsers >= plan.maxStaff) {
      throw new BadRequestException(`Goi ${plan.id} chi cho phep toi da ${plan.maxStaff} tai khoan`);
    }
  }

  async create(tenantId: string, createUserDto: CreateUserDto, actorRole: Role): Promise<any> {
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    this.assertCanCreateRole(actorRole, createUserDto.role);
    await this.assertStaffLimit(tenantId);

    const email = this.normalizeEmail(createUserDto.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Email khong hop le');
    }

    const existingEmail = await this.userModel.findOne({ email }).exec();
    if (existingEmail) {
      throw new BadRequestException('Email da duoc su dung');
    }

    const phone = createUserDto.phone?.trim() || undefined;
    const tempPassword = createUserDto.password?.trim() || this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const newUser = new this.userModel({
      ...createUserDto,
      email,
      phone,
      tenantId,
      passwordHash,
      salaryConfig: {
        baseHourly: createUserDto.baseHourly,
        baseShift: createUserDto.baseShift,
      },
      mustChangePassword: true,
    });
    const saved = await newUser.save();
    const { passwordHash: _passwordHash, localOtpCode, localOtpExpires, ...safeUser } = saved.toObject();
    return { ...safeUser, tempPassword };
  }

  async findAllByTenant(tenantId: string): Promise<User[]> {
    return this.userModel.find({ tenantId, role: { $ne: Role.SYSTEM_OWNER } }).exec();
  }

  async findOne(tenantId: string, userId: string): Promise<User> {
    const user = await this.userModel.findOne({ _id: userId, tenantId }).exec();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUser(tenantId: string, userId: string, updates: any): Promise<User> {
    // Prevent modifying critical fields directly
    delete updates.passwordHash;
    delete updates.tenantId;
    delete updates._id;
    delete updates.role; // Use changeRole for this
    delete updates.trustedDevices;

    if (updates.email !== undefined) {
      const email = this.normalizeEmail(updates.email);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BadRequestException('Email khong hop le');
      }
      const existingEmail = await this.userModel.findOne({ email, _id: { $ne: new Types.ObjectId(userId) } }).exec();
      if (existingEmail) {
        throw new BadRequestException('Email da duoc su dung');
      }
      updates.email = email;
    }

    if (updates.phone !== undefined) {
      updates.phone = updates.phone ? String(updates.phone).trim() : undefined;
    }

    // Handle salary config separately
    if (updates.baseHourly !== undefined || updates.baseShift !== undefined || updates.overtimeMultiplier !== undefined) {
      const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
      if (!user) throw new NotFoundException('User not found');
      if (!user.salaryConfig) user.salaryConfig = {} as any;
      if (updates.baseHourly !== undefined) user.salaryConfig!.baseHourly = updates.baseHourly;
      if (updates.baseShift !== undefined) user.salaryConfig!.baseShift = updates.baseShift;
      if (updates.overtimeMultiplier !== undefined) user.salaryConfig!.overtimeMultiplier = updates.overtimeMultiplier;
      delete updates.baseHourly;
      delete updates.baseShift;
      delete updates.overtimeMultiplier;

      Object.assign(user, updates);
      user.markModified('salaryConfig');
      return user.save();
    }

    const updated = await this.userModel.findOneAndUpdate(
      { _id: userId, tenantId: new Types.ObjectId(tenantId) },
      { $set: updates },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException('User not found');
    return updated;
  }

  async resetPassword(tenantId: string, userId: string): Promise<{ tempPassword: string }> {
    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');

    const tempPassword = Math.random().toString(36).slice(-8);
    user.passwordHash = await bcrypt.hash(tempPassword, 10);
    user.mustChangePassword = true;
    user.trustedDevices = [];
    user.localOtpCode = undefined;
    user.localOtpExpires = undefined;
    await user.save();

    return { tempPassword };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<{ message: string }> {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('New password must have at least 8 characters');
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');

    const matches = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!matches) throw new BadRequestException('Current password is incorrect');

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.mustChangePassword = false;
    await user.save();

    return { message: 'Password changed successfully' };
  }

  async lockUser(tenantId: string, userId: string): Promise<User> {
    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');

    user.status = UserStatus.LOCKED;
    return user.save();
  }

  async unlockUser(tenantId: string, userId: string): Promise<User> {
    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');

    user.status = UserStatus.ACTIVE;
    user.loginAttempts = 0;
    user.lockUntil = undefined;
    return user.save();
  }

  async softDeleteUser(tenantId: string, userId: string): Promise<User> {
    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');

    user.status = UserStatus.DELETED;
    return user.save();
  }

  async changeRole(tenantId: string, userId: string, newRole: Role, actorRole: Role): Promise<User> {
    if (newRole === Role.SYSTEM_OWNER) {
      throw new BadRequestException('Cannot elevate to System Owner');
    }

    if (actorRole !== Role.ADMIN) {
      throw new BadRequestException('Can quyen ADMIN de doi role');
    }

    this.assertCanCreateRole(actorRole, newRole);

    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');

    user.role = newRole;
    return user.save();
  }

  async getProfile(userId: string): Promise<any> {
    const user = await this.userModel.findById(userId).select('-passwordHash -localOtpCode -localOtpExpires').exec();
    if (!user) throw new NotFoundException('User not found');

    // Calculate seniority
    const startDate = (user as any).createdAt || new Date();
    const now = new Date();
    const diffMs = now.getTime() - new Date(startDate).getTime();
    const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const years = Math.floor(totalDays / 365);
    const months = Math.floor((totalDays % 365) / 30);
    const days = totalDays % 30;

    return {
      ...(user.toObject ? user.toObject() : user),
      seniority: { years, months, days, totalDays },
    };
  }

  async getTrustedDevices(tenantId: string, userId: string): Promise<any[]> {
    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');
    return user.trustedDevices || [];
  }

  async revokeDevice(tenantId: string, userId: string, deviceId: string): Promise<User> {
    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');

    user.trustedDevices = user.trustedDevices.filter(d => d.deviceId !== deviceId);
    user.markModified('trustedDevices');
    return user.save();
  }

  async updateIpWhitelist(tenantId: string, targetUserId: string, ipWhitelist: string[]): Promise<User> {
    const user = await this.userModel.findOne({ _id: targetUserId, tenantId }).exec();
    if (!user) throw new NotFoundException('User not found');
    user.ipWhitelist = ipWhitelist;
    return user.save();
  }

  async logoutAllSessions(tenantId: string, userId: string): Promise<{ message: string }> {
    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');

    // Clear all trusted devices — forces re-authentication
    user.trustedDevices = [];
    user.markModified('trustedDevices');
    await user.save();

    return { message: 'All sessions have been logged out' };
  }
}
