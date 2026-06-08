import { Injectable } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';

@Injectable()
export class NotificationsService {
  constructor(private readonly chatGateway: ChatGateway) {}

  async sendToUser(tenantId: string, userId: string, title: string, body: string, data?: any) {
    this.chatGateway.sendDirectMessage(userId, {
      type: 'notification',
      title,
      body,
      data,
      timestamp: new Date(),
    });
  }

  async sendToTenant(tenantId: string, title: string, body: string, data?: any) {
    this.chatGateway.sendOrderEvent(tenantId, 'notification', {
      title,
      body,
      data,
      timestamp: new Date(),
    });
  }
}
