import { Controller, Get, Post, Body, Param, Patch, UseGuards, Req, Query, Res } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { CreateLeaveDto } from './dto/create-leave.dto';
import { ReviewLeaveDto } from './dto/review-leave.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { IpWhitelistGuard } from '../common/guards/ip-whitelist.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../users/schemas/user.schema';
import { CurrentUser } from '../common/decorators/current-user.decorator';
// @ts-ignore
import * as ExcelJS from 'exceljs';

@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // Check-in requires IP whitelist
  @Post('check-in')
  @UseGuards(IpWhitelistGuard)
  checkIn(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body('gps') gps?: string,
    @Body('shiftRegistrationId') shiftRegistrationId?: string,
  ) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');
    return this.attendanceService.checkIn(user.tenantId, user.userId, normalizedIp, gps, shiftRegistrationId);
  }

  // Check-out requires IP whitelist
  @Post('check-out')
  @UseGuards(IpWhitelistGuard)
  checkOut(@CurrentUser() user: any, @Body('shiftRegistrationId') shiftRegistrationId?: string) {
    return this.attendanceService.checkOut(user.tenantId, user.userId, shiftRegistrationId);
  }

  @Post('shifts')
  @Roles(Role.ADMIN, Role.MANAGER)
  createShift(@CurrentUser() user: any, @Body() dto: any) {
    return this.attendanceService.createWorkShift(user.tenantId, user.userId, user.role, dto);
  }

  @Get('shifts')
  @Roles(Role.ADMIN, Role.MANAGER)
  getShifts(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    return this.attendanceService.getWorkShifts(user.tenantId, from, to, status);
  }

  @Patch('shifts/:id/review')
  @Roles(Role.ADMIN)
  reviewShift(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: any) {
    return this.attendanceService.reviewWorkShift(user.tenantId, id, user.userId, dto);
  }

  @Get('my-shifts')
  @Roles(Role.MANAGER, Role.USER, Role.KITCHEN)
  getMyShifts(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.attendanceService.getMyShifts(user.tenantId, user.userId, user.role, from, to);
  }

  @Post('shifts/:id/register')
  @Roles(Role.MANAGER, Role.USER, Role.KITCHEN)
  registerShift(@CurrentUser() user: any, @Param('id') id: string) {
    return this.attendanceService.registerShift(user.tenantId, user.userId, user.role, id);
  }

  @Post('shift-registrations/:id/cancel')
  @Roles(Role.MANAGER, Role.USER, Role.KITCHEN)
  cancelShiftRegistration(@CurrentUser() user: any, @Param('id') id: string, @Body('reason') reason?: string) {
    return this.attendanceService.cancelShiftRegistration(user.tenantId, user.userId, id, reason);
  }

  @Patch('shift-registrations/:id/review-cancel')
  @Roles(Role.ADMIN, Role.MANAGER)
  reviewShiftCancellation(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: any) {
    return this.attendanceService.reviewShiftCancellation(user.tenantId, id, user.userId, dto);
  }

  // Edit attendance (Admin only)
  @Patch(':id/edit')
  @Roles(Role.ADMIN)
  editAttendance(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updates: { checkInTime?: string; checkOutTime?: string },
    @Req() req: any,
  ) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    const normalizedIp = ipString.replace('::ffff:', '');
    return this.attendanceService.editAttendance(user.tenantId, id, user.userId, updates, normalizedIp);
  }

  // Get daily attendance for all employees (Admin/Manager)
  @Get('daily')
  @Roles(Role.ADMIN, Role.MANAGER)
  getDailyAttendance(@CurrentUser() user: any, @Query('date') date?: string) {
    return this.attendanceService.getDailyAttendance(user.tenantId, date);
  }

  // Get monthly attendance for a specific user
  @Get('monthly/:userId')
  @Roles(Role.ADMIN, Role.MANAGER)
  getMonthlyAttendance(
    @CurrentUser() user: any,
    @Param('userId') userId: string,
    @Query('month') month: string,
  ) {
    return this.attendanceService.getMonthlyAttendance(user.tenantId, userId, month);
  }

  // Get own monthly attendance
  @Get('my-monthly')
  getMyMonthlyAttendance(@CurrentUser() user: any, @Query('month') month: string) {
    return this.attendanceService.getMonthlyAttendance(user.tenantId, user.userId, month);
  }

  // Leave request management
  @Post('leave')
  createLeaveRequest(@CurrentUser() user: any, @Body() dto: CreateLeaveDto) {
    return this.attendanceService.createLeaveRequest(user.tenantId, user.userId, dto);
  }

  @Get('leaves/pending')
  @Roles(Role.ADMIN, Role.MANAGER)
  getPendingLeaves(@CurrentUser() user: any) {
    return this.attendanceService.getPendingLeaves(user.tenantId);
  }

  @Get('leaves')
  @Roles(Role.ADMIN, Role.MANAGER)
  getAllLeaves(@CurrentUser() user: any, @Query('status') status?: string) {
    return this.attendanceService.getAllLeaves(user.tenantId, status);
  }

  @Patch('leave/:id/review')
  @Roles(Role.ADMIN, Role.MANAGER)
  reviewLeaveRequest(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: ReviewLeaveDto,
  ) {
    return this.attendanceService.reviewLeaveRequest(user.tenantId, id, user.userId, dto);
  }

  @Get('history')
  getHistory(@CurrentUser() user: any) {
    return this.attendanceService.getHistory(user.tenantId, user.userId);
  }

  // Payroll endpoints
  @Post('payroll/calculate')
  @Roles(Role.ADMIN, Role.MANAGER)
  calculatePayroll(@CurrentUser() user: any, @Query('month') month: string) {
    return this.attendanceService.queuePayrollCalculation(user.tenantId, month);
  }

  @Get('payroll')
  @Roles(Role.ADMIN, Role.MANAGER)
  getPayrolls(@CurrentUser() user: any, @Query('month') month: string) {
    return this.attendanceService.getPayrolls(user.tenantId, month);
  }

  @Get('payroll/detail/:userId')
  @Roles(Role.ADMIN, Role.MANAGER)
  getPayrollDetail(
    @CurrentUser() user: any,
    @Param('userId') userId: string,
    @Query('month') month: string,
  ) {
    return this.attendanceService.getPayrollDetail(user.tenantId, userId, month);
  }

  @Patch('payroll/:id/adjust')
  @Roles(Role.ADMIN)
  adjustPayroll(
    @CurrentUser() user: any,
    @Param('id') payrollId: string,
    @Body() adjustments: any,
  ) {
    return this.attendanceService.adjustPayroll(user.tenantId, payrollId, adjustments);
  }

  @Post('payroll/confirm')
  @Roles(Role.ADMIN)
  confirmPayroll(@CurrentUser() user: any, @Query('month') month: string) {
    return this.attendanceService.confirmPayroll(user.tenantId, month, user.userId);
  }

  // Export payroll as Excel
  @Get('payroll/export')
  @Roles(Role.ADMIN, Role.MANAGER)
  async exportPayroll(@CurrentUser() user: any, @Query('month') month: string, @Res() res: any) {
    const payrolls = await this.attendanceService.getPayrolls(user.tenantId, month);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Lương tháng ${month}`);

    worksheet.columns = [
      { header: 'Tên nhân viên', key: 'name', width: 25 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Vai trò', key: 'role', width: 15 },
      { header: 'Số giờ làm', key: 'workedHours', width: 15 },
      { header: 'Số ca làm', key: 'workedShifts', width: 15 },
      { header: 'Giờ OT', key: 'overtimeHours', width: 12 },
      { header: 'Lương OT', key: 'overtimePay', width: 15 },
      { header: 'Phụ cấp', key: 'totalAllowances', width: 15 },
      { header: 'Khấu trừ', key: 'totalDeductions', width: 15 },
      { header: 'Lương thực nhận', key: 'finalSalary', width: 18 },
      { header: 'Trạng thái', key: 'status', width: 15 },
    ];

    payrolls.forEach(p => {
      const userData = (p.userId as any);
      worksheet.addRow({
        name: userData?.name || '',
        email: userData?.email || '',
        role: userData?.role || '',
        workedHours: p.workedHours,
        workedShifts: p.workedShifts,
        overtimeHours: p.overtimeHours,
        overtimePay: p.overtimePay,
        totalAllowances: p.totalAllowances,
        totalDeductions: p.totalDeductions,
        finalSalary: p.finalSalary,
        status: p.status,
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=payroll_${month}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  }
}
