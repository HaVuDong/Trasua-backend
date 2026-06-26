# Production Readiness QA Cho POS/SaaS

Tai lieu nay gom cac buoc kiem tra cuoi truoc pilot quan that. Uu tien dry-run truoc, apply sau.

## 1. MongoDB Audit / Index Migration

Chay audit khong ghi DB:

```bash
cd backend
npm run db:audit:prod-readiness
```

Script bao cao `PASS/WARN/FAIL` cho:

- Index print queue cu va moi.
- Duplicate print job dang mo theo `tenantId + invoiceId + type`.
- Tien cu bi luu dang float/decimal/string trong inventory, menu, payroll, tenant subscription, payment, invoice, cash movement.
- Order cu thieu `costSnapshot`, invoice/payment/session shape.
- Quantity/recipe dang dung decimal.

Migration index print queue:

```bash
cd backend
npm run db:migrate:indexes
npm run db:migrate:indexes -- --apply --backup-confirmed
```

Rule:

- Khong apply neu chua backup DB.
- Khong apply neu con duplicate open print job.
- Script chi drop index print queue cu va tao index moi. Khong tu sua tien float.

## 2. Permission Freshness

Backend co endpoint:

```http
GET /auth/me/permissions
```

Tra ve `userId`, `role`, `tenantId`, `effectivePermissions`, `permissionVersion`.

Khi admin doi role/quyen:

- `permissionVersion` tang.
- Backend emit socket `permissionsUpdated` toi user do.
- Mobile refresh lai tu `/auth/me/permissions`.

Backend van la source-of-truth. JWT cu khong duoc dung de bypass API guard.

## 3. Role / Permission Matrix

Manual QA:

- `ADMIN`: quan ly day du, tao nhan vien, doi quyen, checkout, report.
- `MANAGER`: xem/van hanh theo quyen, bi deny thi API direct phai bi chan.
- `USER`: phuc vu/checkout theo quyen, khong vao kitchen/report neu khong co quyen.
- `KITCHEN`: chi thay bep, khong thay tien/bill/report.

Can test ca UI an nut va API direct bi chan.

## 4. Checkout / Invoice / Payment

Manual/E2E:

- Mot ban cung session tao 2 order.
- Staff confirm, kitchen READY, staff SERVED.
- Manual checkout tao mot cash movement theo table session.
- Bill snapshot du item va tong tien dung.
- Print bill duplicate khong tao nhieu open print job.
- payOS customer/SaaS webhook paid idempotent.
- Cancel webhook khong ghi de payment da `PAID`.

Automated test khong dung giao dich payOS that.

## 5. Resend / Deploy / Logging

Smoke test Resend:

```bash
cd backend
npm run test:resend -- --to=<email-test>
```

Checklist deploy:

- Render co `MONGODB_URI`, `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET`, `PAYOS_*`, CORS/frontend URLs.
- Vercel customer/admin tro dung backend production.
- Mobile web/Expo tro dung API production.
- Log khong in OTP raw, API key, checksum key.
- Audit trail co login OTP, permission change, manual checkout, payOS paid, print request.

## 6. Quantity / Recipe Decision

Phase nay chi audit decimal quantity. Khong migrate base unit.

Backlog rieng: `Inventory Base Unit Migration`

- Chuyen kg/lit sang gram/ml integer.
- Migration recipe va inventory.
- UI convert hien thi unit than thien.
- Reconcile report gia von sau migration.

## Commands

Backend:

```bash
npm run build
npm test -- --runInBand
npm run test:e2e
npm run db:audit:prod-readiness
```

Mobile/admin:

```bash
npm exec -- tsc --noEmit
npm run build:web
```

Frontend customer:

```bash
npm run build
```
