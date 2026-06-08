import { Types } from 'mongoose';
import { AttendanceService } from './attendance.service';
import { WorkShiftStatus } from './schemas/work-shift.schema';
import { ShiftRegistrationStatus } from './schemas/shift-registration.schema';
import { Role } from '../users/schemas/user.schema';

function queryResult(value: any) {
  return {
    exec: jest.fn().mockResolvedValue(value),
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
  };
}

function buildModelMock() {
  const model: any = jest.fn().mockImplementation((doc: any) => {
    const saved: any = {
      _id: new Types.ObjectId(),
      ...doc,
      save: jest.fn(),
      toObject() {
        const { save, toObject, ...data } = this;
        return data;
      },
    };
    saved.save.mockResolvedValue(saved);
    return saved;
  });
  model.findOne = jest.fn().mockReturnValue(queryResult(null));
  model.find = jest.fn().mockReturnValue(queryResult([]));
  model.findById = jest.fn().mockReturnValue(queryResult(null));
  model.countDocuments = jest.fn().mockReturnValue(queryResult(0));
  model.findOneAndUpdate = jest.fn().mockReturnValue(queryResult(null));
  model.updateMany = jest.fn().mockReturnValue(queryResult({ modifiedCount: 0 }));
  return model;
}

function buildService(overrides: Partial<Record<string, any>> = {}) {
  const models = {
    attendanceModel: buildModelMock(),
    leaveModel: buildModelMock(),
    payrollModel: buildModelMock(),
    workShiftModel: buildModelMock(),
    shiftRegistrationModel: buildModelMock(),
    userModel: buildModelMock(),
    tenantModel: buildModelMock(),
    auditLogService: { log: jest.fn().mockResolvedValue(undefined) },
    payrollQueue: { add: jest.fn().mockResolvedValue({ id: 'job-1' }) },
    ...overrides,
  };

  const service = new AttendanceService(
    models.attendanceModel,
    models.leaveModel,
    models.payrollModel,
    models.workShiftModel,
    models.shiftRegistrationModel,
    models.userModel,
    models.tenantModel,
    models.auditLogService,
    models.payrollQueue,
  );

  return { service, models };
}

