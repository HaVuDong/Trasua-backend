import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, AuditLogDocument } from '../schemas/audit-log.schema';

@Injectable()
export class AuditLogService {
  constructor(@InjectModel(AuditLog.name) private logModel: Model<AuditLogDocument>) {}

  async log(tenantId: string, userId: string | undefined, action: string, details?: any, ipAddress?: string): Promise<AuditLog> {
    const log = new this.logModel({
      tenantId: new Types.ObjectId(tenantId),
      userId: userId ? new Types.ObjectId(userId) : undefined,
      action,
      details,
      ipAddress,
    });
    return log.save();
  }

  async logSystem(tenantId: string, action: string, details?: any, ipAddress?: string): Promise<AuditLog> {
    return this.log(tenantId, undefined, action, details, ipAddress);
  }

  async getLogs(tenantId: string, limit = 500): Promise<AuditLog[]> {
    return this.logModel.find({ tenantId: new Types.ObjectId(tenantId) })
      .populate('userId', 'name email role')
      .sort({ createdAt: -1 })
      .limit(Math.max(1, Math.min(1000, limit)))
      .exec();
  }
}
