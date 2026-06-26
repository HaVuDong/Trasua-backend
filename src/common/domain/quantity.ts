import { BadRequestException } from '@nestjs/common';

export enum BaseQuantityUnit {
  GRAM = 'GRAM',
  MILLILITER = 'MILLILITER',
  PIECE = 'PIECE',
  PORTION = 'PORTION',
}

export function isBaseQuantityInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value)
  );
}

export function baseQuantityValidator(value: unknown): boolean {
  return value === undefined || value === null || isBaseQuantityInteger(value);
}

export function assertBaseQuantityInteger(
  value: unknown,
  fieldName = 'quantity',
): number {
  if (!isBaseQuantityInteger(value)) {
    throw new BadRequestException(
      `${fieldName} phai duoc luu bang base unit integer`,
    );
  }
  return value;
}

export function decimalQuantityValidator(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

export function roundQuantity(value: number, precision = 3): number {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}
