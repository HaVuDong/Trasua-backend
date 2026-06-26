import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { CreateGroupDto, SendMessageDto } from './dto/create-chat.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('chat')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // DM
  @Post('dm/:recipientId')
  getOrCreateDM(
    @CurrentUser() user: any,
    @Param('recipientId') recipientId: string,
  ) {
    return this.chatService.getOrCreateDM(
      user.tenantId,
      user.userId,
      recipientId,
    );
  }

  // Group management
  @Post('group')
  createGroup(@CurrentUser() user: any, @Body() dto: CreateGroupDto) {
    return this.chatService.createGroup(user.tenantId, user.userId, dto);
  }

  @Post('group/:roomId/members')
  addMember(
    @CurrentUser() user: any,
    @Param('roomId') roomId: string,
    @Body('userId') userId: string,
  ) {
    return this.chatService.addMember(
      user.tenantId,
      roomId,
      userId,
      user.userId,
    );
  }

  @Patch('group/:roomId/members/:userId/remove')
  removeMember(
    @CurrentUser() user: any,
    @Param('roomId') roomId: string,
    @Param('userId') userId: string,
  ) {
    return this.chatService.removeMember(
      user.tenantId,
      roomId,
      userId,
      user.userId,
    );
  }

  @Patch('group/:roomId/rename')
  renameGroup(
    @CurrentUser() user: any,
    @Param('roomId') roomId: string,
    @Body('name') name: string,
  ) {
    return this.chatService.renameGroup(
      user.tenantId,
      roomId,
      name,
      user.userId,
    );
  }

  // Messages
  @Post('room/:roomId/message')
  sendMessage(
    @CurrentUser() user: any,
    @Param('roomId') roomId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(
      user.tenantId,
      user.userId,
      roomId,
      dto,
    );
  }

  @Get('rooms')
  getRooms(@CurrentUser() user: any) {
    return this.chatService.getRooms(user.tenantId, user.userId);
  }

  @Get('room/:roomId/messages')
  getMessages(@CurrentUser() user: any, @Param('roomId') roomId: string) {
    return this.chatService.getMessages(user.tenantId, user.userId, roomId);
  }

  // Read status
  @Post('message/:messageId/read')
  markAsRead(@CurrentUser() user: any, @Param('messageId') messageId: string) {
    return this.chatService.markAsRead(user.tenantId, user.userId, messageId);
  }

  @Post('room/:roomId/read')
  markRoomAsRead(@CurrentUser() user: any, @Param('roomId') roomId: string) {
    return this.chatService.markRoomAsRead(user.tenantId, user.userId, roomId);
  }

  @Get('unread')
  getUnreadCount(@CurrentUser() user: any) {
    return this.chatService.getUnreadCount(user.tenantId, user.userId);
  }

  // Search
  @Get('search')
  searchMessages(
    @CurrentUser() user: any,
    @Query('keyword') keyword: string,
    @Query('roomId') roomId?: string,
  ) {
    return this.chatService.searchMessages(
      user.tenantId,
      user.userId,
      keyword,
      roomId,
    );
  }

  // Pin/unpin important messages
  @Patch('message/:messageId/important')
  toggleImportant(
    @CurrentUser() user: any,
    @Param('messageId') messageId: string,
  ) {
    return this.chatService.toggleImportant(
      user.tenantId,
      user.userId,
      messageId,
    );
  }
}
