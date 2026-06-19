import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicSignupService } from './public-signup.service';
import { ResendSignupOtpDto, StartSignupDto, VerifySignupDto } from './dto/signup.dto';

@Controller('public')
export class PublicSignupController {
  constructor(private readonly publicSignupService: PublicSignupService) {}

  @Get('saas/plans')
  getPlans() {
    return this.publicSignupService.getPlans();
  }

  @Post('signup/start')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  startSignup(@Body() dto: StartSignupDto, @Req() req: any) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    return this.publicSignupService.startSignup(dto, ipString.replace('::ffff:', ''));
  }

  @Post('signup/resend-otp')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  resendOtp(@Body() dto: ResendSignupOtpDto) {
    return this.publicSignupService.resendOtp(dto);
  }

  @Post('signup/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifySignup(@Body() dto: VerifySignupDto) {
    return this.publicSignupService.verifySignup(dto);
  }
}
