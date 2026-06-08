export class LoginDto {
  email: string;
  password: string;
  deviceId?: string;
}

export class OtpLoginDto {
  otpCode: string;
  deviceId: string;
  userAgent: string;
}
