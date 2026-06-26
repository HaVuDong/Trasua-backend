import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Permission } from '../common/permissions/permission.enum';
import { Role } from '../users/schemas/user.schema';
import { CashierService } from './cashier.service';

@Controller('cashier-shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CashierController {
  constructor(private readonly cashierService: CashierService) {}

  @Post('open')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.CASHIER_SHIFT_OPEN)
  open(@CurrentUser() user: any, @Body('openingCash') openingCash = 0) {
    return this.cashierService.openShift(
      user.tenantId,
      user.userId,
      Number(openingCash || 0),
    );
  }

  @Get('current')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  getCurrent(@CurrentUser() user: any) {
    return this.cashierService.getCurrentShift(user.tenantId);
  }

  @Post(':id/movements')
  @Roles(Role.ADMIN, Role.MANAGER)
  @RequirePermission(Permission.CASHIER_SHIFT_CLOSE)
  createMovement(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.cashierService.createManualMovement(
      user.tenantId,
      id,
      user.userId,
      dto,
    );
  }

  @Post(':id/close')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.CASHIER_SHIFT_CLOSE)
  close(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('countedCash') countedCash = 0,
    @Body('differenceReason') differenceReason?: string,
  ) {
    return this.cashierService.closeShift(
      user.tenantId,
      id,
      user.userId,
      Number(countedCash || 0),
      differenceReason,
    );
  }

  @Get('history')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.CASHIER_SHIFT_VIEW_HISTORY)
  getHistory(@CurrentUser() user: any, @Query('limit') limit = '30') {
    return this.cashierService.getHistory(user.tenantId, Number(limit || 30));
  }
}
