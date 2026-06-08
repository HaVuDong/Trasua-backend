import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserSchema, UserDocument, Role } from './users/schemas/user.schema';
// @ts-ignore
import * as bcrypt from 'bcrypt';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
})
class SeedModule { }

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(SeedModule);
  const userModel = app.get<Model<UserDocument>>(getModelToken(User.name));

  const adminEmail = 'owner@trasua.saas';
  const existingOwner = await userModel.findOne({ email: adminEmail });

  if (!existingOwner) {
    const passwordHash = await bcrypt.hash('SystemOwner@2026', 10);
    const newOwner = new userModel({
      name: 'System Owner',
      email: adminEmail,
      phone: '000000000',
      passwordHash,
      role: Role.SYSTEM_OWNER,
      mustChangePassword: true,
    });
    await newOwner.save();
    console.log('SYSTEM_OWNER account created successfully: owner@trasua.saas');
  } else {
    console.log('SYSTEM_OWNER account already exists');
  }

  await app.close();
}
bootstrap();
