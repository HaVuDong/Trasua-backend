import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ChatRoom, ChatRoomDocument } from './schemas/chat-room.schema';
import { Message, MessageDocument } from './schemas/message.schema';
import { ChatGateway } from './chat.gateway';
import { CreateGroupDto, SendMessageDto } from './dto/create-chat.dto';

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(ChatRoom.name) private roomModel: Model<ChatRoomDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    private chatGateway: ChatGateway,
  ) {}

  async getOrCreateDM(tenantId: string, user1: string, user2: string): Promise<ChatRoom> {
    const existing = await this.roomModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      isGroup: false,
      members: { $all: [new Types.ObjectId(user1), new Types.ObjectId(user2)] },
    }).exec();

    if (existing) return existing;

    const newRoom = new this.roomModel({
      tenantId: new Types.ObjectId(tenantId),
      members: [new Types.ObjectId(user1), new Types.ObjectId(user2)],
      isGroup: false,
    });
    return newRoom.save();
  }

  async createGroup(tenantId: string, creatorId: string, dto: CreateGroupDto): Promise<ChatRoom> {
    const members = dto.memberIds.map(id => new Types.ObjectId(id));
    if (!members.some(id => id.toString() === creatorId)) {
      members.push(new Types.ObjectId(creatorId));
    }

    const newRoom = new this.roomModel({
      tenantId: new Types.ObjectId(tenantId),
      name: dto.name,
      members,
      isGroup: true,
      createdBy: new Types.ObjectId(creatorId),
    });
    return newRoom.save();
  }

  async addMember(tenantId: string, roomId: string, userId: string, requesterId: string): Promise<ChatRoom> {
    const room = await this.roomModel.findOne({ _id: roomId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!room) throw new NotFoundException('Chat room not found');
    if (!room.isGroup) throw new BadRequestException('Cannot add members to a DM');

    // Check requester is a member
    const isRequesterMember = room.members.some(m => m.toString() === requesterId);
    if (!isRequesterMember) throw new ForbiddenException('You are not a member of this group');

    // Check if user already a member
    const alreadyMember = room.members.some(m => m.toString() === userId);
    if (alreadyMember) throw new BadRequestException('User is already a member');

    room.members.push(new Types.ObjectId(userId));
    return room.save();
  }

  async removeMember(tenantId: string, roomId: string, userId: string, requesterId: string): Promise<ChatRoom> {
    const room = await this.roomModel.findOne({ _id: roomId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!room) throw new NotFoundException('Chat room not found');
    if (!room.isGroup) throw new BadRequestException('Cannot remove members from a DM');

    // Only group creator or Admin can remove members
    const isCreator = room.createdBy?.toString() === requesterId;
    if (!isCreator) throw new ForbiddenException('Only the group creator can remove members');

    room.members = room.members.filter(m => m.toString() !== userId);
    return room.save();
  }

  async renameGroup(tenantId: string, roomId: string, newName: string, requesterId: string): Promise<ChatRoom> {
    const room = await this.roomModel.findOne({ _id: roomId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!room) throw new NotFoundException('Chat room not found');
    if (!room.isGroup) throw new BadRequestException('Cannot rename a DM');

    const isMember = room.members.some(m => m.toString() === requesterId);
    if (!isMember) throw new ForbiddenException('You are not a member of this group');

    room.name = newName;
    return room.save();
  }

  async sendMessage(tenantId: string, senderId: string, roomId: string, dto: SendMessageDto): Promise<Message> {
    const room = await this.roomModel.findOne({ _id: roomId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!room) throw new NotFoundException('Chat room not found');

    const isMember = room.members.some(member => member.toString() === senderId);
    if (!isMember) throw new ForbiddenException('You are not a member of this room');

    const msg = new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      roomId: new Types.ObjectId(roomId),
      senderId: new Types.ObjectId(senderId),
      text: dto.text,
      fileUrl: dto.fileUrl,
      fileName: dto.fileName,
      isImportant: dto.isImportant || false,
      readBy: [new Types.ObjectId(senderId)], // Sender has read their own message
    });

    const savedMsg = await msg.save();
    
    // Broadcast via Socket.IO
    if (room.isGroup) {
      this.chatGateway.sendGroupMessage(roomId, savedMsg);
    } else {
      const recipient = room.members.find(m => m.toString() !== senderId);
      if (recipient) {
        this.chatGateway.sendDirectMessage(recipient.toString(), savedMsg);
      }
    }

    return savedMsg;
  }

  async markAsRead(tenantId: string, userId: string, messageId: string): Promise<Message> {
    const msg = await this.messageModel.findOne({ _id: messageId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!msg) throw new NotFoundException('Message not found');

    if (!msg.readBy.some(id => id.toString() === userId)) {
      msg.readBy.push(new Types.ObjectId(userId));
      await msg.save();
    }

    return msg;
  }

  async markRoomAsRead(tenantId: string, userId: string, roomId: string): Promise<{ count: number }> {
    const result = await this.messageModel.updateMany(
      {
        tenantId: new Types.ObjectId(tenantId),
        roomId: new Types.ObjectId(roomId),
        readBy: { $ne: new Types.ObjectId(userId) },
      },
      {
        $addToSet: { readBy: new Types.ObjectId(userId) },
      },
    ).exec();

    return { count: result.modifiedCount };
  }

  async getRooms(tenantId: string, userId: string): Promise<ChatRoom[]> {
    return this.roomModel.find({
      tenantId: new Types.ObjectId(tenantId),
      members: new Types.ObjectId(userId),
    })
    .populate('members', 'name email role avatarUrl')
    .exec();
  }

  async getMessages(tenantId: string, userId: string, roomId: string): Promise<Message[]> {
    const room = await this.roomModel.findOne({ _id: roomId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!room) throw new NotFoundException('Chat room not found');

    const isMember = room.members.some(member => member.toString() === userId);
    if (!isMember) throw new ForbiddenException('Access denied');

    return this.messageModel.find({ roomId: new Types.ObjectId(roomId) })
      .populate('senderId', 'name role')
      .sort({ createdAt: 1 })
      .exec();
  }

  async searchMessages(tenantId: string, userId: string, keyword: string, roomId?: string): Promise<Message[]> {
    const query: any = {
      tenantId: new Types.ObjectId(tenantId),
      text: { $regex: keyword, $options: 'i' },
    };

    if (roomId) {
      query.roomId = new Types.ObjectId(roomId);
    }

    // Only search in rooms the user is a member of
    const userRooms = await this.roomModel.find({
      tenantId: new Types.ObjectId(tenantId),
      members: new Types.ObjectId(userId),
    }).select('_id').exec();

    if (!roomId) {
      query.roomId = { $in: userRooms.map(r => (r as any)._id) };
    }

    return this.messageModel.find(query)
      .populate('senderId', 'name role')
      .populate('roomId', 'name isGroup')
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();
  }

  async toggleImportant(tenantId: string, messageId: string): Promise<Message> {
    const msg = await this.messageModel.findOne({ _id: messageId, tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!msg) throw new NotFoundException('Message not found');

    msg.isImportant = !msg.isImportant;
    return msg.save();
  }

  async getUnreadCount(tenantId: string, userId: string): Promise<any[]> {
    const rooms = await this.roomModel.find({
      tenantId: new Types.ObjectId(tenantId),
      members: new Types.ObjectId(userId),
    }).select('_id name isGroup').exec();

    const result = [];
    for (const room of rooms) {
      const unreadCount = await this.messageModel.countDocuments({
        roomId: (room as any)._id,
        readBy: { $ne: new Types.ObjectId(userId) },
      }).exec();

      result.push({
        roomId: (room as any)._id,
        name: room.name,
        isGroup: room.isGroup,
        unreadCount,
      });
    }

    return result.filter(r => r.unreadCount > 0);
  }
}
