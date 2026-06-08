import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tenant } from './tenants/schemas/tenant.schema';
import { User, Role } from './users/schemas/user.schema';
import { Table, TableStatus } from './tables/schemas/table.schema';
import { InventoryItem, ItemStatus, ItemCategory } from './inventory/schemas/inventory.schema';
import * as bcrypt from 'bcrypt';

async function seedData() {
  const app = await NestFactory.createApplicationContext(AppModule);
  
  const tenantModel = app.get<Model<Tenant>>(getModelToken(Tenant.name));
  const userModel = app.get<Model<User>>(getModelToken(User.name));
  const tableModel = app.get<Model<Table>>(getModelToken(Table.name));
  const itemModel = app.get<Model<InventoryItem>>(getModelToken(InventoryItem.name));

  // 1. Create a Tenant
  let tenant = await tenantModel.findOne({ name: 'Trà Sữa Mẫu' });
  if (!tenant) {
    tenant = new tenantModel({
      name: 'Trà Sữa Mẫu',
      domain: 'trasua-mau',
      ownerName: 'Nguyễn Văn Chủ',
      email: 'owner@trasua.mau',
      phone: '0987654321',
      status: 'ACTIVE',
      subscription: {
        plan: 'basic',
        status: 'ACTIVE',
        startDate: new Date(),
        endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      },
      settings: {
        lateThresholdMinutes: 5,
        standardHoursPerDay: 8
      }
    });
    await tenant.save();
    console.log('Created Tenant:', tenant._id);
  } else {
    console.log('Tenant already exists:', tenant._id);
  }

  // 2. Create an Admin User
  let admin = await userModel.findOne({ email: 'admin@trasua.mau' });
  if (!admin) {
    const passwordHash = await bcrypt.hash('Admin@123', 10);
    admin = new userModel({
      tenantId: tenant._id,
      name: 'Admin Trà Sữa',
      email: 'admin@trasua.mau',
      phone: '0123456789',
      passwordHash,
      role: Role.ADMIN,
      status: 'ACTIVE'
    });
    await admin.save();
    console.log('Created Admin:', admin._id);
  }

  // 3. Create a Table
  let table = await tableModel.findOne({ name: 'Bàn 1' });
  if (!table) {
    table = new tableModel({
      tenantId: tenant._id,
      name: 'Bàn 1',
      qrCodeToken: 'qr-ban-1-xyz',
      status: TableStatus.EMPTY,
      capacity: 4,
      isHidden: false
    });
    await table.save();
    console.log('Created Table Bàn 1:', table._id);
  }

  // 4. Create some Inventory Items
  const items = [
    { name: 'Trà Sữa Trân Châu', category: ItemCategory.DRINK, sellingPrice: 35000, costPrice: 15000, stock: 100 },
    { name: 'Cà Phê Sữa Đá', category: ItemCategory.DRINK, sellingPrice: 29000, costPrice: 10000, stock: 50 },
    { name: 'Bánh Tiramisu', category: ItemCategory.FOOD, sellingPrice: 45000, costPrice: 20000, stock: 20 }
  ];

  for (const it of items) {
    let item = await itemModel.findOne({ name: it.name, tenantId: tenant._id });
    if (!item) {
      item = new itemModel({
        tenantId: tenant._id,
        name: it.name,
        category: it.category,
        sellingPrice: it.sellingPrice,
        costPrice: it.costPrice,
        stock: it.stock,
        minStockLevel: 10,
        unit: 'Ly',
        status: ItemStatus.ACTIVE,
        imageUrl: ''
      });
      await item.save();
      console.log('Created Item:', item.name);
    }
  }

  console.log('Seeding completed successfully!');
  await app.close();
}

seedData();
