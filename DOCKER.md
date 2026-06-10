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

## Local Redis mock

Only use this when developing locally without Redis:

```bash
USE_REDIS_MOCK=true npm run start:dev
```
