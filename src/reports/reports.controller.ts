import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../users/schemas/user.schema';
import { CurrentUser } from '../common/decorators/current-user.decorator';
// @ts-ignore
import * as ExcelJS from 'exceljs';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // Dashboard — real-time overview
  @Get('dashboard')
  @Roles(Role.ADMIN, Role.MANAGER)
  getDashboard(@CurrentUser() user: any) {
    return this.reportsService.getDashboard(user.tenantId);
  }

  // Revenue by hour
  @Get('revenue-by-hour')
  @Roles(Role.ADMIN, Role.MANAGER)
  getRevenueByHour(@CurrentUser() user: any, @Query('date') date?: string) {
    return this.reportsService.getRevenueByHour(user.tenantId, date);
  }

  // Top selling / least selling items
  @Get('top-items')
  @Roles(Role.ADMIN, Role.MANAGER)
  getTopItems(
    @CurrentUser() user: any,
    @Query('startDate') startStr: string,
    @Query('endDate') endStr: string,
    @Query('limit') limit = '10',
  ) {
    const startDate = startStr ? new Date(startStr) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = endStr ? new Date(endStr) : new Date();
    return this.reportsService.getTopItems(user.tenantId, startDate, endDate, parseInt(limit));
  }

  // Financial report (profit analysis)
  @Get('financial')
  @Roles(Role.ADMIN)
  getFinancial(
    @CurrentUser() user: any,
    @Query('startDate') startStr: string,
    @Query('endDate') endStr: string,
  ) {
    const startDate = startStr ? new Date(startStr) : new Date();
    if (!startStr) startDate.setDate(startDate.getDate() - 30);
    const endDate = endStr ? new Date(endStr) : new Date();
    return this.reportsService.getFinancialReport(user.tenantId, startDate, endDate);
  }

  @Get('revenue')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getRevenue(
    @CurrentUser() user: any,
    @Query('startDate') startStr: string,
    @Query('endDate') endStr: string,
    @Query('export') exportType: string,
    @Res() res: any,
  ) {
    const startDate = startStr ? new Date(startStr) : new Date();
    if (!startStr) startDate.setDate(startDate.getDate() - 30);
    const endDate = endStr ? new Date(endStr) : new Date();

    const data = await this.reportsService.getRevenueReport(user.tenantId, startDate, endDate);

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Doanh thu');

      worksheet.columns = [
        { header: 'Mã đơn', key: 'id', width: 25 },
        { header: 'Ngày hoàn thành', key: 'completedAt', width: 25 },
        { header: 'Tạm tính', key: 'totalAmount', width: 15 },
        { header: 'Giảm giá', key: 'discount', width: 15 },
        { header: 'VAT', key: 'vat', width: 15 },
        { header: 'Phí dịch vụ', key: 'serviceCharge', width: 15 },
        { header: 'Tổng cộng', key: 'finalAmount', width: 15 },
      ];

      data.orders.forEach((o: any) => {
        worksheet.addRow({
          id: o.id.toString(),
          completedAt: o.completedAt,
          totalAmount: o.totalAmount,
          discount: o.discount,
          vat: o.vat,
          serviceCharge: o.serviceCharge,
          finalAmount: o.finalAmount,
        });
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=' + 'revenue_report.xlsx');

      await workbook.xlsx.write(res);
      return res.end();
    }

    return res.json(data);
  }

  @Get('employee')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getEmployee(
    @CurrentUser() user: any,
    @Query('startDate') startStr: string,
    @Query('endDate') endStr: string,
    @Query('export') exportType: string,
    @Res() res: any,
  ) {
    const startDate = startStr ? new Date(startStr) : new Date();
    if (!startStr) startDate.setDate(startDate.getDate() - 30);
    const endDate = endStr ? new Date(endStr) : new Date();

    const data = await this.reportsService.getEmployeeReport(user.tenantId, startDate, endDate);

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Hiệu suất nhân viên');

      worksheet.columns = [
        { header: 'Tên nhân viên', key: 'name', width: 25 },
        { header: 'Email', key: 'email', width: 25 },
        { header: 'Vai trò', key: 'role', width: 15 },
        { header: 'Số đơn phục vụ', key: 'orderCount', width: 15 },
        { header: 'Doanh số tạo ra', key: 'totalSales', width: 15 },
        { header: 'Số giờ làm', key: 'workedHours', width: 15 },
        { header: 'Số ca làm', key: 'shiftsWorked', width: 15 },
        { header: 'Số lần trễ', key: 'lateDays', width: 12 },
      ];

      data.forEach(item => {
        worksheet.addRow(item);
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=' + 'employee_report.xlsx');

      await workbook.xlsx.write(res);
      return res.end();
    }

    return res.json(data);
  }
}
