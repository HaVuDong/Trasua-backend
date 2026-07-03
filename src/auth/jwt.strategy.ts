import { Injectable, UnauthorizedException } from '@nestjs/common';
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
      throw new UnauthorizedException('User not found');
    }

    if ((user.status || UserStatus.ACTIVE) !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not active');
    }

    const tokenAuthVersion = payload.authVersion || 1;
    const currentAuthVersion = user.authVersion || 1;
    if (tokenAuthVersion !== currentAuthVersion) {
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
