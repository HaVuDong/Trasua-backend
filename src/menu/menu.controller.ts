import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../users/schemas/user.schema';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { UpsertMenuRecipeDto } from './dto/upsert-menu-recipe.dto';
import { MenuService } from './menu.service';

@Controller('menu-items')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  findAll(
    @CurrentUser() user: any,
    @Query('category') category?: string,
    @Query('search') search?: string,
  ) {
    return this.menuService.findAllMenuItems(user.tenantId, { category, search });
  }

  @Get('availability')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  getAvailability(@CurrentUser() user: any, @Query('quantity') quantity?: string) {
    const normalizedQuantity = quantity ? Number(quantity) : 1;
    return this.menuService.getAvailability(user.tenantId, normalizedQuantity);
  }

  @Post()
  @Roles(Role.ADMIN, Role.MANAGER)
  create(@CurrentUser() user: any, @Body() dto: CreateMenuItemDto) {
    return this.menuService.createMenuItem(user.tenantId, user.userId, dto);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.menuService.findMenuItemById(user.tenantId, id);
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.MANAGER)
  update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateMenuItemDto) {
    return this.menuService.updateMenuItem(user.tenantId, user.userId, id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.MANAGER)
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.menuService.deleteMenuItem(user.tenantId, user.userId, id);
  }

  @Get(':id/recipe')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  getRecipe(@CurrentUser() user: any, @Param('id') id: string) {
    return this.menuService.getActiveRecipeForMenuItem(user.tenantId, id);
  }

  @Put(':id/recipe')
  @Roles(Role.ADMIN, Role.MANAGER)
  upsertRecipe(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpsertMenuRecipeDto) {
    return this.menuService.upsertRecipe(user.tenantId, user.userId, id, dto);
  }

  @Post(':id/check-availability')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  checkAvailability(@CurrentUser() user: any, @Param('id') id: string, @Body('quantity') quantity?: number) {
    return this.menuService.checkAvailability(user.tenantId, id, quantity || 1);
  }
}
