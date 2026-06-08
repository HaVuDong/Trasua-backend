import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Track online users mapping userId -> socketId
  private activeUsers = new Map<string, string>();

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    for (const [userId, socketId] of this.activeUsers.entries()) {
      if (socketId === client.id) {
        this.activeUsers.delete(userId);
        break;
      }
    }
  }

  @SubscribeMessage('register')
  handleRegister(@MessageBody() data: { userId: string; tenantId: string }, @ConnectedSocket() client: Socket) {
    this.activeUsers.set(data.userId, client.id);
    // Join tenant room for general announcements (like new QR orders)
    client.join(`tenant_${data.tenantId}`);
    return { status: 'success', message: `Registered to tenant_${data.tenantId}` };
  }

  @SubscribeMessage('joinChatRoom')
  handleJoinChatRoom(@MessageBody() data: { roomId: string }, @ConnectedSocket() client: Socket) {
    client.join(`chat_${data.roomId}`);
    return { status: 'success', message: `Joined chat_${data.roomId}` };
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

  // General method to send group message
  sendGroupMessage(groupId: string, payload: any) {
    this.server.to(`chat_${groupId}`).emit('newMessage', payload);
  }
}
