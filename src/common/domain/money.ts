import { BadRequestException } from '@nestjs/common';

export const INTEGER_VND_MESSAGE = 'Money values must be stored as integer VND';

export function isIntegerVnd(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value)
  );
}

export function integerVndValidator(value: unknown): boolean {
  return value === undefined || value === null || isIntegerVnd(value);
}

export function assertIntegerVnd(value: unknown, fieldName = 'amount'): number {
  if (!isIntegerVnd(value)) {
    throw new BadRequestException(`${fieldName} phai la so nguyen VND`);
  }
  return value;
}
