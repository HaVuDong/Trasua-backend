import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Tenant, TenantSchema } from '../tenants/schemas/tenant.schema';
import { AuditLog, AuditLogSchema } from './schemas/audit-log.schema';
import { EmailEvent, EmailEventSchema } from './schemas/email-event.schema';
import { IpWhitelistGuard } from './guards/ip-whitelist.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuditLogService } from './services/audit-log.service';
import { EmailService } from './services/email.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
      { name: EmailEvent.name, schema: EmailEventSchema },
    ]),
  ],
  providers: [IpWhitelistGuard, RolesGuard, AuditLogService, EmailService],
  exports: [
    IpWhitelistGuard,
    RolesGuard,
    AuditLogService,
    EmailService,
    MongooseModule,
  ],
})
export class CommonModule {}
