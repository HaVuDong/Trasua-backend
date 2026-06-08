import { Controller, Get, Post, Put, Body, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../users/schemas/user.schema';
import { TenantStatus } from './schemas/tenant.schema';

@Controller('tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  @Roles(Role.SYSTEM_OWNER) // Only System Owner can create tenants
  create(@Body() createTenantDto: CreateTenantDto) {
    return this.tenantsService.createTenant(createTenantDto);
  }

  @Get()
  @Roles(Role.SYSTEM_OWNER)
  findAll() {
    return this.tenantsService.findAll();
  }

  @Get('expiring')
  @Roles(Role.SYSTEM_OWNER)
  getExpiringSoon(@Query('days') days = '7') {
    return this.tenantsService.getExpiringSoon(parseInt(days));
  }

  @Get(':id')
  @Roles(Role.SYSTEM_OWNER)
  findOne(@Param('id') id: string) {
    return this.tenantsService.findOne(id);
  }

  @Put(':id')
  @Roles(Role.SYSTEM_OWNER)
  update(@Param('id') id: string, @Body() updates: any) {
    return this.tenantsService.updateTenant(id, updates);
  }

  @Patch(':id/status')
  @Roles(Role.SYSTEM_OWNER)
  updateStatus(@Param('id') id: string, @Body('status') status: TenantStatus) {
    return this.tenantsService.updateStatus(id, status);
  }

  @Patch(':id/lock')
  @Roles(Role.SYSTEM_OWNER)
  lockTenant(@Param('id') id: string) {
    return this.tenantsService.lockTenant(id);
  }

  @Patch(':id/unlock')
  @Roles(Role.SYSTEM_OWNER)
  unlockTenant(@Param('id') id: string) {
    return this.tenantsService.unlockTenant(id);
  }

  @Patch(':id/delete')
  @Roles(Role.SYSTEM_OWNER)
  deleteTenant(@Param('id') id: string) {
    return this.tenantsService.deleteTenant(id);
  }

  @Post(':id/renew')
  @Roles(Role.SYSTEM_OWNER)
  renewSubscription(
    @Param('id') id: string,
    @Body('months') months: number,
    @Body('amount') amount: number,
    @Body('performedBy') performedBy?: string,
    @Body('notes') notes?: string,
  ) {
    return this.tenantsService.renewSubscription(id, months, amount, performedBy, notes);
  }

  @Patch(':id/branding')
  @Roles(Role.SYSTEM_OWNER)
  updateBranding(@Param('id') id: string, @Body() branding: any) {
    return this.tenantsService.updateBranding(id, branding);
  }

  @Patch(':id/settings')
  @Roles(Role.SYSTEM_OWNER, Role.ADMIN)
  updateSettings(@Param('id') id: string, @Body() settings: any) {
    return this.tenantsService.updateSettings(id, settings);
  }

  @Get(':id/payments')
  @Roles(Role.SYSTEM_OWNER)
  getPaymentHistory(@Param('id') id: string) {
    return this.tenantsService.getPaymentHistory(id);
  }

  @Post(':id/reset-admin-password')
  @Roles(Role.SYSTEM_OWNER)
  resetAdminPassword(@Param('id') id: string) {
    return this.tenantsService.resetAdminPassword(id);
  }
}
