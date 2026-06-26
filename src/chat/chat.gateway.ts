import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ChatRoom, ChatRoomDocument } from './schemas/chat-room.schema';
import { Message, MessageDocument } from './schemas/message.schema';
import { SendMessageDto } from './dto/create-chat.dto';

type SocketUser = {
  userId: string;
  tenantId?: string;
  role?: string;
  exp?: number;
};

type RoomEventPayload = {
  roomId?: string;
};

type SocketSendMessagePayload = SendMessageDto & RoomEventPayload;

type ReadMessagePayload = RoomEventPayload & {
  messageId?: string;
};

type TypingPayload = RoomEventPayload & {
  isTyping?: boolean;
};

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server: Server;

  // Track online users mapping userId -> socketId
  private activeUsers = new Map<string, string>();

  constructor(
    private readonly jwtService: JwtService,
    @InjectModel(ChatRoom.name) private roomModel: Model<ChatRoomDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
  ) {}

  private getClientToken(client: Socket): string {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken.trim();
    }

    const header = client.handshake.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim();
    }

    return '';
  }

  private authenticateClient(client: Socket): SocketUser | null {
    const token = this.getClientToken(client);
    if (!token) return null;

    try {
      const payload = this.jwtService.verify(token) as {
        sub?: string;
        tenantId?: string;
        role?: string;
        exp?: number;
      };
      if (!payload?.sub) return null;
      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
        exp: typeof payload.exp === 'number' ? payload.exp : undefined,
      };
    } catch {
      return null;
    }
  }

  private scheduleTokenExpiryDisconnect(
    client: Socket,
    socketUser: SocketUser,
  ) {
    if (!socketUser.exp) return;

    const expiresInMs = socketUser.exp * 1000 - Date.now();
    if (expiresInMs <= 0) {
      client.disconnect(true);
      return;
    }

    const timer = setTimeout(() => {
      this.logger.debug(`Disconnecting expired socket token: ${client.id}`);
      client.disconnect(true);
    }, expiresInMs);
    client.data.expiryTimer = timer;
  }

  private getSocketUser(client: Socket): SocketUser | null {
    const socketUser = client.data.user as SocketUser | undefined;
    if (!socketUser?.userId || !socketUser.tenantId) return null;
    return socketUser;
  }

  private getChatRoomName(roomId: string) {
    return `chat_${roomId}`;
  }

  private async findAccessibleRoom(client: Socket, roomId?: string) {
    const socketUser = this.getSocketUser(client);
    if (!socketUser) {
      return {
        error: { status: 'error', message: 'Unauthenticated socket' },
      };
    }

    const tenantId = socketUser.tenantId;
    if (
      !roomId ||
      typeof tenantId !== 'string' ||
      !Types.ObjectId.isValid(roomId) ||
      !Types.ObjectId.isValid(tenantId)
    ) {
      return {
        error: { status: 'error', message: 'Invalid chat room scope' },
      };
    }

    const room = await this.roomModel
      .findOne({
        _id: new Types.ObjectId(roomId),
        tenantId: new Types.ObjectId(tenantId),
        members: new Types.ObjectId(socketUser.userId),
        archivedAt: { $exists: false },
        deletedAt: { $exists: false },
      })
      .exec();

    if (!room) {
      return {
        error: { status: 'error', message: 'Chat room access denied' },
      };
    }

    return { room, socketUser };
  }

  handleConnection(client: Socket) {
    const socketUser = this.authenticateClient(client);
    if (!socketUser) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect(true);
      return;
    }

    client.data.user = socketUser;
    this.scheduleTokenExpiryDisconnect(client, socketUser);
    this.activeUsers.set(socketUser.userId, client.id);
    if (socketUser.tenantId) {
      client.join(`tenant_${socketUser.tenantId}`);
    }

    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
    const expiryTimer = client.data.expiryTimer as
      | ReturnType<typeof setTimeout>
      | undefined;
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }

    const socketUser = client.data.user as SocketUser | undefined;
    if (
      socketUser?.userId &&
      this.activeUsers.get(socketUser.userId) === client.id
    ) {
      this.activeUsers.delete(socketUser.userId);
      return;
    }

    for (const [userId, socketId] of this.activeUsers.entries()) {
      if (socketId === client.id) this.activeUsers.delete(userId);
    }
  }

  @SubscribeMessage('register')
  handleRegister(
    @MessageBody() data: { userId: string; tenantId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = client.data.user as SocketUser | undefined;
    if (!socketUser?.userId) {
      client.disconnect(true);
      return { status: 'error', message: 'Unauthenticated socket' };
    }

    if (
      data.userId !== socketUser.userId ||
      data.tenantId !== socketUser.tenantId
    ) {
      return { status: 'error', message: 'Invalid socket registration scope' };
    }

    this.activeUsers.set(socketUser.userId, client.id);
    if (socketUser.tenantId) {
      client.join(`tenant_${socketUser.tenantId}`);
    }
    return {
      status: 'success',
      message: `Registered to tenant_${socketUser.tenantId}`,
    };
  }

  @SubscribeMessage('joinChatRoom')
  async handleJoinChatRoom(
    @MessageBody() data: RoomEventPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const access = await this.findAccessibleRoom(client, data.roomId);
    if (access.error) return access.error;

    const roomName = this.getChatRoomName(data.roomId as string);
    await client.join(roomName);
    return { status: 'success', message: `Joined ${roomName}` };
  }

  @SubscribeMessage('sendMessage')
  async handleSocketSendMessage(
    @MessageBody() data: SocketSendMessagePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const access = await this.findAccessibleRoom(client, data.roomId);
    if (access.error) return access.error;

    if (!data.text && !data.fileUrl) {
      return { status: 'error', message: 'Message text or file is required' };
    }

    const roomId = data.roomId as string;
    const socketUser = access.socketUser as SocketUser;
    const tenantId = socketUser.tenantId as string;
    const room = access.room as ChatRoomDocument;
    const savedMsg = await new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      roomId: new Types.ObjectId(roomId),
      senderId: new Types.ObjectId(socketUser.userId),
      text: data.text,
      fileUrl: data.fileUrl,
      fileName: data.fileName,
      isImportant: data.isImportant || false,
      readBy: [new Types.ObjectId(socketUser.userId)],
    }).save();

    if (room.isGroup) {
      this.server.to(this.getChatRoomName(roomId)).emit('newMessage', savedMsg);
    } else {
      const recipient = room.members.find(
        (member) => member.toString() !== socketUser.userId,
      );
      if (recipient) this.sendDirectMessage(recipient.toString(), savedMsg);
      client.emit('newMessage', savedMsg);
    }

    return { status: 'success', message: savedMsg };
  }

  @SubscribeMessage('readMessage')
  async handleReadMessage(
    @MessageBody() data: ReadMessagePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const access = await this.findAccessibleRoom(client, data.roomId);
    if (access.error) return access.error;

    if (!data.messageId || !Types.ObjectId.isValid(data.messageId)) {
      return { status: 'error', message: 'Invalid message' };
    }

    const socketUser = access.socketUser as SocketUser;
    const tenantId = socketUser.tenantId as string;
    const message = await this.messageModel
      .findOne({
        _id: new Types.ObjectId(data.messageId),
        tenantId: new Types.ObjectId(tenantId),
        roomId: new Types.ObjectId(data.roomId as string),
      })
      .exec();

    if (!message) return { status: 'error', message: 'Message not found' };

    if (!message.readBy.some((id) => id.toString() === socketUser.userId)) {
      message.readBy.push(new Types.ObjectId(socketUser.userId));
      await message.save();
    }

    this.server
      .to(this.getChatRoomName(data.roomId as string))
      .emit('messageRead', {
        roomId: data.roomId,
        messageId: data.messageId,
        userId: socketUser.userId,
      });

    return { status: 'success' };
  }

  @SubscribeMessage('typing')
  async handleTyping(
    @MessageBody() data: TypingPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const access = await this.findAccessibleRoom(client, data.roomId);
    if (access.error) return access.error;

    const socketUser = access.socketUser as SocketUser;
    client.to(this.getChatRoomName(data.roomId as string)).emit('typing', {
      roomId: data.roomId,
      userId: socketUser.userId,
      isTyping: data.isTyping !== false,
    });

    return { status: 'success' };
  }

  // General method to broadcast order events to tenant
  sendOrderEvent(tenantId: string, event: string, payload: any) {
    this.server.to(`tenant_${tenantId}`).emit(event, payload);
  }

  // General method to send direct messages
  sendDirectMessage(targetUserId: string, payload: any) {
    const socketId = this.activeUsers.get(targetUserId);
    if (socketId) {
      this.server.to(socketId).emit('newMessage', payload);
    }
  }

  sendUserEvent(targetUserId: string, event: string, payload: any) {
    const socketId = this.activeUsers.get(targetUserId);
    if (socketId) {
      this.server.to(socketId).emit(event, payload);
    }
  }

  // General method to send group message
  sendGroupMessage(groupId: string, payload: any) {
    this.server.to(this.getChatRoomName(groupId)).emit('newMessage', payload);
  }

  async revokeChatRoomAccess(roomId: string, userId: string) {
    const roomName = this.getChatRoomName(roomId);
    const sockets = await this.server.in(roomName).fetchSockets();

    for (const socket of sockets) {
      const socketUser = socket.data.user as SocketUser | undefined;
      if (socketUser?.userId === userId) {
        socket.emit('chatRoomAccessRevoked', { roomId });
        await socket.leave(roomName);
      }
    }
  }
}
