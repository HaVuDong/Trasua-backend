import { Controller, Post, Body, UnauthorizedException, Req, Param, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../users/schemas/user.schema';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() loginDto: LoginDto, @Req() req: any) {
    const email = loginDto.email?.trim().toLowerCase();
    const password = loginDto.password?.trim();

    if (!email || !password) {
      throw new UnauthorizedException('Email and password are required');
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    const user = await this.authService.validateUser(email, password, normalizedIp);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const deviceId = loginDto.deviceId || 'unknown_device';
    const userAgent = req.headers['user-agent'] || 'unknown';

    return this.authService.checkDeviceAndLogin(user, deviceId, userAgent, normalizedIp);
  }

  @Post('verify-device')
  async verifyDevice(
    @Body('userId') userId: string,
    @Body('otpCode') otpCode: string,
    @Body('deviceId') deviceId: string,
    @Req() req: any,
  ) {
    const userAgent = req.headers['user-agent'] || 'unknown';
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    return this.authService.verifyDevice(userId, otpCode, deviceId || 'unknown_device', userAgent, normalizedIp);
  }

  @Post('generate-device-otp/:userId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SYSTEM_OWNER, Role.ADMIN, Role.MANAGER)
  async generateDeviceOtp(@CurrentUser() user: any, @Param('userId') targetUserId: string) {
    const tenantScope = user.role === Role.SYSTEM_OWNER ? undefined : user.tenantId;
    const result = await this.authService.generateOtpForUser(tenantScope, targetUserId);
    return {
      message: 'OTP da duoc gui den email tai khoan. Hieu luc trong 15 phut.',
      ...(result.devOtp ? { devOtp: result.devOtp } : {}),
    };
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() user: any,
    @Body('currentPassword') currentPassword: string,
    @Body('newPassword') newPassword: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new UnauthorizedException('currentPassword and newPassword are required');
    }
    if (newPassword.length < 8) {
      throw new UnauthorizedException('Mật khẩu mới phải có ít nhất 8 ký tự');
    }
    return this.authService.changePassword(user.userId, currentPassword, newPassword);
  }
}
