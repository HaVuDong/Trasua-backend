import { Body, Controller, Delete, Get, Param, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { InventoryService } from './inventory.service';
import { CreateItemDto } from './dto/create-item.dto';
import { CreateImportDto } from './dto/create-import.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../users/schemas/user.schema';
import { CurrentUser } from '../common/decorators/current-user.decorator';
// @ts-ignore
import * as ExcelJS from 'exceljs';

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('items')
  @Roles(Role.ADMIN, Role.MANAGER)
  createItem(@CurrentUser() user: any, @Body() dto: CreateItemDto) {
    return this.inventoryService.createItem(user.tenantId, dto);
  }

  @Get('items')
  @Roles(Role.ADMIN, Role.MANAGER)
  findAllItems(@CurrentUser() user: any) {
    return this.inventoryService.findAllItems(user.tenantId);
  }

  @Get('items/alerts')
  @Roles(Role.ADMIN, Role.MANAGER)
  getAlerts(@CurrentUser() user: any) {
    return this.inventoryService.getLowStockAlerts(user.tenantId);
  }

  @Get('items/status')
  @Roles(Role.ADMIN, Role.MANAGER)
  getStatus(@CurrentUser() user: any) {
    return this.inventoryService.getInventoryStatus(user.tenantId);
  }

  @Get('items/export')
  @Roles(Role.ADMIN, Role.MANAGER)
  async exportExcel(@CurrentUser() user: any, @Res() res: any) {
    const items = await this.inventoryService.findAllItems(user.tenantId);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Inventory');

    worksheet.columns = [
      { header: 'Mã hàng', key: 'id', width: 25 },
      { header: 'Tên hàng', key: 'name', width: 25 },
      { header: 'Đơn vị tính', key: 'unit', width: 15 },
      { header: 'Danh mục', key: 'category', width: 15 },
      { header: 'Giá vốn', key: 'costPrice', width: 15 },
      { header: 'Giá bán', key: 'sellingPrice', width: 15 },
      { header: 'Tồn kho', key: 'stock', width: 15 },
      { header: 'Tối thiểu', key: 'minStock', width: 15 },
    ];

    items.forEach(item => {
      worksheet.addRow({
        id: (item as any)._id.toString(),
        name: item.name,
        unit: item.unit,
        category: item.category,
        costPrice: item.costPrice,
        sellingPrice: item.sellingPrice,
        stock: item.stock,
        minStock: item.minStockLevel,
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=' + 'inventory.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  }

  @Get('items/import-template')
  @Roles(Role.ADMIN, Role.MANAGER)
  async downloadImportTemplate(@Res() res: Response) {
    const buffer = await this.inventoryService.buildItemsImportTemplate();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=inventory_import_template.xlsx');
    res.send(buffer);
  }

  @Post('items/import-excel')
  @Roles(Role.ADMIN, Role.MANAGER)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  importItemsFromExcel(@CurrentUser() user: any, @UploadedFile() file: any) {
    return this.inventoryService.importItemsFromExcel(user.tenantId, file, user.userId);
  }

  @Get('items/:id')
  @Roles(Role.ADMIN, Role.MANAGER)
  findOneItem(@CurrentUser() user: any, @Param('id') id: string) {
    return this.inventoryService.findOneItem(user.tenantId, id);
  }

  @Put('items/:id')
  @Roles(Role.ADMIN, Role.MANAGER)
  updateItem(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: Partial<CreateItemDto>) {
    return this.inventoryService.updateItem(user.tenantId, id, dto);
  }

  @Delete('items/:id')
  @Roles(Role.ADMIN, Role.MANAGER)
  deleteItem(@CurrentUser() user: any, @Param('id') id: string) {
    return this.inventoryService.deleteItem(user.tenantId, id);
  }

  @Post('imports')
  @Roles(Role.ADMIN, Role.MANAGER)
  importStock(@CurrentUser() user: any, @Body() dto: CreateImportDto) {
    return this.inventoryService.importStock(user.tenantId, user.userId, dto);
  }

  @Get('imports/history')
  @Roles(Role.ADMIN, Role.MANAGER)
  getHistory(@CurrentUser() user: any) {
    return this.inventoryService.getImportHistory(user.tenantId);
  }
}
