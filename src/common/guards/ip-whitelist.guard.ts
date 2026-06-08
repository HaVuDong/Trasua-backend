import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../../users/schemas/user.schema';

@Injectable()
export class IpWhitelistGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // If no user is authenticated or it's a SYSTEM_OWNER, bypass IP checks
    if (!user || user.role === 'SYSTEM_OWNER') {
      return true;
    }

    // Fetch full user record including ipWhitelist
    const dbUser = await this.userModel.findById(user.userId).exec();
    if (!dbUser) {
      throw new ForbiddenException('User not found');
    }

    // If no whitelist is defined, allow access
    if (!dbUser.ipWhitelist || dbUser.ipWhitelist.length === 0) {
      return true;
    }

    const clientIp = request.headers['x-forwarded-for'] || request.socket.remoteAddress || request.ip;
    const ipString = (Array.isArray(clientIp) ? clientIp[0] : clientIp) || '';
    
    // Normalize IP
    const normalizedIp = ipString.replace('::ffff:', '');

    const isAllowed = dbUser.ipWhitelist.some(allowedIp => {
      // Direct match
      if (allowedIp === normalizedIp || allowedIp === '127.0.0.1' || allowedIp === '::1') {
        return true;
      }
      
      // Basic CIDR notation match (e.g. 192.168.1.0/24)
      if (allowedIp.includes('/')) {
        const [subnet, maskStr] = allowedIp.split('/');
        const mask = parseInt(maskStr, 10);
        return this.ipInSubnet(normalizedIp, subnet, mask);
      }

      return false;
    });

    if (!isAllowed) {
      throw new ForbiddenException('Truy cập từ bên ngoài mạng được phép (IP not whitelisted)');
    }

    return true;
  }

  private ipInSubnet(ip: string, subnet: string, mask: number): boolean {
    try {
      const ipParts = ip.split('.').map(Number);
      const subnetParts = subnet.split('.').map(Number);

      if (ipParts.length !== 4 || subnetParts.length !== 4) return false;

      const ipNum = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
      const subnetNum = (subnetParts[0] << 24) + (subnetParts[1] << 16) + (subnetParts[2] << 8) + subnetParts[3];

      const maskNum = -1 << (32 - mask);

      return (ipNum & maskNum) === (subnetNum & maskNum);
    } catch {
      return false;
    }
  }
}
