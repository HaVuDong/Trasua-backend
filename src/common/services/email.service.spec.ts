import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { EmailService } from './email.service';

const mockResendSend = jest.fn();
const mockSendMail = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: mockResendSend,
    },
  })),
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockImplementation(() => ({
    sendMail: mockSendMail,
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
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'smtp@example.com',
      SMTP_PASS: 'smtp-pass',
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
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('fails loudly in production when Resend is missing instead of using SMTP', async () => {
    const service = buildService({
      NODE_ENV: 'production',
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '587',
      SMTP_USER: 'owner@gmail.com',
      SMTP_PASS: 'smtp-pass',
    });

    await expect(service.sendDeviceOtp('owner@gmail.com', '123456')).rejects.toThrow(ServiceUnavailableException);

    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
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

  it('keeps devOtp fallback outside production when no provider is configured', async () => {
    const service = buildService({});

    await expect(service.sendDeviceOtp('owner@gmail.com', '123456')).resolves.toEqual({
      delivered: false,
      devOtp: '123456',
    });
  });
});
