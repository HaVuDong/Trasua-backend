# Docker

`package-lock.json` should stay committed. Docker uses it with `npm ci` so production builds install the exact dependency tree.

## Build backend image

```bash
docker build -t trasua-backend .
```

## Run backend only

Create a real `.env` from `.env.example`, then run:

```bash
docker run --env-file .env -p 3000:3000 trasua-backend
```

For production deploys, either configure a real Redis service with `REDIS_URL`, or disable the payroll queue with `DISABLE_REDIS_QUEUE=true`. Do not enable `USE_REDIS_MOCK` in production.

## Run backend with local infrastructure

```bash
docker compose up --build
```

This starts the API, MongoDB, Redis, and MinIO. Replace all sample secrets before production deployment.

## Render without Redis

If you do not have a Redis URL yet, set this environment variable on Render:

```bash
DISABLE_REDIS_QUEUE=true
USE_REDIS_MOCK=false
```

Payroll calculation will run synchronously instead of through BullMQ.

## Render: OTP Email (Resend API — recommended)

Render blocks outbound SMTP ports (587, 465). Use **Resend API** which sends via HTTPS (port 443):

1. Sign up at [resend.com](https://resend.com) (free: 100 emails/day)
2. Get your API key from Settings → API Keys
3. Set these environment variables on Render:

```bash
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM=onboarding@resend.dev
RESEND_TEST_TO=your-resend-account@gmail.com
DISABLE_DEVICE_OTP=false
AUTH_DISABLE_DEVICE_OTP=false
```

> With the free plan, emails are sent from `onboarding@resend.dev`. To use a custom sender, verify your domain on Resend.

You can test the Resend credentials locally before deploying:

```bash
npm run test:resend
```

By default this sends to `RESEND_TEST_TO`; if that is empty, it sends to `SMTP_USER`. You can also pass a recipient directly:

```bash
npm run test:resend -- --to=your-resend-account@gmail.com
```

In production, the backend requires `RESEND_API_KEY` for OTP email. It will not fall back to SMTP because Render blocks outbound SMTP ports.

## Render: Disable OTP (demo only)

If you just need a quick demo without email OTP:

```bash
DISABLE_DEVICE_OTP=true
```

For production, always keep OTP enabled with Resend API configured. Production ignores `DISABLE_DEVICE_OTP=true` unless `ALLOW_PRODUCTION_DEVICE_OTP_BYPASS=true` is also set.

## Local Redis mock

Only use this when developing locally without Redis:

```bash
USE_REDIS_MOCK=true npm run start:dev
```
