import { Role } from '../schemas/user.schema';

export class CreateUserDto {
  name: string;
  email: string;
  phone?: string;
  password?: string; // Optional if we send OTP
  role: Role;
  baseHourly?: number;
  baseShift?: number;
}
