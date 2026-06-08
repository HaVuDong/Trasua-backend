import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { Attendance, AttendanceSchema } from './schemas/attendance.schema';
import { LeaveRequest, LeaveRequestSchema } from './schemas/leave-request.schema';
import { Payroll, PayrollSchema } from './schemas/payroll.schema';
import { WorkShift, WorkShiftSchema } from './schemas/work-shift.schema';
import { ShiftRegistration, ShiftRegistrationSchema } from './schemas/shift-registration.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Tenant, TenantSchema } from '../tenants/schemas/tenant.schema';
import { PayrollProcessor } from './payroll.processor';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Attendance.name, schema: AttendanceSchema },
      { name: LeaveRequest.name, schema: LeaveRequestSchema },
      { name: Payroll.name, schema: PayrollSchema },
      { name: WorkShift.name, schema: WorkShiftSchema },
      { name: ShiftRegistration.name, schema: ShiftRegistrationSchema },
      { name: User.name, schema: UserSchema },
      { name: Tenant.name, schema: TenantSchema },
    ]),
    BullModule.registerQueue({
      name: 'payroll-queue',
    }),
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService, PayrollProcessor],
  exports: [AttendanceService],
})
export class AttendanceModule {}
