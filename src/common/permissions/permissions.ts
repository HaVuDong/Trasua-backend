import { Role } from '../../users/schemas/user.schema';
import { Permission } from './permission.enum';

export type PermissionOverrides = {
  allow?: Permission[];
  deny?: Permission[];
};

const ALL_PERMISSIONS = Object.values(Permission);

export const ROLE_DEFAULT_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.SYSTEM_OWNER]: ALL_PERMISSIONS,
  [Role.ADMIN]: ALL_PERMISSIONS,
  [Role.MANAGER]: [
    Permission.ORDER_CANCEL_LATE,
    Permission.ORDER_DISCOUNT,
    Permission.REPORT_VIEW,
    Permission.INVENTORY_ADJUST,
    Permission.PRINT_QUEUE_MANAGE,
    Permission.INVOICE_VIEW,
    Permission.INVOICE_PRINT_REQUEST,
    Permission.CASHIER_SHIFT_OPEN,
    Permission.CASHIER_SHIFT_CLOSE,
    Permission.CASHIER_SHIFT_VIEW_HISTORY,
    Permission.MENU_MANAGE,
    Permission.TABLE_MANAGE,
  ],
  [Role.USER]: [
    Permission.INVOICE_VIEW,
    Permission.INVOICE_PRINT_REQUEST,
    Permission.CASHIER_SHIFT_OPEN,
    Permission.CASHIER_SHIFT_CLOSE,
  ],
  [Role.KITCHEN]: [],
};

export function normalizePermissions(
  values?: Permission[] | string[],
): Permission[] {
  return (values || []).filter((value): value is Permission =>
    Object.values(Permission).includes(value as Permission),
  );
}

export function getEffectivePermissions(
  role: Role,
  overrides?: PermissionOverrides,
): Permission[] {
  if (role === Role.SYSTEM_OWNER) return [...ALL_PERMISSIONS];

  const effective = new Set<Permission>(ROLE_DEFAULT_PERMISSIONS[role] || []);
  const allow = normalizePermissions(overrides?.allow);
  const deny = new Set(normalizePermissions(overrides?.deny));

  for (const permission of allow) {
    effective.add(permission);
  }

  for (const permission of deny) {
    effective.delete(permission);
  }

  return [...effective];
}

export function hasEffectivePermission(
  user: {
    role?: Role | string;
    effectivePermissions?: Permission[] | string[];
  },
  permission: Permission,
): boolean {
  if (user.role === Role.SYSTEM_OWNER) return true;
  return normalizePermissions(user.effectivePermissions).includes(permission);
}
