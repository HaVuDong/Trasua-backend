import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TenantsModule } from './tenants/tenants.module';
import { TablesModule } from './tables/tables.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrdersModule } from './orders/orders.module';
import { AttendanceModule } from './attendance/attendance.module';
import { ChatModule } from './chat/chat.module';
import { ReportsModule } from './reports/reports.module';
import { MenuModule } from './menu/menu.module';
import { PaymentsModule } from './payments/payments.module';
import { PublicSignupModule } from './public-signup/public-signup.module';
import { BillingModule } from './billing/billing.module';

function isRedisQueueDisabled() {
  return process.env.DISABLE_REDIS_QUEUE === 'true' || process.env.REDIS_DISABLED === 'true';
}

function toBoolean(value?: string | boolean) {
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
}

function getRedisConnectionOptions(configService: ConfigService) {
  const redisUrl = configService.get<string>('REDIS_URL');
  const connection: Record<string, any> = {
    maxRetriesPerRequest: null,
  };

  if (redisUrl) {
    const parsed = new URL(redisUrl);
    const db = parsed.pathname.replace(/^\//, '');
    return {
      ...connection,
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db: db ? Number(db) : undefined,
      tls: parsed.protocol === 'rediss:' ? {} : undefined,
    };
  }

  return {
    ...connection,
    host: configService.get<string>('REDIS_HOST', 'localhost'),
    port: Number(configService.get<string>('REDIS_PORT', '6379')),
    username: configService.get<string>('REDIS_USERNAME') || undefined,
    password: configService.get<string>('REDIS_PASSWORD') || undefined,
    tls: toBoolean(configService.get<string>('REDIS_TLS')) ? {} : undefined,
  };
}

function getThrottleTracker(req: Record<string, any>) {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  const ipSource = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) || req.socket?.remoteAddress || req.ip || 'unknown';
  const ip = String(ipSource).replace('::ffff:', '');
  const body = req.body || {};
  const params = req.params || {};
  const contextKey =
    body.sessionId ||
    body.signupId ||
    body.admin?.email ||
    body.tenantId ||
    params.qrToken ||
    params.paymentId ||
    params.tenantId ||
    '';
  return `${ip}:${contextKey}`;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
        getTracker: getThrottleTracker,
      },
    ]),
    ...(
      isRedisQueueDisabled()
        ? []
        : [
            BullModule.forRootAsync({
              imports: [ConfigModule],
              useFactory: async (configService: ConfigService) => ({
                connection: getRedisConnectionOptions(configService),
              }),
              inject: [ConfigService],
            }),
          ]
    ),
    CommonModule,
    AuthModule,
    UsersModule,
    TenantsModule,
    TablesModule,
    InventoryModule,
    OrdersModule,
    MenuModule,
    AttendanceModule,
    ChatModule,
    ReportsModule,
    BillingModule,
    PaymentsModule,
    PublicSignupModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
