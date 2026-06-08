import { Controller, Get, Post, Put, Delete, Body, Param, Patch, UseGuards } from '@nestjs/common';
import { TablesService } from './tables.service';
import { CreateTableDto } from './dto/create-table.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../users/schemas/user.schema';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TableStatus } from './schemas/table.schema';

@Controller('tables')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  @Post()
  @Roles(Role.ADMIN, Role.MANAGER)
  create(@CurrentUser() user: any, @Body() createTableDto: CreateTableDto) {
    return this.tablesService.create(user.tenantId, createTableDto);
  }

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  findAll(@CurrentUser() user: any) {
    return this.tablesService.findAllByTenant(user.tenantId);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.tablesService.findOne(user.tenantId, id);
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.MANAGER)
  update(@CurrentUser() user: any, @Param('id') id: string, @Body() updates: any) {
    return this.tablesService.updateTable(user.tenantId, id, updates);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  delete(@CurrentUser() user: any, @Param('id') id: string) {
    return this.tablesService.deleteTable(user.tenantId, id);
  }

  @Patch(':id/default-items')
  @Roles(Role.ADMIN)
  setDefaultItems(@CurrentUser() user: any, @Param('id') id: string, @Body('items') items: any[]) {
    return this.tablesService.setDefaultItems(user.tenantId, id, items);
  }

  @Patch(':id/toggle-visibility')
  @Roles(Role.ADMIN)
  toggleVisibility(@CurrentUser() user: any, @Param('id') id: string) {
    return this.tablesService.toggleVisibility(user.tenantId, id);
  }

  @Patch(':id/reset-qr')
  @Roles(Role.ADMIN)
  resetQr(@CurrentUser() user: any, @Param('id') id: string) {
    return this.tablesService.resetQr(user.tenantId, id);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  updateStatus(@CurrentUser() user: any, @Param('id') id: string, @Body('status') status: TableStatus) {
    return this.tablesService.updateStatus(user.tenantId, id, status);
  }
}