describe('AttendanceService shift scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates ADMIN shifts as approved and MANAGER shifts as pending', async () => {
    const { service, models } = buildService();
    models.workShiftModel.findOne.mockReturnValue(queryResult(null));
    const tenantId = new Types.ObjectId().toString();
    const actorId = new Types.ObjectId().toString();
    const dto = {
      name: 'Ca sang',
      startAt: '2026-06-10T08:00:00.000Z',
      endAt: '2026-06-10T12:00:00.000Z',
      requiredStaffByRole: { MANAGER: 1, USER: 2, KITCHEN: 1 },
    };

    const adminShift = await service.createWorkShift(tenantId, actorId, Role.ADMIN, dto);
    const managerShift = await service.createWorkShift(tenantId, actorId, Role.MANAGER, dto);

    expect(adminShift.status).toBe(WorkShiftStatus.APPROVED);
    expect(adminShift.approvedBy?.toString()).toBe(actorId);
    expect(managerShift.status).toBe(WorkShiftStatus.PENDING_APPROVAL);
    expect(models.workShiftModel).toHaveBeenCalledTimes(2);
  });

  it('blocks overlapping approved or pending shifts', async () => {
    const { service, models } = buildService();
    models.workShiftModel.findOne.mockReturnValue(queryResult({ _id: new Types.ObjectId() }));

    await expect(
      service.createWorkShift(
        new Types.ObjectId().toString(),
        new Types.ObjectId().toString(),
        Role.ADMIN,
        {
          name: 'Trung gio',
          startAt: '2026-06-10T08:00:00.000Z',
          endAt: '2026-06-10T12:00:00.000Z',
          requiredStaffByRole: { USER: 1 },
        },
      ),
    ).rejects.toThrow('Ca lam bi trung gio');
  });

  it('registers only allowed staff roles and blocks full slots', async () => {
    const { service, models } = buildService();
    const tenantId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    const shift = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(tenantId),
      startAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      endAt: new Date(Date.now() + 52 * 60 * 60 * 1000),
      status: WorkShiftStatus.APPROVED,
      requiredStaffByRole: { MANAGER: 0, USER: 1, KITCHEN: 0 },
    };
    models.workShiftModel.findOne.mockReturnValue(queryResult(shift));
    models.shiftRegistrationModel.countDocuments.mockReturnValue(queryResult(0));
    models.shiftRegistrationModel.findOne.mockReturnValue(queryResult(null));

    await expect(service.registerShift(tenantId, userId, Role.ADMIN, shift._id.toString())).rejects.toThrow('Role nay khong duoc dang ky ca lam');
    await expect(service.registerShift(tenantId, userId, Role.USER, shift._id.toString())).resolves.toMatchObject({
      role: Role.USER,
      status: ShiftRegistrationStatus.REGISTERED,
    });

    models.shiftRegistrationModel.countDocuments.mockReturnValue(queryResult(1));
    await expect(service.registerShift(tenantId, userId, Role.USER, shift._id.toString())).rejects.toThrow('Ca lam da du so luong');
  });

  it('handles cancellation windows', async () => {
    const { service, models } = buildService();
    const tenantId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    const registration: any = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(tenantId),
      userId: new Types.ObjectId(userId),
      shiftId: new Types.ObjectId(),
      status: ShiftRegistrationStatus.REGISTERED,
      save: jest.fn(),
    };
    registration.save.mockResolvedValue(registration);
    models.shiftRegistrationModel.findOne.mockReturnValue(queryResult(registration));
    models.attendanceModel.findOne.mockReturnValue(queryResult(null));

    models.workShiftModel.findOne.mockReturnValue(queryResult({
      _id: registration.shiftId,
      startAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    }));
    await expect(service.cancelShiftRegistration(tenantId, userId, registration._id.toString(), 'Ban viec')).resolves.toMatchObject({
      status: ShiftRegistrationStatus.CANCELLED,
    });

    registration.status = ShiftRegistrationStatus.REGISTERED;
    models.workShiftModel.findOne.mockReturnValue(queryResult({
      _id: registration.shiftId,
      startAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    }));
    await expect(service.cancelShiftRegistration(tenantId, userId, registration._id.toString(), 'Ban viec')).resolves.toMatchObject({
      status: ShiftRegistrationStatus.CANCEL_PENDING,
    });

    registration.status = ShiftRegistrationStatus.REGISTERED;
    models.workShiftModel.findOne.mockReturnValue(queryResult({
      _id: registration.shiftId,
      startAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    }));
    await expect(service.cancelShiftRegistration(tenantId, userId, registration._id.toString(), 'Ban viec')).rejects.toThrow('truoc ca it nhat 1 ngay');
  });

  it('adds unauthorized absence deduction for registered shift without check-in', async () => {
    const { service, models } = buildService();
    const tenantId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId();
    const shiftId = new Types.ObjectId();
    const registration: any = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(tenantId),
      shiftId,
      userId,
      role: Role.USER,
      status: ShiftRegistrationStatus.REGISTERED,
      absencePenaltyAmount: 0,
      save: jest.fn(),
    };
    registration.save.mockResolvedValue(registration);
    const shift = {
      _id: shiftId,
      startAt: new Date('2026-06-10T08:00:00.000Z'),
      endAt: new Date('2026-06-10T12:00:00.000Z'),
      status: WorkShiftStatus.APPROVED,
    };
    const user: any = {
      _id: userId,
      role: Role.USER,
      salaryConfig: { baseShift: 200000 },
    };

    models.workShiftModel.find
      .mockReturnValueOnce(queryResult([shift]))
      .mockReturnValueOnce(queryResult([shift]));
    models.shiftRegistrationModel.find
      .mockReturnValueOnce(queryResult([registration]))
      .mockReturnValueOnce(queryResult([registration]));
    models.attendanceModel.find
      .mockReturnValueOnce(queryResult([]))
      .mockReturnValueOnce(queryResult([]));
    models.tenantModel.findById.mockReturnValue(queryResult({ settings: { standardHoursPerDay: 8 } }));
    models.leaveModel.find.mockReturnValue(queryResult([]));
    models.userModel.find.mockReturnValue(queryResult([user]));
    models.payrollModel.findOneAndUpdate.mockReturnValue(queryResult({}));

    await service.calculatePayrollDirect(tenantId, '2026-06');

    expect(registration.status).toBe(ShiftRegistrationStatus.NO_SHOW);
    expect(registration.absencePenaltyAmount).toBe(100000);
    expect(models.payrollModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        totalDeductions: 100000,
        finalSalary: 0,
        deductions: expect.arrayContaining([
          expect.objectContaining({
            amount: 100000,
            reason: expect.stringContaining('UNAUTHORIZED_ABSENCE_PENALTY'),
          }),
        ]),
      }),
      { upsert: true, new: true },
    );
  });
});
