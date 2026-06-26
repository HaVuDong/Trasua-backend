import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { InvoicesService } from './invoices.service';
import { PrintJobStatus, PrintJobType } from './schemas/print-job.schema';

@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post('table-sessions/:sessionId')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.INVOICE_VIEW)
  createForTableSession(
    @CurrentUser() user: any,
    @Param('sessionId') sessionId: string,
  ) {
    return this.invoicesService.createForTableSession(
      user.tenantId,
      sessionId,
      user.userId,
    );
  }

  @Get('table-sessions/:sessionId/latest')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.INVOICE_VIEW)
  getLatestForSession(
    @CurrentUser() user: any,
    @Param('sessionId') sessionId: string,
  ) {
    return this.invoicesService.getLatestForSession(user.tenantId, sessionId);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.INVOICE_VIEW)
  getInvoice(@CurrentUser() user: any, @Param('id') id: string) {
    return this.invoicesService.getInvoice(user.tenantId, id);
  }

  @Post(':id/print-jobs')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.INVOICE_PRINT_REQUEST)
  requestPrintJob(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('type') type: PrintJobType = PrintJobType.BILL,
  ) {
    return this.invoicesService.requestPrintJob(
      user.tenantId,
      id,
      user.userId,
      type,
    );
  }
}

@Controller('print-jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PrintJobsController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get('queue')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.PRINT_QUEUE_MANAGE)
  getQueue(@CurrentUser() user: any, @Query('status') status?: PrintJobStatus) {
    return this.invoicesService.getPrintQueue(user.tenantId, status);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN, Role.MANAGER, Role.USER)
  @RequirePermission(Permission.PRINT_QUEUE_MANAGE)
  updateStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('status') status: PrintJobStatus,
    @Body('errorMessage') errorMessage?: string,
  ) {
    return this.invoicesService.updatePrintJobStatus(
      user.tenantId,
      id,
      user.userId,
      status,
      errorMessage,
    );
  }
}
