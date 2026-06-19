import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Tenant, TenantSchema } from '../tenants/schemas/tenant.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { SignupRequest, SignupRequestSchema } from './schemas/signup-request.schema';
import { PublicSignupController } from './public-signup.controller';
import { PublicSignupService } from './public-signup.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SignupRequest.name, schema: SignupRequestSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [PublicSignupController],
  providers: [PublicSignupService],
})
export class PublicSignupModule {}
