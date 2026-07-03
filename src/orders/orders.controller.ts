import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  UseGuards,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { IpWhitelistGuard } from '../common/guards/ip-whitelist.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { Permission } from '../common/permissions/permission.enum';
import { hasEffectivePermission } from '../common/permissions/permissions';
import { Role } from '../users/schemas/user.schema';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OrderItemStatus } from './schemas/order.schema';
import { CreateCustomerRequestDto } from './dto/customer-request.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // 1. Public QR Order endpoint for customers (no auth required)
  @Post(':tenantId/qr/:qrToken')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createQrOrder(
    @Param('tenantId') tenantId: string,
    @Param('qrToken') qrToken: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.createQrOrder(tenantId, qrToken, dto);
  }

  // 1a. Public menu endpoint
  @Get(':tenantId/menu')
  getMenu(@Param('tenantId') tenantId: string) {
    return this.ordersService.getPublicMenu(tenantId);
  }

  // 1b. Public table info endpoint
  @Get(':tenantId/table-info/:qrToken')
  getTableInfo(
    @Param('tenantId') tenantId: string,
    @Param('qrToken') qrToken: string,
  ) {
    return this.ordersService.getTableInfo(tenantId, qrToken);
  }

  // 1c. Public order status endpoint
  @Get(':tenantId/status/:orderId')
  getOrderStatus(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.ordersService.getPublicOrderStatus(tenantId, orderId);
  }

  // 1d. Public customer table session summary
  @Get(':tenantId/table-session/:sessionId/summary')
  getTableSessionSummary(
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.ordersService.getTableSessionSummary(tenantId, sessionId);
  }

  // 1e. Public customer support/payment request endpoint
  @Post(':tenantId/table-request/:qrToken')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  createCustomerRequest(
    @Param('tenantId') tenantId: string,
    @Param('qrToken') qrToken: string,
    @Body() dto: CreateCustomerRequestDto,
  ) {
    return this.ordersService.createCustomerRequest(tenantId, qrToken, dto);
  }

  // 1b. Close Customer Session (if they choose NO on continue popup)
  @Post(':tenantId/table-sessions/:sessionId/close')
  closeCustomerSession(
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.ordersService.closeCustomerSession(tenantId, sessionId);
  }

  // 2. Staff Manual Order endpoint (requires IP whitelist)
  @Post('staff')
  @UseGuards(JwtAuthGuard, RolesGuard, IpWhitelistGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  createStaffOrder(@CurrentUser() user: any, @Body() dto: CreateOrderDto) {
    return this.ordersService.createStaffOrder(user.tenantId, user.userId, dto);
  }

  // 3. Active orders view
  @Get('active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  findAllActive(@CurrentUser() user: any) {
    return this.ordersService.findAllActive(user.tenantId);
  }

  @Get('staff/workspace')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  getStaffWorkspace(@CurrentUser() user: any) {
    return this.ordersService.getStaffWorkspace(user.tenantId);
  }

  @Get('staff/history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  getStaffHistoryWorkspace(@CurrentUser() user: any) {
    return this.ordersService.getStaffHistoryWorkspace(user.tenantId);
  }

  @Get('kitchen/queue')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.KITCHEN)
  getKitchenQueue(@CurrentUser() user: any) {
    return this.ordersService.getKitchenQueue(user.tenantId);
  }

  @Patch('customer-requests/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  updateCustomerRequestStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.ordersService.updateCustomerRequestStatus(
      user.tenantId,
      id,
      status,
    );
  }

  @Post('table-sessions/:sessionId/manual-checkout')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  manualCheckoutTableSession(
    @CurrentUser() user: any,
    @Param('sessionId') sessionId: string,
    @Body('discount') discount = 0,
    @Body('discountType') discountType = 'FLAT',
  ) {
    return this.ordersService.manualCheckoutTableSession(
      user.tenantId,
      sessionId,
      user.userId,
      discount,
      discountType,
      user.role,
    );
  }

  @Post('table-sessions/:sessionId/pay-balance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  payBalanceTableSession(
    @CurrentUser() user: any,
    @Param('sessionId') sessionId: string,
  ) {
    return this.ordersService.payBalanceTableSession(
      user.tenantId,
      sessionId,
      user.userId,
      user.role,
    );
  }

  // 4. Search/filter orders
  @Get('search')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  findOrders(
    @CurrentUser() user: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('tableId') tableId?: string,
    @Query('status') status?: string,
    @Query('customerPhone') customerPhone?: string,
    @Query('createdBy') createdBy?: string,
  ) {
    return this.ordersService.findOrders(user.tenantId, {
      startDate,
      endDate,
      tableId,
      status,
      customerPhone,
      createdBy,
    });
  }

  // 5. Get orders by table (for customer view)
  @Get('table/:tableId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  getOrdersByTable(
    @CurrentUser() user: any,
    @Param('tableId') tableId: string,
  ) {
    return this.ordersService.getOrdersByTable(user.tenantId, tableId);
  }

  // 5b. Public customer temporary bill (no auth, uses tenantId)
  @Get(':tenantId/table-bill/:tableId')
  getTableBill(
    @Param('tenantId') tenantId: string,
    @Param('tableId') tableId: string,
  ) {
    return this.ordersService.getTableBill(tenantId, tableId);
  }

  // 6. Get order detail
  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.ordersService.findOrderById(user.tenantId, id);
  }

  // 7. Confirm customer QR Order (requires IP whitelist)
  @Patch(':id/confirm')
  @UseGuards(JwtAuthGuard, RolesGuard, IpWhitelistGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  confirmOrder(@CurrentUser() user: any, @Param('id') id: string) {
    return this.ordersService.confirmOrder(user.tenantId, id, user.userId);
  }

  // 8. Reject customer QR Order with reason
  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard, IpWhitelistGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  rejectOrder(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('reason') reason?: string,
  ) {
    return this.ordersService.rejectOrder(user.tenantId, id, reason);
  }

  // 9. Cancel item (2-minute rule)
  @Patch(':id/items/:itemId/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard, IpWhitelistGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  cancelItem(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body('reason') reason?: string,
  ) {
    return this.ordersService.cancelItem(
      user.tenantId,
      id,
      itemId,
      user.userId,
      user.role,
      reason,
      hasEffectivePermission(user, Permission.ORDER_CANCEL_LATE),
    );
  }

  // 10. Kitchen item status update
  @Patch(':id/items/:itemId/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.KITCHEN, Role.USER)
  updateItemStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body('status') status: OrderItemStatus,
  ) {
    return this.ordersService.updateItemStatus(
      user.tenantId,
      id,
      itemId,
      status,
      user.role,
    );
  }

  // 11. Mark free (item or entire order)
  @Patch(':id/free')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.ORDER_MARK_FREE)
  markFree(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('itemId') itemId?: string,
  ) {
    return this.ordersService.markFree(user.tenantId, id, itemId, user.userId);
  }

  // 12. Get temporary bill details
  @Get(':id/bill')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  getBill(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('discount') discount = '0',
    @Query('discountType') discountType = 'FLAT',
  ) {
    const discountAmount = parseFloat(discount);
    if (
      discountAmount > 0 &&
      !hasEffectivePermission(user, Permission.ORDER_DISCOUNT)
    ) {
      throw new ForbiddenException('Ban khong co quyen giam gia');
    }
    return this.ordersService.getBill(
      user.tenantId,
      id,
      discountAmount,
      discountType,
    );
  }

  // 13. Checkout / pay bill (requires IP whitelist)
  @Post(':id/checkout')
  @UseGuards(JwtAuthGuard, RolesGuard, IpWhitelistGuard)
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  checkout(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('discount') discount = 0,
    @Body('discountType') discountType = 'FLAT',
  ) {
    if (
      Number(discount) > 0 &&
      !hasEffectivePermission(user, Permission.ORDER_DISCOUNT)
    ) {
      throw new ForbiddenException('Ban khong co quyen giam gia');
    }
    return this.ordersService.checkout(
      user.tenantId,
      id,
      discount,
      discountType,
      user.userId,
      user.role,
    );
  }
}
