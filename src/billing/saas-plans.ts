export type SaasPlanId = 'BASIC' | 'PRO' | 'ENTERPRISE';

export const SAAS_TRIAL_DAYS = 7;

export const SAAS_PLANS: Array<{
  id: SaasPlanId;
  name: string;
  priceMonthly: number;
  currency: 'VND';
  billingCycle: 'MONTHLY';
  maxTables: number;
  maxStaff: number;
  features: string[];
}> = [
  {
    id: 'BASIC',
    name: 'Basic',
    priceMonthly: 199000,
    currency: 'VND',
    billingCycle: 'MONTHLY',
    maxTables: 20,
    maxStaff: 8,
    features: ['QR order', 'Quan ly ban/menu/kho', 'Nhan vien va bep'],
  },
  {
    id: 'PRO',
    name: 'Pro',
    priceMonthly: 399000,
    currency: 'VND',
    billingCycle: 'MONTHLY',
    maxTables: 60,
    maxStaff: 25,
    features: ['Tat ca Basic', 'Bao cao nang cao', 'Thanh toan online'],
  },
  {
    id: 'ENTERPRISE',
    name: 'Enterprise',
    priceMonthly: 799000,
    currency: 'VND',
    billingCycle: 'MONTHLY',
    maxTables: 150,
    maxStaff: 80,
    features: ['Tat ca Pro', 'Gioi han lon hon', 'Ho tro uu tien'],
  },
];

export function getSaasPlan(planId?: string) {
  const normalized = String(planId || 'BASIC').trim().toUpperCase();
  return SAAS_PLANS.find((plan) => plan.id === normalized) || SAAS_PLANS[0];
}

export function isSaasPlanId(planId?: string): planId is SaasPlanId {
  return SAAS_PLANS.some((plan) => plan.id === String(planId || '').trim().toUpperCase());
}
