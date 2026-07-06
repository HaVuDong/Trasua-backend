import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument, UserStatus } from '../users/schemas/user.schema';
import { getEffectivePermissions } from '../common/permissions/permissions';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  tenantId?: string;
  authVersion?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private configService: ConfigService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>('JWT_SECRET') || 'default_secret_key',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.userModel
      .findById(payload.sub)
      .select(
        'email phone role tenantId status permissionOverrides permissionVersion authVersion',
      )
      .exec();

    if (!user) {
      this.logger.warn(`User not found: ${payload.sub}`);
      throw new UnauthorizedException('JwtStrategy: User not found');
    }

    if ((user.status || UserStatus.ACTIVE) !== UserStatus.ACTIVE) {
      this.logger.warn(`Account not active: ${user.status}`);
      throw new UnauthorizedException('Account is not active');
    }

    const tokenAuthVersion = payload.authVersion || 1;
    const currentAuthVersion = user.authVersion || 1;
    if (tokenAuthVersion !== currentAuthVersion) {
      this.logger.warn(`Session revoked: token=${tokenAuthVersion} current=${currentAuthVersion}`);
      throw new UnauthorizedException('Session has been revoked');
    }

    return {
      userId: user._id.toString(),
      email: user.email,
      phone: user.phone,
      role: user.role,
      tenantId: user.tenantId ? user.tenantId.toString() : null,
      permissionOverrides: user.permissionOverrides || { allow: [], deny: [] },
      effectivePermissions: getEffectivePermissions(
        user.role,
        user.permissionOverrides,
      ),
      permissionVersion: user.permissionVersion || 1,
      authVersion: currentAuthVersion,
    };
  }
}
