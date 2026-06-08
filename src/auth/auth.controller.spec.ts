import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  const authService = {
    validateUser: jest.fn(),
    checkDeviceAndLogin: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authService,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('requires email and password for login', async () => {
    const req = { headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' }, ip: '::ffff:127.0.0.1' } as any;

    await expect(
      controller.login({ email: 'admin@example.com' } as any, req),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('passes trimmed email + password to validateUser', async () => {
    const req = { headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' }, ip: '::ffff:127.0.0.1' } as any;
    const user = { _id: 'u1' };

    authService.validateUser.mockResolvedValue(user);
    authService.checkDeviceAndLogin.mockResolvedValue({ access_token: 'token' });

    const result = await controller.login(
      { email: ' Admin@Example.com ', password: ' Admin@123 ', deviceId: 'd1' } as any,
      req,
    );

    expect(authService.validateUser).toHaveBeenCalledWith('admin@example.com', 'Admin@123', '127.0.0.1');
    expect(authService.checkDeviceAndLogin).toHaveBeenCalledWith(user, 'd1', 'unknown', '127.0.0.1');
    expect(result).toEqual({ access_token: 'token' });
  });
});
