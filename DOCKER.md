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

## Run backend with local infrastructure

```bash
docker compose up --build
```

This starts the API, MongoDB, Redis, and MinIO. Replace all sample secrets before production deployment.
