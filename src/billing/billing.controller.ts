import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../users/schemas/user.schema';
import { BillingService } from './billing.service';

@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('me')
  @Roles(Role.ADMIN, Role.MANAGER)
  getBillingMe(@CurrentUser() user: any) {
    return this.billingService.getBillingMe(user.tenantId);
  }

  @Post('payos/create')
  @Roles(Role.ADMIN)
  createPayosPayment(@CurrentUser() user: any, @Body('months') months = 1) {
    return this.billingService.createPayosPayment(user.tenantId, Number(months || 1));
  }

  @Get('payments/:id/status')
  @Roles(Role.ADMIN, Role.MANAGER)
  getPaymentStatus(@CurrentUser() user: any, @Param('id') id: string) {
    return this.billingService.getPaymentStatus(id, user.tenantId);
  }
}
