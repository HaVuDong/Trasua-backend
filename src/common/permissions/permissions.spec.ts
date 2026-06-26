import { Role } from '../../users/schemas/user.schema';
import { Permission } from './permission.enum';
import { getEffectivePermissions, hasEffectivePermission } from './permissions';

describe('permissions foundation', () => {
  it('gives ADMIN full permissions by default', () => {
    const permissions = getEffectivePermissions(Role.ADMIN);

    expect(permissions).toEqual(
      expect.arrayContaining(Object.values(Permission)),
    );
  });

  it('applies allow and deny overrides with deny taking precedence', () => {
    const permissions = getEffectivePermissions(Role.USER, {
      allow: [Permission.ORDER_DISCOUNT, Permission.REPORT_VIEW],
      deny: [Permission.ORDER_DISCOUNT],
    });

    expect(permissions).toContain(Permission.REPORT_VIEW);
    expect(permissions).not.toContain(Permission.ORDER_DISCOUNT);
  });

  it('checks effective permissions on request user objects', () => {
    expect(
      hasEffectivePermission(
        {
          role: Role.USER,
          effectivePermissions: [Permission.ORDER_DISCOUNT],
        },
        Permission.ORDER_DISCOUNT,
      ),
    ).toBe(true);
  });
});
