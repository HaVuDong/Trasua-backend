import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Attendance, AttendanceDocument } from './schemas/attendance.schema';
import { LeaveRequest, LeaveRequestDocument, LeaveRequestStatus } from './schemas/leave-request.schema';
import { Payroll, PayrollDocument } from './schemas/payroll.schema';
import { WorkShift, WorkShiftDocument, WorkShiftStatus } from './schemas/work-shift.schema';
import { ShiftRegistration, ShiftRegistrationDocument, ShiftRegistrationStatus } from './schemas/shift-registration.schema';
import { User, UserDocument, Role } from '../users/schemas/user.schema';

const SHIFT_WORK_ROLES = [Role.MANAGER, Role.USER, Role.KITCHEN];
const PAYROLL_LATE_MINUTES_THRESHOLD = 5;
const PAYROLL_LATE_PENALTY_AMOUNT = 20000;
const LATE_PENALTY_REASON_CODE = 'LATE_ATTENDANCE_PENALTY';
const UNAUTHORIZED_ABSENCE_PENALTY_AMOUNT = 100000;
const UNAUTHORIZED_ABSENCE_REASON_CODE = 'UNAUTHORIZED_ABSENCE_PENALTY';

function formatPayrollDate(dateLike: Date | string): string {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) {
    return 'unknown-date';
  }
  return date.toISOString().slice(0, 10);
}

@Processor('payroll-queue')
export class PayrollProcessor extends WorkerHost {
  private readonly logger = new Logger(PayrollProcessor.name);

  constructor(
    @InjectModel(Attendance.name) private attendanceModel: Model<AttendanceDocument>,
    @InjectModel(LeaveRequest.name) private leaveModel: Model<LeaveRequestDocument>,
    @InjectModel(Payroll.name) private payrollModel: Model<PayrollDocument>,
    @InjectModel(WorkShift.name) private workShiftModel: Model<WorkShiftDocument>,
    @InjectModel(ShiftRegistration.name) private shiftRegistrationModel: Model<ShiftRegistrationDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { tenantId, month } = job.data;
    this.logger.log(`Processing payroll job ${job.id} for tenant: ${tenantId}, month: ${month}`);

    // Parse month (format: "YYYY-MM")
    const [year, monthStr] = month.split('-').map(Number);
    const startDate = new Date(year, monthStr - 1, 1);
    const endDate = new Date(year, monthStr, 1); // Start of next month

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

      // 2. Get unpaid leave requests in month range
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

      // 3. Compute salary
      const baseHourly = user.salaryConfig?.baseHourly || 0;
      const baseShift = user.salaryConfig?.baseShift || 0;
      const overtimeMultiplier = user.salaryConfig?.overtimeMultiplier || 1.5;
      let totalPayout = 0;
      let baseSalary = 0;
      let overtimeHours = 0;
      let overtimePay = 0;

      if (baseHourly > 0) {
        baseSalary = baseHourly;
        for (const att of userAttendances) {
          const hours = att.totalHours || 0;
          if (hours > 8) {
            totalPayout += 8 * baseHourly;
            const ot = hours - 8;
            overtimeHours += ot;
            overtimePay += ot * baseHourly * overtimeMultiplier;
          } else {
            totalPayout += hours * baseHourly;
          }
        }
        totalPayout += overtimePay;
        // Deduct 8 hours for each unpaid leave day
        totalPayout = Math.max(0, totalPayout - (unpaidLeaveDays * 8 * baseHourly));
      } else if (baseShift > 0) {
        baseSalary = baseShift;
        totalPayout = workedShifts * baseShift;
        // Deduct shift wage for unpaid leave
        totalPayout = Math.max(0, totalPayout - (unpaidLeaveDays * baseShift));
      }

      const deductions: any[] = [];
      let totalDeductions = 0;

      const latePenaltyRecords = userAttendances
        .filter((attendance) => (attendance.lateMinutes || 0) >= PAYROLL_LATE_MINUTES_THRESHOLD)
        .map((attendance) => {
          const dateText = formatPayrollDate(attendance.date);
          return {
            name: `Khoan tru di tre ${dateText}`,
            amount: PAYROLL_LATE_PENALTY_AMOUNT,
            reason: `${LATE_PENALTY_REASON_CODE}|date=${dateText}|lateMinutes=${attendance.lateMinutes || 0}`,
          };
        });
      deductions.push(...latePenaltyRecords);
      totalDeductions += latePenaltyRecords.reduce((sum, record) => sum + record.amount, 0);

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
      deductions.push(...noShowPenaltyRecords);
      totalDeductions += noShowPenaltyRecords.reduce((sum, record) => sum + record.amount, 0);

      const finalSalary = Math.max(0, totalPayout - totalDeductions);

      // 4. Update or save Payroll record
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
          deductions,
          totalDeductions,
          totalPayout: finalSalary,
          finalSalary,
          status: 'CALCULATED',
        },
        { upsert: true, new: true },
      ).exec();
    }

    this.logger.log(`Payroll calculation completed for tenant: ${tenantId}`);
    return { success: true };
  }
}
