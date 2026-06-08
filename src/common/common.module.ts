import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { AuditLog, AuditLogSchema } from './schemas/audit-log.schema';
import { IpWhitelistGuard } from './guards/ip-whitelist.guard';
import { AuditLogService } from './services/audit-log.service';
import { EmailService } from './services/email.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
  ],
  providers: [IpWhitelistGuard, AuditLogService, EmailService],
  exports: [IpWhitelistGuard, AuditLogService, EmailService, MongooseModule],
})
export class CommonModule {}
