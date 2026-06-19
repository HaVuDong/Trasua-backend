import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EmailService } from './email.service';

const mockResendSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: mockResendSend,
    },
  })),
}));

function buildService(config: Record<string, string | undefined>) {
  return new EmailService({
    get: jest.fn((key: string) => config[key]),
  } as unknown as ConfigService);
}

describe('EmailService', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('sends OTP through Resend when RESEND_API_KEY is configured', async () => {
    mockResendSend.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const service = buildService({
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'TraSua POS <onboarding@resend.dev>',
    });

    await expect(service.sendDeviceOtp('owner@gmail.com', '123456', 'Owner')).resolves.toEqual({
      delivered: true,
    });

    expect(Resend).toHaveBeenCalledWith('re_test_key');
    expect(mockResendSend).toHaveBeenCalledWith({
      from: 'TraSua POS <onboarding@resend.dev>',
      to: 'owner@gmail.com',
      subject: 'Ma OTP dang nhap TraSua POS',
      text: 'Xin chao Owner,\n\nMa OTP dang nhap cua ban la: 123456\nMa co hieu luc trong 15 phut.',
    });
  });

  it('fails loudly when Resend is missing', async () => {
    const service = buildService({
      NODE_ENV: 'test',
    });

    await expect(service.sendDeviceOtp('owner@gmail.com', '123456')).rejects.toThrow(ServiceUnavailableException);
  });

  it('fails loudly when RESEND_FROM is missing', async () => {
    const service = buildService({
      RESEND_API_KEY: 're_test_key',
    });

    await expect(service.sendSignupOtp('owner@gmail.com', '123456')).rejects.toThrow(ServiceUnavailableException);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('ignores device OTP bypass in production unless explicitly allowed', () => {
    const service = buildService({
      NODE_ENV: 'production',
      DISABLE_DEVICE_OTP: 'true',
    });

    expect(service.shouldSkipDeviceOtp()).toBe(false);
  });

  it('allows device OTP bypass in production only with the explicit override flag', () => {
    const service = buildService({
      NODE_ENV: 'production',
      DISABLE_DEVICE_OTP: 'true',
      ALLOW_PRODUCTION_DEVICE_OTP_BYPASS: 'true',
    });

    expect(service.shouldSkipDeviceOtp()).toBe(true);
  });

  it('does not expose devOtp fallback when no provider is configured', async () => {
    const service = buildService({});

    await expect(service.sendDeviceOtp('owner@gmail.com', '123456')).rejects.toThrow(ServiceUnavailableException);
  });
});
