import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
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
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        connection: getRedisConnectionOptions(configService),
      }),
      inject: [ConfigService],
    }),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
