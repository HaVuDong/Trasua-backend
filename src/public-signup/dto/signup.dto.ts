export class PublicSignupAdminDto {
  name: string;
  email: string;
  phone?: string;
  password: string;
}

export class StartSignupDto {
  storeName: string;
  subdomain?: string;
  address?: string;
  phone: string;
  plan: string;
  admin: PublicSignupAdminDto;
}

export class VerifySignupDto {
  signupId: string;
  otpCode: string;
}

export class ResendSignupOtpDto {
  signupId: string;
}
