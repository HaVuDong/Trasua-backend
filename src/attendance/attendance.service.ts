import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Attendance, AttendanceDocument, AttendanceStatus } from './schemas/attendance.schema';
import { LeaveRequest, LeaveRequestDocument, LeaveRequestStatus } from './schemas/leave-request.schema';
import { Payroll, PayrollDocument } from './schemas/payroll.schema';
import { WorkShift, WorkShiftDocument, WorkShiftStatus } from './schemas/work-shift.schema';
import { ShiftRegistration, ShiftRegistrationDocument, ShiftRegistrationStatus } from './schemas/shift-registration.schema';
import { User, UserDocument, Role } from '../users/schemas/user.schema';
import { Tenant, TenantDocument } from '../tenants/schemas/tenant.schema';
import { CreateLeaveDto } from './dto/create-leave.dto';
import { ReviewLeaveDto } from './dto/review-leave.dto';
import { AuditLogService } from '../common/services/audit-log.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

const PAYROLL_LATE_MINUTES_THRESHOLD = 5;
const PAYROLL_LATE_PENALTY_AMOUNT = 20000;
const LATE_PENALTY_REASON_CODE = 'LATE_ATTENDANCE_PENALTY';
const UNAUTHORIZED_ABSENCE_PENALTY_AMOUNT = 100000;
const UNAUTHORIZED_ABSENCE_REASON_CODE = 'UNAUTHORIZED_ABSENCE_PENALTY';
const SHIFT_WORK_ROLES = [Role.MANAGER, Role.USER, Role.KITCHEN];
const ACTIVE_REGISTRATION_STATUSES = [ShiftRegistrationStatus.REGISTERED, ShiftRegistrationStatus.CANCEL_PENDING];

