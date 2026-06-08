import { Controller, Get, Post, Put, Delete, Body, Param, Patch, UseGuards, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from './schemas/user.schema';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditLogService } from '../common/services/audit-log.service';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @Roles(Role.ADMIN, Role.MANAGER)
  async create(@CurrentUser() user: any, @Body() createUserDto: CreateUserDto, @Req() req: any) {
    const createdUser = await this.usersService.create(user.tenantId, createUserDto, user.role);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'CREATE_USER',
      { targetUserId: (createdUser as any)._id, role: createdUser.role },
      normalizedIp,
    );
    return createdUser;
  }

  @Get('check-connection')
  checkConnection(@Req() req: any) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');
    return {
      connected: true,
      ip: normalizedIp,
      timestamp: new Date(),
    };
  }

  @Get('profile')
  getProfile(@CurrentUser() user: any) {
    return this.usersService.getProfile(user.userId);
  }

  @Post('change-password')
  changePassword(
    @CurrentUser() user: any,
    @Body('oldPassword') oldPassword: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.usersService.changePassword(user.userId, oldPassword, newPassword);
  }

  @Get('audit-logs')
  @Roles(Role.ADMIN, Role.MANAGER)
  getAuditLogs(@CurrentUser() user: any) {
    return this.auditLogService.getLogs(user.tenantId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER)
  findAll(@CurrentUser() user: any) {
    return this.usersService.findAllByTenant(user.tenantId);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER)
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.usersService.findOne(user.tenantId, id);
  }

  @Put(':id')
  @Roles(Role.ADMIN)
  async updateUser(@CurrentUser() user: any, @Param('id') id: string, @Body() updates: any, @Req() req: any) {
    const updated = await this.usersService.updateUser(user.tenantId, id, updates);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'UPDATE_USER',
      { targetUserId: id, updates },
      normalizedIp,
    );
    return updated;
  }

  @Post(':id/reset-password')
  @Roles(Role.ADMIN)
  async resetPassword(@CurrentUser() user: any, @Param('id') id: string, @Req() req: any) {
    const result = await this.usersService.resetPassword(user.tenantId, id);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'RESET_PASSWORD',
      { targetUserId: id },
      normalizedIp,
    );
    return result;
  }

  @Patch(':id/lock')
  @Roles(Role.ADMIN)
  async lockUser(@CurrentUser() user: any, @Param('id') id: string, @Req() req: any) {
    const result = await this.usersService.lockUser(user.tenantId, id);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'LOCK_USER',
      { targetUserId: id },
      normalizedIp,
    );
    return result;
  }

  @Patch(':id/unlock')
  @Roles(Role.ADMIN)
  async unlockUser(@CurrentUser() user: any, @Param('id') id: string, @Req() req: any) {
    const result = await this.usersService.unlockUser(user.tenantId, id);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'UNLOCK_USER',
      { targetUserId: id },
      normalizedIp,
    );
    return result;
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  async deleteUser(@CurrentUser() user: any, @Param('id') id: string, @Req() req: any) {
    const result = await this.usersService.softDeleteUser(user.tenantId, id);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'DELETE_USER',
      { targetUserId: id },
      normalizedIp,
    );
    return result;
  }

  @Patch(':id/role')
  @Roles(Role.ADMIN)
  async changeRole(@CurrentUser() user: any, @Param('id') id: string, @Body('role') role: Role, @Req() req: any) {
    const result = await this.usersService.changeRole(user.tenantId, id, role, user.role);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'CHANGE_ROLE',
      { targetUserId: id, newRole: role },
      normalizedIp,
    );
    return result;
  }

  @Patch(':id/ip-whitelist')
  @Roles(Role.ADMIN)
  async updateIpWhitelist(
    @CurrentUser() user: any,
    @Param('id') targetUserId: string,
    @Body('ipWhitelist') ipWhitelist: string[],
    @Req() req: any,
  ) {
    const updated = await this.usersService.updateIpWhitelist(user.tenantId, targetUserId, ipWhitelist);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'UPDATE_IP_WHITELIST',
      { targetUserId, ipWhitelist },
      normalizedIp,
    );
    return updated;
  }

  @Get(':id/devices')
  @Roles(Role.ADMIN)
  getTrustedDevices(@CurrentUser() user: any, @Param('id') id: string) {
    return this.usersService.getTrustedDevices(user.tenantId, id);
  }

  @Delete(':id/devices/:deviceId')
  @Roles(Role.ADMIN)
  async revokeDevice(@CurrentUser() user: any, @Param('id') id: string, @Param('deviceId') deviceId: string, @Req() req: any) {
    const result = await this.usersService.revokeDevice(user.tenantId, id, deviceId);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');

    await this.auditLogService.log(
      user.tenantId,
      user.userId,
      'REVOKE_DEVICE',
      { targetUserId: id, deviceId },
      normalizedIp,
    );
    return result;
  }

  @Post(':id/logout-all')
  @Roles(Role.ADMIN)
  logoutAll(@CurrentUser() user: any, @Param('id') id: string) {
    return this.usersService.logoutAllSessions(user.tenantId, id);
  }
}
