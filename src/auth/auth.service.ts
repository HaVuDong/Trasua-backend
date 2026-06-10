import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument, UserStatus, Role } from '../users/schemas/user.schema';
// @ts-ignore
import * as bcrypt from 'bcrypt';
import { AuditLogService } from '../common/services/audit-log.service';
import { EmailService } from '../common/services/email.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
    private auditLogService: AuditLogService,
    private emailService: EmailService,
  ) {}

  private buildAuthPayload(userDoc: UserDocument) {
    return {
      email: userDoc.email,
      phone: userDoc.phone,
      sub: userDoc._id.toString(),
      role: userDoc.role,
      tenantId: userDoc.tenantId ? userDoc.tenantId.toString() : null,
    };
  }

  private buildLoginResponse(userDoc: UserDocument) {
    const payload = this.buildAuthPayload(userDoc);

    if (userDoc.mustChangePassword) {
      const tempToken = this.jwtService.sign(
        { ...payload, purpose: 'password_change' },
        { expiresIn: '5m' },
      );
      return {
        requiresPasswordChange: true,
        tempToken,
        message: 'Ban can doi mat khau truoc khi tiep tuc.',
      };
    }

    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  private async upsertTrustedDevice(userDoc: UserDocument, deviceId: string, userAgent: string, ip: string) {
    const deviceExists = userDoc.trustedDevices.some((d) => d.deviceId === deviceId);
    if (!deviceExists) {
      userDoc.trustedDevices.push({
        deviceId,
        userAgent,
        ip,
        lastLogin: new Date(),
      });
    } else {
      const dev = userDoc.trustedDevices.find((d) => d.deviceId === deviceId);
      if (dev) {
        dev.ip = ip;
        dev.lastLogin = new Date();
        userDoc.markModified('trustedDevices');
      }
    }

    await userDoc.save();
  }

  async validateUser(email: string, pass: string, ipAddress?: string): Promise<any> {
    const user = await this.userModel.findOne({
      email,
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isSystemOwner = user.role === Role.SYSTEM_OWNER;

    // SYSTEM_OWNER bypasses all lock/status restrictions
    if (!isSystemOwner) {
      if (user.status === UserStatus.LOCKED) {
        throw new UnauthorizedException('Account is locked by administrator');
      }

      // Check if account is temporarily locked
      if (user.lockUntil && user.lockUntil > new Date()) {
        throw new UnauthorizedException(`Account is temporarily locked. Try again after ${user.lockUntil.toLocaleTimeString()}`);
      }
    }

    const matches = await bcrypt.compare(pass, user.passwordHash);

    if (matches) {
      // Reset attempts
      user.loginAttempts = 0;
      user.lockUntil = undefined;
      await user.save();

      const { passwordHash, ...result } = user.toObject();
      return result;
    } else {
      // SYSTEM_OWNER is never locked out from failed attempts
      if (!isSystemOwner) {
        user.loginAttempts += 1;
        if (user.loginAttempts >= 5) {
          user.lockUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
          await user.save();

          if (user.tenantId) {
            await this.auditLogService.log(
              user.tenantId.toString(),
              user._id.toString(),
              'ACCOUNT_TEMPORARY_LOCK',
              { reason: '5 failed login attempts', ipAddress },
              ipAddress,
            );
          }
          throw new UnauthorizedException('Too many failed attempts. Account locked for 15 minutes.');
        }
        await user.save();
      }
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  async checkDeviceAndLogin(
    user: any,
    deviceId: string,
    userAgent: string,
    ip: string,
  ): Promise<any> {
    const userDoc = await this.userModel.findById(user._id).exec();
    if (!userDoc) throw new UnauthorizedException('User not found');

    const isSystemOwner = userDoc.role === Role.SYSTEM_OWNER;

    // SYSTEM_OWNER: skip all device verification, auto-register device & login immediately
    if (isSystemOwner) {
      const deviceExists = userDoc.trustedDevices.some(d => d.deviceId === deviceId);
      if (!deviceExists) {
        userDoc.trustedDevices.push({
          deviceId,
          userAgent,
          ip,
          lastLogin: new Date(),
        });
      } else {
        const dev = userDoc.trustedDevices.find(d => d.deviceId === deviceId);
        if (dev) {
          dev.ip = ip;
          dev.lastLogin = new Date();
          userDoc.markModified('trustedDevices');
        }
      }
      await userDoc.save();

      const payload = {
        email: userDoc.email,
        phone: userDoc.phone,
        sub: userDoc._id.toString(),
        role: userDoc.role,
        tenantId: userDoc.tenantId ? userDoc.tenantId.toString() : null,
      };

      // SYSTEM_OWNER must change password on every login
      if (userDoc.mustChangePassword) {
        // Issue a short-lived temporary token (5 minutes) only for password change
        const tempToken = this.jwtService.sign(
          { ...payload, purpose: 'password_change' },
          { expiresIn: '5m' },
        );
        return {
          requiresPasswordChange: true,
          tempToken,
          message: 'Bạn cần đổi mật khẩu trước khi tiếp tục. Sử dụng tempToken để gọi /auth/change-password.',
        };
      }

      // Set flag so next login will require password change
      userDoc.mustChangePassword = true;
      await userDoc.save();

      return {
        access_token: this.jwtService.sign(payload),
      };
    }

    // Normal users: device verification flow
    const deviceExists = userDoc.trustedDevices.some(d => d.deviceId === deviceId);

    if (!deviceExists) {
      if (this.emailService.shouldSkipDeviceOtp()) {
        await this.upsertTrustedDevice(userDoc, deviceId, userAgent, ip);
        return this.buildLoginResponse(userDoc);
      }

      // First login or new device: generate OTP and send it to the account email.
      const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
      userDoc.localOtpCode = otp;
      userDoc.localOtpExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
      await userDoc.save();
      const emailResult = await this.emailService.sendDeviceOtp(userDoc.email || '', otp, userDoc.name);

      // Log warning
      if (userDoc.tenantId) {
        await this.auditLogService.log(
          userDoc.tenantId.toString(),
          userDoc._id.toString(),
          'NEW_DEVICE_LOGIN_ATTEMPT',
          { deviceId, userAgent, ip },
          ip,
        );
      }

      return {
        requiresDeviceVerification: true,
        userId: userDoc._id.toString(),
        message: 'Ma OTP da duoc gui den email tai khoan.',
        ...(emailResult.devOtp ? { devOtp: emailResult.devOtp } : {}),
      };
    } else {
      // Update last login info
      const dev = userDoc.trustedDevices.find(d => d.deviceId === deviceId);
      if (dev) {
        dev.ip = ip;
        dev.lastLogin = new Date();
        userDoc.markModified('trustedDevices');
        await userDoc.save();
      }
    }

    return this.buildLoginResponse(userDoc);
  }

  async verifyDevice(
    userId: string,
    otpCode: string,
    deviceId: string,
    userAgent: string,
    ip: string,
  ): Promise<any> {
    const userDoc = await this.userModel.findById(userId).exec();
    if (!userDoc) throw new UnauthorizedException('User not found');

    if (!userDoc.localOtpCode || userDoc.localOtpCode !== otpCode) {
      throw new UnauthorizedException('Invalid OTP code');
    }

    if (!userDoc.localOtpExpires || userDoc.localOtpExpires < new Date()) {
      throw new UnauthorizedException('OTP code has expired');
    }

    // Add device to trusted
    userDoc.trustedDevices.push({
      deviceId,
      userAgent,
      ip,
      lastLogin: new Date(),
    });

    // Clear OTP
    userDoc.localOtpCode = undefined;
    userDoc.localOtpExpires = undefined;
    await userDoc.save();

    if (userDoc.tenantId) {
      await this.auditLogService.log(
        userDoc.tenantId.toString(),
        userDoc._id.toString(),
        'NEW_DEVICE_VERIFIED',
        { deviceId, userAgent, ip },
        ip,
      );
    }

    return this.buildLoginResponse(userDoc);
  }

  async generateOtpForUser(tenantId: string, targetUserId: string): Promise<{ delivered: boolean; devOtp?: string }> {
    const user = await this.userModel.findOne({ _id: targetUserId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new UnauthorizedException('User not found');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.localOtpCode = otp;
    user.localOtpExpires = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();
    return this.emailService.sendDeviceOtp(user.email || '', otp, user.name);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<any> {
    const userDoc = await this.userModel.findById(userId).exec();
    if (!userDoc) throw new UnauthorizedException('User not found');

    // Verify current password
    const matches = await bcrypt.compare(currentPassword, userDoc.passwordHash);
    if (!matches) {
      throw new UnauthorizedException('Mật khẩu hiện tại không đúng');
    }

    // Prevent reusing the same password
    const sameAsOld = await bcrypt.compare(newPassword, userDoc.passwordHash);
    if (sameAsOld) {
      throw new UnauthorizedException('Mật khẩu mới không được trùng với mật khẩu cũ');
    }

    // Hash and save new password
    userDoc.passwordHash = await bcrypt.hash(newPassword, 10);
    userDoc.mustChangePassword = false;
    await userDoc.save();

    // Return full access token
    const payload = {
      email: userDoc.email,
      phone: userDoc.phone,
      sub: userDoc._id.toString(),
      role: userDoc.role,
      tenantId: userDoc.tenantId ? userDoc.tenantId.toString() : null,
    };

    return {
      access_token: this.jwtService.sign(payload),
      message: 'Đổi mật khẩu thành công.',
    };
  }
}