function formatPayrollDate(dateLike: Date | string): string {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) {
    return 'unknown-date';
  }
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class AttendanceService {
  constructor(
    @InjectModel(Attendance.name) private attendanceModel: Model<AttendanceDocument>,
    @InjectModel(LeaveRequest.name) private leaveModel: Model<LeaveRequestDocument>,
    @InjectModel(Payroll.name) private payrollModel: Model<PayrollDocument>,
    @InjectModel(WorkShift.name) private workShiftModel: Model<WorkShiftDocument>,
    @InjectModel(ShiftRegistration.name) private shiftRegistrationModel: Model<ShiftRegistrationDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    private auditLogService: AuditLogService,
    @Optional() @InjectQueue('payroll-queue') private payrollQueue?: Queue,
  ) {}

  private normalizeRequiredStaff(requiredStaffByRole: any) {
    return {
      [Role.MANAGER]: Math.max(0, Math.floor(Number(requiredStaffByRole?.[Role.MANAGER] || 0))),
      [Role.USER]: Math.max(0, Math.floor(Number(requiredStaffByRole?.[Role.USER] || 0))),
      [Role.KITCHEN]: Math.max(0, Math.floor(Number(requiredStaffByRole?.[Role.KITCHEN] || 0))),
    };
  }

  private getDayRange(dateStr?: string) {
    const start = dateStr ? new Date(dateStr) : new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  private getMonthRange(month: string) {
    const [year, monthNum] = month.split('-').map(Number);
    if (!year || !monthNum || monthNum < 1 || monthNum > 12) {
      throw new BadRequestException('Thang khong hop le. Dinh dang dung: YYYY-MM');
    }
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 1);
    return { startDate, endDate };
  }

  private async getShiftWithTenant(tenantId: string, shiftId: any) {
    const shift = await this.workShiftModel.findOne({
      _id: shiftId,
      tenantId: new Types.ObjectId(tenantId),
    }).exec();
    if (!shift) throw new NotFoundException('Shift not found');
    return shift;
  }

  private getShiftIdFromRegistration(registration: any) {
    if (!registration?.shiftId) return '';
    return typeof registration.shiftId === 'string' ? registration.shiftId : registration.shiftId._id?.toString() || registration.shiftId.toString();
  }

  private async enrichShiftsWithCounts(shifts: any[]) {
    const shiftIds = shifts.map((shift) => shift._id);
    if (shiftIds.length === 0) return shifts;

    const registrations = await this.shiftRegistrationModel.find({
      shiftId: { $in: shiftIds },
      status: { $in: ACTIVE_REGISTRATION_STATUSES },
    }).exec();

    return shifts.map((shift) => {
      const counts = {
        [Role.MANAGER]: 0,
        [Role.USER]: 0,
        [Role.KITCHEN]: 0,
      };
      registrations
        .filter((registration) => registration.shiftId.toString() === shift._id.toString())
        .forEach((registration) => {
          if (SHIFT_WORK_ROLES.includes(registration.role)) {
            counts[registration.role as Role.MANAGER | Role.USER | Role.KITCHEN] += 1;
          }
        });

      return {
        ...(shift.toObject ? shift.toObject() : shift),
        registeredStaffByRole: counts,
      };
    });
  }

  private async markNoShowsForRange(tenantId: string, startDate: Date, endDate: Date) {
    const now = new Date();
    const endedShifts = await this.workShiftModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: WorkShiftStatus.APPROVED,
      startAt: { $gte: startDate, $lt: endDate },
      endAt: { $lt: now },
    }).exec();

    if (endedShifts.length === 0) return;

    const shiftIds = endedShifts.map((shift) => shift._id);
    const registrations = await this.shiftRegistrationModel.find({
      tenantId: new Types.ObjectId(tenantId),
      shiftId: { $in: shiftIds },
      status: { $in: ACTIVE_REGISTRATION_STATUSES },
    }).exec();

    if (registrations.length === 0) return;

    const registrationIds = registrations.map((registration) => registration._id);
    const attendances = await this.attendanceModel.find({
      tenantId: new Types.ObjectId(tenantId),
      shiftRegistrationId: { $in: registrationIds },
    }).exec();
    const attendedIds = new Set(attendances.map((attendance) => attendance.shiftRegistrationId?.toString()).filter(Boolean));

    await Promise.all(
      registrations
        .filter((registration) => !attendedIds.has(registration._id.toString()))
        .map(async (registration) => {
          registration.status = ShiftRegistrationStatus.NO_SHOW;
          registration.absencePenaltyAmount = UNAUTHORIZED_ABSENCE_PENALTY_AMOUNT;
          return registration.save();
        }),
    );
  }

  private async resolveRegistrationForCheckIn(tenantId: string, userId: string, shiftRegistrationId?: string) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const userObjectId = new Types.ObjectId(userId);

    if (shiftRegistrationId) {
      const registration = await this.shiftRegistrationModel.findOne({
        _id: shiftRegistrationId,
        tenantId: tenantObjectId,
        userId: userObjectId,
        status: { $in: ACTIVE_REGISTRATION_STATUSES },
      }).exec();
      if (!registration) throw new NotFoundException('Khong tim thay ca da dang ky');
      const shift = await this.getShiftWithTenant(tenantId, registration.shiftId);
      return { registration, shift };
    }

    const { start, end } = this.getDayRange();
    const shifts = await this.workShiftModel.find({
      tenantId: tenantObjectId,
      status: WorkShiftStatus.APPROVED,
      startAt: { $lt: end },
      endAt: { $gt: start },
    }).exec();
    const shiftIds = shifts.map((shift) => shift._id);
    const registrations = await this.shiftRegistrationModel.find({
      tenantId: tenantObjectId,
      userId: userObjectId,
      shiftId: { $in: shiftIds },
      status: { $in: ACTIVE_REGISTRATION_STATUSES },
    }).exec();

    if (registrations.length === 0) {
      throw new NotFoundException('Ban chua dang ky ca lam hom nay');
    }
    if (registrations.length > 1) {
      throw new BadRequestException('Ban co nhieu ca trong ngay. Vui long chon ca de check-in');
    }

    const registration = registrations[0];
    const shift = shifts.find((candidate) => candidate._id.toString() === registration.shiftId.toString());
    if (!shift) throw new NotFoundException('Shift not found');
    return { registration, shift };
  }

  async createWorkShift(tenantId: string, actorId: string, actorRole: Role, dto: any): Promise<WorkShift> {
    if (![Role.ADMIN, Role.MANAGER].includes(actorRole)) {
      throw new ForbiddenException('Khong co quyen tao ca lam');
    }

    const name = String(dto?.name || '').trim();
    const startAt = new Date(dto?.startAt);
    const endAt = new Date(dto?.endAt);
    const requiredStaffByRole = this.normalizeRequiredStaff(dto?.requiredStaffByRole || dto);

    if (!name) throw new BadRequestException('Ten ca lam la bat buoc');
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException('Gio bat dau/ket thuc khong hop le');
    }
    if (endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('Gio ket thuc phai sau gio bat dau');
    }
    if (Object.values(requiredStaffByRole).every((count) => count <= 0)) {
      throw new BadRequestException('Can nhap so luong nhan vien cho it nhat mot vi tri');
    }

    const overlapping = await this.workShiftModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      status: { $in: [WorkShiftStatus.PENDING_APPROVAL, WorkShiftStatus.APPROVED] },
      startAt: { $lt: endAt },
      endAt: { $gt: startAt },
    }).exec();

    if (overlapping) {
      throw new BadRequestException('Ca lam bi trung gio voi ca da ton tai');
    }

    const status = actorRole === Role.ADMIN ? WorkShiftStatus.APPROVED : WorkShiftStatus.PENDING_APPROVAL;
    const shift = new this.workShiftModel({
      tenantId: new Types.ObjectId(tenantId),
      name,
      startAt,
      endAt,
      requiredStaffByRole,
      status,
      createdBy: new Types.ObjectId(actorId),
      ...(status === WorkShiftStatus.APPROVED ? { approvedBy: new Types.ObjectId(actorId), reviewedAt: new Date() } : {}),
    });

    return shift.save();
  }

  async getWorkShifts(tenantId: string, from?: string, to?: string, status?: string): Promise<any[]> {
    const rangeStart = from ? new Date(from) : new Date();
    if (!from) rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = to ? new Date(to) : new Date(rangeStart);
    if (!to) rangeEnd.setDate(rangeEnd.getDate() + 14);
    if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeEnd <= rangeStart) {
      throw new BadRequestException('Khoang thoi gian khong hop le');
    }

    const query: any = {
      tenantId: new Types.ObjectId(tenantId),
      startAt: { $lt: rangeEnd },
      endAt: { $gt: rangeStart },
    };
    if (status) query.status = status;

    const shifts = await this.workShiftModel.find(query).sort({ startAt: 1 }).exec();
    return this.enrichShiftsWithCounts(shifts);
  }

  async reviewWorkShift(tenantId: string, shiftId: string, reviewerId: string, dto: any): Promise<WorkShift> {
    const shift = await this.getShiftWithTenant(tenantId, shiftId);
    if (shift.status !== WorkShiftStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Chi ca dang cho duyet moi co the duyet');
    }

    const status = dto?.status;
    if (![WorkShiftStatus.APPROVED, WorkShiftStatus.REJECTED].includes(status)) {
      throw new BadRequestException('Trang thai duyet ca khong hop le');
    }

    if (status === WorkShiftStatus.APPROVED) {
      const overlapping = await this.workShiftModel.findOne({
        _id: { $ne: shift._id },
        tenantId: new Types.ObjectId(tenantId),
        status: WorkShiftStatus.APPROVED,
        startAt: { $lt: shift.endAt },
        endAt: { $gt: shift.startAt },
      }).exec();
      if (overlapping) {
        throw new BadRequestException('Ca lam bi trung gio voi ca da duyet');
      }
    }

    shift.status = status;
    shift.approvedBy = new Types.ObjectId(reviewerId);
    shift.reviewedAt = new Date();
    shift.reviewNotes = dto?.reviewNotes;
    return shift.save();
  }

  async getMyShifts(tenantId: string, userId: string, actorRole: Role, from?: string, to?: string): Promise<any[]> {
    if (!SHIFT_WORK_ROLES.includes(actorRole)) {
      throw new ForbiddenException('Role nay khong dang ky ca lam');
    }

    const shifts = await this.getWorkShifts(tenantId, from, to, WorkShiftStatus.APPROVED);
    const registrations = await this.shiftRegistrationModel.find({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      shiftId: { $in: shifts.map((shift) => shift._id) },
    }).exec();
    const registrationMap = new Map(registrations.map((registration) => [registration.shiftId.toString(), registration]));

    return shifts
      .filter((shift) => (shift.requiredStaffByRole?.[actorRole] || 0) > 0 || registrationMap.has(shift._id.toString()))
      .map((shift) => {
        const registration = registrationMap.get(shift._id.toString());
        return {
          ...shift,
          myRegistration: registration ? registration.toObject() : null,
        };
      });
  }

  async registerShift(tenantId: string, userId: string, actorRole: Role, shiftId: string): Promise<ShiftRegistration> {
    if (!SHIFT_WORK_ROLES.includes(actorRole)) {
      throw new ForbiddenException('Role nay khong duoc dang ky ca lam');
    }

    const shift = await this.getShiftWithTenant(tenantId, shiftId);
    if (shift.status !== WorkShiftStatus.APPROVED) {
      throw new BadRequestException('Ca lam chua duoc duyet');
    }
    if (shift.startAt <= new Date()) {
      throw new BadRequestException('Khong the dang ky ca da bat dau hoac da qua');
    }

    const required = Number((shift.requiredStaffByRole as any)?.[actorRole] || 0);
    if (required <= 0) {
      throw new BadRequestException('Ca nay khong can vi tri cua ban');
    }

    const activeCount = await this.shiftRegistrationModel.countDocuments({
      tenantId: new Types.ObjectId(tenantId),
      shiftId: shift._id,
      role: actorRole,
      status: { $in: ACTIVE_REGISTRATION_STATUSES },
    }).exec();
    if (activeCount >= required) {
      throw new BadRequestException('Ca lam da du so luong nhan vien cho vi tri nay');
    }

    const existing = await this.shiftRegistrationModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      shiftId: shift._id,
      userId: new Types.ObjectId(userId),
    }).exec();

    if (existing) {
      if (ACTIVE_REGISTRATION_STATUSES.includes(existing.status)) {
        throw new BadRequestException('Ban da dang ky ca nay');
      }
      if (existing.status === ShiftRegistrationStatus.NO_SHOW) {
        throw new BadRequestException('Ca nay da ket thuc');
      }
      existing.status = ShiftRegistrationStatus.REGISTERED;
      existing.role = actorRole;
      existing.cancelReason = undefined;
      existing.cancelRequestedAt = undefined;
      existing.cancelReviewedAt = undefined;
      existing.cancelReviewedBy = undefined;
      existing.cancelReviewNotes = undefined;
      existing.absencePenaltyAmount = 0;
      return existing.save();
    }

    const registration = new this.shiftRegistrationModel({
      tenantId: new Types.ObjectId(tenantId),
      shiftId: shift._id,
      userId: new Types.ObjectId(userId),
      role: actorRole,
      status: ShiftRegistrationStatus.REGISTERED,
    });
    return registration.save();
  }

  async cancelShiftRegistration(tenantId: string, userId: string, registrationId: string, reason?: string): Promise<ShiftRegistration> {
    const registration = await this.shiftRegistrationModel.findOne({
      _id: registrationId,
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
    }).exec();
    if (!registration) throw new NotFoundException('Khong tim thay dang ky ca');
    if (![ShiftRegistrationStatus.REGISTERED, ShiftRegistrationStatus.CANCEL_PENDING].includes(registration.status)) {
      throw new BadRequestException('Dang ky ca khong the huy');
    }

    const attendance = await this.attendanceModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      shiftRegistrationId: registration._id,
      checkInTime: { $exists: true },
    }).exec();
    if (attendance) {
      throw new BadRequestException('Da check-in nen khong the huy ca');
    }

    const shift = await this.getShiftWithTenant(tenantId, registration.shiftId);
    const now = new Date();
    const oneDayBefore = new Date(shift.startAt.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysBefore = new Date(shift.startAt.getTime() - 7 * 24 * 60 * 60 * 1000);

    if (now >= oneDayBefore) {
      throw new BadRequestException('Chi co the yeu cau huy truoc ca it nhat 1 ngay');
    }

    registration.cancelReason = reason;
    registration.cancelRequestedAt = new Date();
    registration.absencePenaltyAmount = 0;

    if (now < sevenDaysBefore) {
      registration.status = ShiftRegistrationStatus.CANCELLED;
      registration.cancelReviewedAt = new Date();
      return registration.save();
    }

    registration.status = ShiftRegistrationStatus.CANCEL_PENDING;
    return registration.save();
  }

  async reviewShiftCancellation(tenantId: string, registrationId: string, reviewerId: string, dto: any): Promise<ShiftRegistration> {
    const registration = await this.shiftRegistrationModel.findOne({
      _id: registrationId,
      tenantId: new Types.ObjectId(tenantId),
    }).exec();
    if (!registration) throw new NotFoundException('Khong tim thay yeu cau huy ca');
    if (registration.status !== ShiftRegistrationStatus.CANCEL_PENDING) {
      throw new BadRequestException('Chi yeu cau huy dang cho duyet moi co the xu ly');
    }

    const status = dto?.status;
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      throw new BadRequestException('Trang thai duyet huy ca khong hop le');
    }

    registration.status = status === 'APPROVED' ? ShiftRegistrationStatus.LEAVE_APPROVED : ShiftRegistrationStatus.REGISTERED;
    registration.cancelReviewedBy = new Types.ObjectId(reviewerId);
    registration.cancelReviewedAt = new Date();
    registration.cancelReviewNotes = dto?.reviewNotes;
    registration.absencePenaltyAmount = 0;
    return registration.save();
  }

  async checkIn(tenantId: string, userId: string, ipAddress: string, gps?: string, shiftRegistrationId?: string): Promise<Attendance> {
    const user = await this.userModel.findOne({ _id: userId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user || !SHIFT_WORK_ROLES.includes(user.role)) {
      throw new ForbiddenException('Role nay khong duoc cham cong ca lam');
    }

    const { registration, shift } = await this.resolveRegistrationForCheckIn(tenantId, userId, shiftRegistrationId);
    if (shift.status !== WorkShiftStatus.APPROVED) {
      throw new BadRequestException('Ca lam chua duoc duyet');
    }

    const existing = await this.attendanceModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      shiftRegistrationId: registration._id,
    }).exec();

    if (existing) {
      throw new BadRequestException('Ban da check-in ca nay');
    }

    const tenant = await this.tenantModel.findById(tenantId).exec();
    const lateThreshold = tenant?.settings?.lateThresholdMinutes || 5;
    const now = new Date();
    let status = AttendanceStatus.ON_TIME;
    const lateMinutes = Math.max(0, Math.floor((now.getTime() - shift.startAt.getTime()) / (1000 * 60)));
    if (lateMinutes > lateThreshold) {
      status = AttendanceStatus.LATE;
    }

    if (registration.status === ShiftRegistrationStatus.CANCEL_PENDING) {
      registration.status = ShiftRegistrationStatus.REGISTERED;
      registration.cancelReason = undefined;
      registration.cancelRequestedAt = undefined;
      registration.cancelReviewedAt = undefined;
      registration.cancelReviewedBy = undefined;
      registration.cancelReviewNotes = undefined;
      await registration.save();
    }

    const date = new Date(shift.startAt);
    date.setHours(0, 0, 0, 0);
    const attendance = new this.attendanceModel({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      shiftRegistrationId: registration._id,
      date,
      checkInTime: now,
      ipAddress,
      gps,
      status,
      lateMinutes,
    });

    return attendance.save();
  }

  async checkOut(tenantId: string, userId: string, shiftRegistrationId?: string): Promise<Attendance> {
    const query: any = {
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      checkOutTime: { $exists: false },
    };
    if (shiftRegistrationId) {
      query.shiftRegistrationId = new Types.ObjectId(shiftRegistrationId);
    }

    const attendances = await this.attendanceModel.find(query).sort({ checkInTime: -1 }).exec();

    if (attendances.length === 0) {
      throw new NotFoundException('Khong tim thay ban ghi check-in dang mo');
    }
    if (!shiftRegistrationId && attendances.length > 1) {
      throw new BadRequestException('Ban co nhieu ca dang mo. Vui long chon ca de check-out');
    }

    const attendance = attendances[0];
    if (attendance.checkOutTime) {
      throw new BadRequestException('Ban da check-out ca nay');
    }

    attendance.checkOutTime = new Date();
    const checkInMs = attendance.checkInTime ? attendance.checkInTime.getTime() : Date.now();
    const diffMs = attendance.checkOutTime.getTime() - checkInMs;
    attendance.totalHours = parseFloat((diffMs / (1000 * 60 * 60)).toFixed(2));

    return attendance.save();
  }

  async editAttendance(
    tenantId: string,
    attendanceId: string,
    editorId: string,
    updates: { checkInTime?: string; checkOutTime?: string },
    ipAddress: string,
  ): Promise<Attendance> {
    const attendance = await this.attendanceModel.findOne({
      _id: attendanceId,
      tenantId: new Types.ObjectId(tenantId),
    }).exec();
    if (!attendance) throw new NotFoundException('Attendance record not found');

    // Store old values for audit
    const oldValues = {
      checkInTime: attendance.checkInTime,
      checkOutTime: attendance.checkOutTime,
    };

    if (updates.checkInTime) {
      attendance.checkInTime = new Date(updates.checkInTime);
    }
    if (updates.checkOutTime) {
      attendance.checkOutTime = new Date(updates.checkOutTime);
    }

    // Recalculate total hours
    if (attendance.checkInTime && attendance.checkOutTime) {
      const diffMs = attendance.checkOutTime.getTime() - attendance.checkInTime.getTime();
      attendance.totalHours = parseFloat((diffMs / (1000 * 60 * 60)).toFixed(2));
    }

    const saved = await attendance.save();

    // Audit log
    await this.auditLogService.log(
      tenantId,
      editorId,
      'EDIT_ATTENDANCE',
      {
        attendanceId,
        userId: attendance.userId,
        oldValues,
        newValues: { checkInTime: attendance.checkInTime, checkOutTime: attendance.checkOutTime },
      },
      ipAddress,
    );

    return saved;
  }

  async getDailyAttendance(tenantId: string, dateStr?: string): Promise<any[]> {
    const { start, end } = this.getDayRange(dateStr);
    await this.markNoShowsForRange(tenantId, start, end);

    const shifts = await this.workShiftModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: WorkShiftStatus.APPROVED,
      startAt: { $lt: end },
      endAt: { $gt: start },
    }).sort({ startAt: 1 }).exec();
    if (shifts.length === 0) return [];

    const shiftMap = new Map(shifts.map((shift) => [shift._id.toString(), shift]));
    const registrations = await this.shiftRegistrationModel.find({
      tenantId: new Types.ObjectId(tenantId),
      shiftId: { $in: shifts.map((shift) => shift._id) },
      status: {
        $in: [
          ShiftRegistrationStatus.REGISTERED,
          ShiftRegistrationStatus.CANCEL_PENDING,
          ShiftRegistrationStatus.LEAVE_APPROVED,
          ShiftRegistrationStatus.NO_SHOW,
        ],
      },
    }).sort({ role: 1 }).exec();

    if (registrations.length === 0) return [];

    const userIds = registrations.map((registration) => registration.userId);
    const users = await this.userModel.find({
      _id: { $in: userIds },
      tenantId: new Types.ObjectId(tenantId),
      role: { $in: SHIFT_WORK_ROLES },
    } as any).select('name email role').exec();
    const userMap = new Map(users.map((user) => [(user as any)._id.toString(), user]));

    const attendances = await this.attendanceModel.find({
      tenantId: new Types.ObjectId(tenantId),
      shiftRegistrationId: { $in: registrations.map((registration) => registration._id) },
    }).exec();
    const attendanceMap = new Map(attendances.map((attendance) => [attendance.shiftRegistrationId?.toString(), attendance]));

    return registrations
      .map((registration) => {
        const user = userMap.get(registration.userId.toString());
        const shift = shiftMap.get(registration.shiftId.toString());
        if (!user || !shift) return null;
        const attendance = attendanceMap.get(registration._id.toString());
        const registrationStatus = registration.status;
        const status =
          registrationStatus === ShiftRegistrationStatus.LEAVE_APPROVED
            ? AttendanceStatus.ON_LEAVE
            : attendance?.status || AttendanceStatus.ABSENT;

        return {
          userId: (user as any)._id,
          name: user.name,
          email: user.email,
          role: user.role,
          attendanceId: attendance?._id || null,
          shiftRegistrationId: registration._id,
          registrationStatus,
          shiftId: shift._id,
          shiftName: shift.name,
          shiftStartAt: shift.startAt,
          shiftEndAt: shift.endAt,
          checkInTime: attendance?.checkInTime || null,
          checkOutTime: attendance?.checkOutTime || null,
          totalHours: attendance?.totalHours || 0,
          status,
          lateMinutes: attendance?.lateMinutes || 0,
          ipAddress: attendance?.ipAddress || null,
        };
      })
      .filter(Boolean);
  }

  async getMonthlyAttendance(tenantId: string, userId: string, month: string): Promise<any> {
    const { startDate, endDate } = this.getMonthRange(month);
    await this.markNoShowsForRange(tenantId, startDate, endDate);

    const shifts = await this.workShiftModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: WorkShiftStatus.APPROVED,
      startAt: { $gte: startDate, $lt: endDate },
    }).sort({ startAt: 1 }).exec();
    const shiftMap = new Map(shifts.map((shift) => [shift._id.toString(), shift]));
    const registrations = await this.shiftRegistrationModel.find({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      shiftId: { $in: shifts.map((shift) => shift._id) },
      status: {
        $in: [
          ShiftRegistrationStatus.REGISTERED,
          ShiftRegistrationStatus.CANCEL_PENDING,
          ShiftRegistrationStatus.LEAVE_APPROVED,
          ShiftRegistrationStatus.NO_SHOW,
        ],
      },
    }).sort({ createdAt: 1 }).exec();

    const attendances = await this.attendanceModel.find({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      $or: [
        { shiftRegistrationId: { $in: registrations.map((registration) => registration._id) } },
        { shiftRegistrationId: { $exists: false }, date: { $gte: startDate, $lt: endDate } },
      ],
    }).sort({ date: 1 }).exec();
    const attendanceMap = new Map(attendances.map((attendance) => [attendance.shiftRegistrationId?.toString(), attendance]));

    const leaves = await this.leaveModel.find({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      status: LeaveRequestStatus.APPROVED,
      startDate: { $lt: endDate },
      endDate: { $gte: startDate },
    }).exec();

    const totalWorkedDays = attendances.filter(a => a.checkInTime).length;
    const totalWorkedHours = attendances.reduce((sum, a) => sum + (a.totalHours || 0), 0);
    const totalLateDays = attendances.filter(a => a.status === AttendanceStatus.LATE).length;
    const totalLateMinutes = attendances.reduce((sum, a) => sum + ((a as any).lateMinutes || 0), 0);

    let paidLeaveDays = 0;
    let unpaidLeaveDays = 0;
    leaves.forEach(l => {
      const days = Math.ceil(Math.abs(l.endDate.getTime() - l.startDate.getTime()) / (1000 * 60 * 60 * 24)) || 1;
      if (l.isPaid) {
        paidLeaveDays += days;
      } else {
        unpaidLeaveDays += days;
      }
    });
    paidLeaveDays += registrations.filter((registration) => registration.status === ShiftRegistrationStatus.LEAVE_APPROVED).length;

    const shiftRecords = registrations.map((registration) => {
      const attendance = attendanceMap.get(registration._id.toString());
      const shift = shiftMap.get(registration.shiftId.toString());
      const status =
        registration.status === ShiftRegistrationStatus.LEAVE_APPROVED
          ? AttendanceStatus.ON_LEAVE
          : attendance?.status || AttendanceStatus.ABSENT;
      return {
        _id: attendance?._id || registration._id,
        attendanceId: attendance?._id || null,
        shiftRegistrationId: registration._id,
        registrationStatus: registration.status,
        shiftId: registration.shiftId,
        shiftName: shift?.name || '',
        shiftStartAt: shift?.startAt || null,
        shiftEndAt: shift?.endAt || null,
        date: shift?.startAt || attendance?.date,
        checkInTime: attendance?.checkInTime || null,
        checkOutTime: attendance?.checkOutTime || null,
        totalHours: attendance?.totalHours || 0,
        status,
        lateMinutes: attendance?.lateMinutes || 0,
        ipAddress: attendance?.ipAddress || null,
      };
    });

    const legacyRecords = attendances
      .filter((attendance) => !attendance.shiftRegistrationId)
      .map((attendance) => (attendance.toObject ? attendance.toObject() : attendance));

    return {
      month,
      totalWorkedDays,
      totalWorkedHours: parseFloat(totalWorkedHours.toFixed(2)),
      totalLateDays,
      totalLateMinutes,
      paidLeaveDays,
      unpaidLeaveDays,
      records: [...shiftRecords, ...legacyRecords],
    };
  }

  async createLeaveRequest(tenantId: string, userId: string, dto: CreateLeaveDto): Promise<LeaveRequest> {
    const req = new this.leaveModel({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      startDate: dto.startDate,
      endDate: dto.endDate,
      reason: dto.reason,
      status: LeaveRequestStatus.PENDING,
    });
    return req.save();
  }

  async reviewLeaveRequest(
    tenantId: string,
    requestId: string,
    reviewerId: string,
    dto: ReviewLeaveDto,
  ): Promise<LeaveRequest> {
    const req = await this.leaveModel.findOne({ _id: requestId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!req) throw new NotFoundException('Leave request not found');

    req.status = dto.status;
    if (dto.reviewNotes) req.reviewNotes = dto.reviewNotes;
    if (dto.isPaid !== undefined) req.isPaid = dto.isPaid;
    req.reviewedBy = new Types.ObjectId(reviewerId);

    return req.save();
  }

  async getPendingLeaves(tenantId: string): Promise<LeaveRequest[]> {
    return this.leaveModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: LeaveRequestStatus.PENDING,
    })
      .populate('userId', 'name email role')
      .sort({ createdAt: -1 })
      .exec();
  }

  async getAllLeaves(tenantId: string, status?: string): Promise<LeaveRequest[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (status) query.status = status;

    return this.leaveModel.find(query)
      .populate('userId', 'name email role')
      .populate('reviewedBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }

  async getHistory(tenantId: string, userId: string): Promise<Attendance[]> {
    return this.attendanceModel.find({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
    }).sort({ date: -1 }).exec();
  }

  async calculatePayrollDirect(tenantId: string, month: string): Promise<void> {
    const { startDate, endDate } = this.getMonthRange(month);
    await this.markNoShowsForRange(tenantId, startDate, endDate);

    const tenant = await this.tenantModel.findById(tenantId).exec();
    const shifts = await this.workShiftModel.find({
      tenantId: new Types.ObjectId(tenantId),
      status: WorkShiftStatus.APPROVED,
      startAt: { $gte: startDate, $lt: endDate },
    }).exec();
    const shiftMap = new Map(shifts.map((shift) => [shift._id.toString(), shift]));
    const registrations = await this.shiftRegistrationModel.find({
      tenantId: new Types.ObjectId(tenantId),
      shiftId: { $in: shifts.map((shift) => shift._id) },
      status: {
        $in: [
          ShiftRegistrationStatus.REGISTERED,
          ShiftRegistrationStatus.CANCEL_PENDING,
          ShiftRegistrationStatus.LEAVE_APPROVED,
          ShiftRegistrationStatus.NO_SHOW,
        ],
      },
    }).exec();
    const attendances = await this.attendanceModel.find({
      tenantId: new Types.ObjectId(tenantId),
      date: { $gte: startDate, $lt: endDate },
    }).exec();

    const userIds = new Set<string>();
    registrations.forEach((registration) => userIds.add(registration.userId.toString()));
    attendances.forEach((attendance) => userIds.add(attendance.userId.toString()));

    if (userIds.size === 0) return;

    const users = await this.userModel.find({
      _id: { $in: Array.from(userIds).map((id) => new Types.ObjectId(id)) },
      tenantId: new Types.ObjectId(tenantId),
      role: { $in: SHIFT_WORK_ROLES },
    } as any).exec();

    for (const user of users) {
      const userAttendances = attendances.filter((attendance) => attendance.userId.toString() === user._id.toString());
      const userRegistrations = registrations.filter((registration) => registration.userId.toString() === user._id.toString());

      const workedHours = userAttendances.reduce((sum, att) => sum + (att.totalHours || 0), 0);
      const workedShifts = userAttendances.filter(att => att.checkInTime).length;

      const leaves = await this.leaveModel.find({
        tenantId: new Types.ObjectId(tenantId),
        userId: user._id,
        status: LeaveRequestStatus.APPROVED,
        isPaid: false,
        startDate: { $gte: startDate, $lt: endDate },
      }).exec();

      let unpaidLeaveDays = 0;
      leaves.forEach(l => {
        const diffTime = Math.abs(l.endDate.getTime() - l.startDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
        unpaidLeaveDays += diffDays;
      });

      const baseHourly = user.salaryConfig?.baseHourly || 0;
      const baseShift = user.salaryConfig?.baseShift || 0;
      const overtimeMultiplier = user.salaryConfig?.overtimeMultiplier || 1.5;
      const standardHours = (tenant?.settings?.standardHoursPerDay || 8);

      let basePay = 0;
      let baseSalary = 0;
      let overtimeHours = 0;
      let overtimePay = 0;

      if (baseHourly > 0) {
        baseSalary = baseHourly;

        // Calculate regular and overtime hours per day
        for (const att of userAttendances) {
          const hours = att.totalHours || 0;
          if (hours > standardHours) {
            basePay += standardHours * baseHourly;
            const ot = hours - standardHours;
            overtimeHours += ot;
            overtimePay += ot * baseHourly * overtimeMultiplier;
          } else {
            basePay += hours * baseHourly;
          }
        }

        // Deduct unpaid leave
        basePay = Math.max(0, basePay - (unpaidLeaveDays * standardHours * baseHourly));
      } else if (baseShift > 0) {
        baseSalary = baseShift;
        basePay = workedShifts * baseShift;
        basePay = Math.max(0, basePay - (unpaidLeaveDays * baseShift));
      }

      // Allowances (can be configured per user in future)
      const allowances: any[] = [];
      let totalAllowances = 0;

      // Deductions
      const deductions: any[] = [];
      let totalDeductions = 0;
      // Canonical late-penalty rule:
      // - lateMinutes < 5 => 0
      // - lateMinutes >= 5 => 20,000 VND per attendance record
      const latePenaltyRecords = userAttendances
        .filter((a) => (a.lateMinutes || 0) >= PAYROLL_LATE_MINUTES_THRESHOLD)
        .map((a) => {
          const dateText = formatPayrollDate(a.date);
          const lateMinutes = a.lateMinutes || 0;
          return {
            name: `Khoan tru di tre ${dateText}`,
            amount: PAYROLL_LATE_PENALTY_AMOUNT,
            reason: `${LATE_PENALTY_REASON_CODE}|date=${dateText}|lateMinutes=${lateMinutes}`,
          };
        });

      if (latePenaltyRecords.length > 0) {
        deductions.push(...latePenaltyRecords);
        totalDeductions += latePenaltyRecords.reduce((sum, record) => sum + record.amount, 0);
      }

      const noShowPenaltyRecords = userRegistrations
        .filter((registration) => registration.status === ShiftRegistrationStatus.NO_SHOW)
        .map((registration) => {
          const shift = shiftMap.get(registration.shiftId.toString());
          const dateText = shift ? formatPayrollDate(shift.startAt) : 'unknown-date';
          return {
            name: `Khoan tru nghi khong phep ${dateText}`,
            amount: registration.absencePenaltyAmount || UNAUTHORIZED_ABSENCE_PENALTY_AMOUNT,
            reason: `${UNAUTHORIZED_ABSENCE_REASON_CODE}|shiftId=${registration.shiftId.toString()}|date=${dateText}`,
          };
        });

      if (noShowPenaltyRecords.length > 0) {
        deductions.push(...noShowPenaltyRecords);
        totalDeductions += noShowPenaltyRecords.reduce((sum, record) => sum + record.amount, 0);
      }

      const finalSalary = Math.max(0, basePay + overtimePay + totalAllowances - totalDeductions);

      await this.payrollModel.findOneAndUpdate(
        {
          tenantId: new Types.ObjectId(tenantId),
          userId: user._id,
          month,
        },
        {
          baseSalary,
          workedHours,
          workedShifts,
          overtimeHours,
          overtimePay,
          unpaidLeaveDays,
          allowances,
          totalAllowances,
          deductions,
          totalDeductions,
          totalPayout: finalSalary,
          finalSalary,
          status: 'CALCULATED',
        },
        { upsert: true, new: true },
      ).exec();
    }
  }

  async queuePayrollCalculation(tenantId: string, month: string): Promise<any> {
    if (!this.payrollQueue) {
      await this.calculatePayrollDirect(tenantId, month);
      return {
        jobId: 'sync_job_' + Date.now(),
        status: 'COMPLETED',
        message: `Payroll calculated synchronously because Redis queue is disabled`,
      };
    }

    try {
      const job = await this.payrollQueue.add('calculate-payroll', { tenantId, month });
      return { jobId: job.id, status: 'QUEUED', message: `Payroll calculation job queued for month ${month}` };
    } catch (e) {
      console.warn('Queue addition failed. Falling back to synchronous calculation.', e);
      await this.calculatePayrollDirect(tenantId, month);
      return { jobId: 'sync_job_' + Date.now(), status: 'COMPLETED', message: `Payroll calculated synchronously due to queue unavailability` };
    }
  }

  async getPayrolls(tenantId: string, month: string): Promise<Payroll[]> {
    return this.payrollModel.find({
      tenantId: new Types.ObjectId(tenantId),
      month,
    }).populate('userId', 'name email role').exec();
  }

  async getPayrollDetail(tenantId: string, userId: string, month: string): Promise<Payroll> {
    const payroll = await this.payrollModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      month,
    }).populate('userId', 'name email role').exec();

    if (!payroll) throw new NotFoundException('Payroll record not found');
    return payroll;
  }

  async adjustPayroll(
    tenantId: string,
    payrollId: string,
    adjustments: {
      allowances?: { name: string; amount: number }[];
      deductions?: { name: string; amount: number; reason?: string }[];
      adjustmentNote?: string;
    },
  ): Promise<Payroll> {
    const payroll = await this.payrollModel.findOne({
      _id: payrollId,
      tenantId: new Types.ObjectId(tenantId),
    }).exec();

    if (!payroll) throw new NotFoundException('Payroll record not found');
    if (payroll.status === 'CONFIRMED') {
      throw new ForbiddenException('Cannot modify confirmed payroll');
    }

    if (adjustments.allowances) {
      payroll.allowances = adjustments.allowances;
      payroll.totalAllowances = adjustments.allowances.reduce((sum, a) => sum + a.amount, 0);
    }

    if (adjustments.deductions) {
      payroll.deductions = adjustments.deductions;
      payroll.totalDeductions = adjustments.deductions.reduce((sum, d) => sum + d.amount, 0);
    }

    if (adjustments.adjustmentNote) {
      payroll.adjustmentNote = adjustments.adjustmentNote;
    }

    // Recalculate final salary
    const basePay = payroll.totalPayout - payroll.totalAllowances + payroll.totalDeductions; // reverse previous adjustments
    payroll.finalSalary = Math.max(0, basePay + payroll.totalAllowances - payroll.totalDeductions);
    payroll.totalPayout = payroll.finalSalary;

    return payroll.save();
  }

  async confirmPayroll(tenantId: string, month: string, confirmedBy: string): Promise<{ message: string; count: number }> {
    const result = await this.payrollModel.updateMany(
      {
        tenantId: new Types.ObjectId(tenantId),
        month,
        status: { $ne: 'CONFIRMED' },
      },
      {
        status: 'CONFIRMED',
        confirmedBy: new Types.ObjectId(confirmedBy),
        confirmedAt: new Date(),
      },
    ).exec();

    return {
      message: `Payroll for ${month} has been confirmed and locked`,
      count: result.modifiedCount,
    };
  }
}

