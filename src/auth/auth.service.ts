import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomInt } from 'crypto';
import {
  User,
  UserDocument,
  UserStatus,
  Role,
} from '../users/schemas/user.schema';
// @ts-ignore
import * as bcrypt from 'bcrypt';
import { AuditLogService } from '../common/services/audit-log.service';
import { EmailService } from '../common/services/email.service';
import { getEffectivePermissions } from '../common/permissions/permissions';

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
      permissionVersion: userDoc.permissionVersion || 1,
      authVersion: userDoc.authVersion || 1,
      effectivePermissions: getEffectivePermissions(
        userDoc.role,
        userDoc.permissionOverrides,
      ),
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

  private hasOtpVerifiedDevice(userDoc: UserDocument, deviceId: string) {
    return userDoc.trustedDevices.some(
      (d) => d.deviceId === deviceId && Boolean(d.verifiedAt),
    );
  }

  private createOtpCode() {
    return randomInt(100000, 1000000).toString();
  }

  private clearDeviceOtp(userDoc: UserDocument) {
    userDoc.localOtpCode = undefined;
    userDoc.localOtpExpires = undefined;
    userDoc.localOtpAttempts = 0;
  }

  private async storeDeviceOtp(userDoc: UserDocument, otp: string) {
    userDoc.localOtpCode = await bcrypt.hash(otp, 10);
    userDoc.localOtpExpires = new Date(Date.now() + 15 * 60 * 1000);
    userDoc.localOtpAttempts = 0;
    await userDoc.save();
  }

  private async compareDeviceOtp(otpCode: string, storedOtp: string) {
    const normalizedOtp = String(otpCode || '').trim();
    if (/^\d{6}$/.test(storedOtp)) {
      return storedOtp === normalizedOtp;
    }
    return bcrypt.compare(normalizedOtp, storedOtp);
  }

  private async upsertTrustedDevice(
    userDoc: UserDocument,
    deviceId: string,
    userAgent: string,
    ip: string,
    trustMethod: string,
  ) {
    const verifiedAt = new Date();
    const deviceExists = userDoc.trustedDevices.some(
      (d) => d.deviceId === deviceId,
    );
    if (!deviceExists) {
      userDoc.trustedDevices.push({
        deviceId,
        userAgent,
        ip,
        lastLogin: verifiedAt,
        verifiedAt,
        trustMethod,
      });
    } else {
      const dev = userDoc.trustedDevices.find((d) => d.deviceId === deviceId);
      if (dev) {
        dev.userAgent = userAgent;
        dev.ip = ip;
        dev.lastLogin = verifiedAt;
        dev.verifiedAt = verifiedAt;
        dev.trustMethod = trustMethod;
        userDoc.markModified('trustedDevices');
      }
    }

    await userDoc.save();
  }

  async validateUser(
    email: string,
    pass: string,
    ipAddress?: string,
  ): Promise<any> {
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
        throw new UnauthorizedException(
          `Account is temporarily locked. Try again after ${user.lockUntil.toLocaleTimeString()}`,
        );
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
          throw new UnauthorizedException(
            'Too many failed attempts. Account locked for 15 minutes.',
          );
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
      const deviceExists = userDoc.trustedDevices.some(
        (d) => d.deviceId === deviceId,
      );
      if (!deviceExists) {
        const now = new Date();
        userDoc.trustedDevices.push({
          deviceId,
          userAgent,
          ip,
          lastLogin: now,
          verifiedAt: now,
          trustMethod: 'SYSTEM_OWNER',
        });
      } else {
        const dev = userDoc.trustedDevices.find((d) => d.deviceId === deviceId);
        if (dev) {
          dev.userAgent = userAgent;
          dev.ip = ip;
          dev.lastLogin = new Date();
          dev.verifiedAt = dev.verifiedAt || new Date();
          dev.trustMethod = dev.trustMethod || 'SYSTEM_OWNER';
          userDoc.markModified('trustedDevices');
        }
      }
      await userDoc.save();

      const payload = this.buildAuthPayload(userDoc);

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
          message:
            'Bạn cần đổi mật khẩu trước khi tiếp tục. Sử dụng tempToken để gọi /auth/change-password.',
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
    const deviceExists = this.hasOtpVerifiedDevice(userDoc, deviceId);

    if (!deviceExists) {
      if (this.emailService.shouldSkipDeviceOtp()) {
        await this.upsertTrustedDevice(
          userDoc,
          deviceId,
          userAgent,
          ip,
          'BYPASS',
        );
        return this.buildLoginResponse(userDoc);
      }

      // First login or new device: generate OTP and send it to the account email.
      const otp = this.createOtpCode();
      await this.storeDeviceOtp(userDoc, otp);
      let emailResult: { delivered: boolean; devOtp?: string };
      try {
        emailResult = await this.emailService.sendDeviceOtp(
          userDoc.email || '',
          otp,
          userDoc.name,
        );
      } catch (error) {
        this.clearDeviceOtp(userDoc);
        await userDoc.save();
        throw error;
      }

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
      const dev = userDoc.trustedDevices.find((d) => d.deviceId === deviceId);
      if (dev) {
        dev.userAgent = userAgent;
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

    if (!userDoc.localOtpCode || !userDoc.localOtpExpires) {
      throw new UnauthorizedException('Invalid OTP code');
    }

    if (userDoc.localOtpExpires < new Date()) {
      this.clearDeviceOtp(userDoc);
      await userDoc.save();
      throw new UnauthorizedException('OTP code has expired');
    }

    const otpMatches = await this.compareDeviceOtp(
      otpCode,
      userDoc.localOtpCode,
    );
    if (!otpMatches) {
      userDoc.localOtpAttempts = (userDoc.localOtpAttempts || 0) + 1;
      if (userDoc.localOtpAttempts >= 5) {
        this.clearDeviceOtp(userDoc);
        await userDoc.save();
        throw new UnauthorizedException(
          'OTP code has expired. Please request a new OTP.',
        );
      }
      await userDoc.save();
      throw new UnauthorizedException('Invalid OTP code');
    }

    const now = new Date();
    const existingDevice = userDoc.trustedDevices.find(
      (d) => d.deviceId === deviceId,
    );
    if (existingDevice) {
      existingDevice.userAgent = userAgent;
      existingDevice.ip = ip;
      existingDevice.lastLogin = now;
      existingDevice.verifiedAt = now;
      existingDevice.trustMethod = 'OTP';
      userDoc.markModified('trustedDevices');
    } else {
      userDoc.trustedDevices.push({
        deviceId,
        userAgent,
        ip,
        lastLogin: now,
        verifiedAt: now,
        trustMethod: 'OTP',
      });
    }

    this.clearDeviceOtp(userDoc);
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

  async generateOtpForUser(
    tenantId: string | undefined,
    targetUserId: string,
  ): Promise<{ delivered: boolean; devOtp?: string }> {
    const query: Record<string, unknown> = { _id: targetUserId };
    if (tenantId) {
      query.tenantId = new Types.ObjectId(tenantId);
    }
    const user = await this.userModel.findOne(query).exec();
    if (!user) throw new UnauthorizedException('User not found');

    const otp = this.createOtpCode();
    await this.storeDeviceOtp(user, otp);
    try {
      return await this.emailService.sendDeviceOtp(
        user.email || '',
        otp,
        user.name,
      );
    } catch (error) {
      this.clearDeviceOtp(user);
      await user.save();
      throw error;
    }
  }

  async getPermissionSnapshot(userId: string) {
    const userDoc = await this.userModel
      .findById(userId)
      .select('role tenantId permissionOverrides permissionVersion')
      .exec();
    if (!userDoc) throw new UnauthorizedException('User not found');

    return {
      userId: userDoc._id.toString(),
      role: userDoc.role,
      tenantId: userDoc.tenantId ? userDoc.tenantId.toString() : null,
      effectivePermissions: getEffectivePermissions(
        userDoc.role,
        userDoc.permissionOverrides,
      ),
      permissionVersion: userDoc.permissionVersion || 1,
    };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<any> {
    if (!newPassword || newPassword.length < 8) {
      throw new UnauthorizedException(
        'Mật khẩu mới phải có ít nhất 8 ký tự',
      );
    }

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
      throw new UnauthorizedException(
        'Mật khẩu mới không được trùng với mật khẩu cũ',
      );
    }

    // Hash and save new password
    userDoc.passwordHash = await bcrypt.hash(newPassword, 10);
    userDoc.mustChangePassword = false;
    userDoc.authVersion = (userDoc.authVersion || 1) + 1;
    await userDoc.save();

    // Return full access token
    const payload = this.buildAuthPayload(userDoc);

    return {
      access_token: this.jwtService.sign(payload),
      message: 'Đổi mật khẩu thành công.',
    };
  }

  async requestForgotPasswordOtp(email: string) {
    const user = await this.userModel.findOne({ email });
    if (!user) {
      // Return success even if user not found to prevent email enumeration
      return { message: 'Nếu email hợp lệ, OTP đã được gửi đến email của bạn.' };
    }

    if (user.forgotPasswordBlockUntil && user.forgotPasswordBlockUntil > new Date()) {
      throw new ForbiddenException(`Vui lòng thử lại sau khoảng thời gian khóa.`);
    }

    const otp = this.createOtpCode();
    user.forgotPasswordOtpCode = await bcrypt.hash(otp, 10);
    user.forgotPasswordOtpExpires = new Date(Date.now() + 5 * 60 * 1000);
    user.forgotPasswordOtpAttempts = 0;
    // Do not reset lock phase here so that the next penalty can be applied if they fail again
    await user.save();

    try {
      await this.emailService.sendForgotPasswordOtp(email, otp, user.name);
    } catch (error) {
      user.forgotPasswordOtpCode = undefined;
      user.forgotPasswordOtpExpires = undefined;
      await user.save();
      throw error;
    }

    return { message: 'Nếu email hợp lệ, OTP đã được gửi đến email của bạn.' };
  }

  async verifyForgotPasswordOtp(email: string, otpCode: string) {
    const user = await this.userModel.findOne({ email });
    if (!user) {
      throw new UnauthorizedException('Mã OTP không hợp lệ hoặc đã hết hạn.');
    }

    if (user.forgotPasswordBlockUntil && user.forgotPasswordBlockUntil > new Date()) {
      throw new ForbiddenException(`Tài khoản đang bị khóa. Vui lòng thử lại sau.`);
    }

    if (!user.forgotPasswordOtpCode || !user.forgotPasswordOtpExpires) {
      throw new UnauthorizedException('Mã OTP không hợp lệ hoặc đã hết hạn.');
    }

    if (user.forgotPasswordOtpExpires < new Date()) {
      user.forgotPasswordOtpCode = undefined;
      user.forgotPasswordOtpExpires = undefined;
      await user.save();
      throw new UnauthorizedException('Mã OTP đã hết hạn.');
    }

    const otpMatches = await this.compareDeviceOtp(otpCode, user.forgotPasswordOtpCode);
    if (!otpMatches) {
      user.forgotPasswordOtpAttempts = (user.forgotPasswordOtpAttempts || 0) + 1;
      const phase = user.forgotPasswordLockPhase || 0;

      if (phase === 0 && user.forgotPasswordOtpAttempts >= 5) {
        user.forgotPasswordBlockUntil = new Date(Date.now() + 30 * 1000); // 30 seconds
        user.forgotPasswordLockPhase = 1;
        user.forgotPasswordOtpAttempts = 0;
        user.forgotPasswordOtpCode = undefined;
        user.forgotPasswordOtpExpires = undefined;
        await user.save();
        throw new ForbiddenException('Bạn đã nhập sai 5 lần. Vui lòng thử lại sau 30 giây.');
      } else if (phase === 1 && user.forgotPasswordOtpAttempts >= 3) {
        user.forgotPasswordBlockUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        user.forgotPasswordLockPhase = 2;
        user.forgotPasswordOtpAttempts = 0;
        user.forgotPasswordOtpCode = undefined;
        user.forgotPasswordOtpExpires = undefined;
        await user.save();
        throw new ForbiddenException('Bạn đã nhập sai thêm 3 lần. Tính năng quên mật khẩu tạm khóa 1 giờ.');
      } else if (phase >= 2) {
        throw new ForbiddenException('Tính năng quên mật khẩu đang bị khóa.');
      }

      await user.save();
      throw new UnauthorizedException('Mã OTP không hợp lệ.');
    }

    // OTP correct, clear attempts and phase
    user.forgotPasswordOtpCode = undefined;
    user.forgotPasswordOtpExpires = undefined;
    user.forgotPasswordOtpAttempts = 0;
    user.forgotPasswordBlockUntil = undefined;
    user.forgotPasswordLockPhase = 0;
    await user.save();

    // Create a temporary token for resetting password
    const payload = this.buildAuthPayload(user);
    const tempToken = this.jwtService.sign(
      { ...payload, purpose: 'forgot_password_reset' },
      { expiresIn: '15m' }, // 15 mins to reset password
    );

    return {
      message: 'Mã OTP hợp lệ.',
      resetToken: tempToken,
    };
  }

  async resetPasswordWithToken(token: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new UnauthorizedException(
        'Mật khẩu mới phải có ít nhất 8 ký tự',
      );
    }

    let decoded;
    try {
      decoded = this.jwtService.verify(token);
    } catch (e) {
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn.');
    }

    if (decoded.purpose !== 'forgot_password_reset') {
      throw new UnauthorizedException('Token không hợp lệ cho tác vụ này.');
    }

    const userDoc = await this.userModel.findById(decoded.sub).exec();
    if (!userDoc) {
      throw new UnauthorizedException('Người dùng không tồn tại.');
    }

    // Check if new password is same as old
    const sameAsOld = await bcrypt.compare(newPassword, userDoc.passwordHash);
    if (sameAsOld) {
      throw new UnauthorizedException('Mật khẩu mới không được trùng với mật khẩu cũ');
    }

    userDoc.passwordHash = await bcrypt.hash(newPassword, 10);
    userDoc.mustChangePassword = false;
    userDoc.authVersion = (userDoc.authVersion || 1) + 1;
    
    // Clear any lock or attempts due to forgotten password or login attempts
    userDoc.loginAttempts = 0;
    userDoc.lockUntil = undefined;
    userDoc.forgotPasswordBlockUntil = undefined;
    userDoc.forgotPasswordLockPhase = 0;
    
    await userDoc.save();

    const payload = this.buildAuthPayload(userDoc);
    return {
      access_token: this.jwtService.sign(payload),
      message: 'Đổi mật khẩu thành công.',
    };
  }
}
