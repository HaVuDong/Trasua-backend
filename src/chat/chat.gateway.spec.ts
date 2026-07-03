import { Types } from 'mongoose';
import { ChatGateway } from './chat.gateway';

function createQueryResult(result: unknown) {
  return {
    exec: jest.fn().mockResolvedValue(result),
  };
}

function createSelectLeanQuery(result: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  };
}

function createClient(token = 'token') {
  return {
    id: 'socket_1',
    handshake: {
      auth: { token },
      headers: {},
    },
    data: {},
    join: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    emit: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  } as any;
}

describe('ChatGateway', () => {
  const tenantId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const roomId = new Types.ObjectId().toString();

  let jwtService: { verify: jest.Mock };
  let roomModel: { findOne: jest.Mock };
  let messageModel: any;
  let userModel: { findById: jest.Mock };
  let gateway: ChatGateway;

  beforeEach(() => {
    jest.useRealTimers();
    jwtService = {
      verify: jest.fn().mockReturnValue({
        sub: userId,
        tenantId,
        role: 'USER',
        authVersion: 1,
      }),
    };
    roomModel = {
      findOne: jest.fn().mockReturnValue(createQueryResult(null)),
    };
    messageModel = jest.fn();
    userModel = {
      findById: jest.fn().mockReturnValue(
        createSelectLeanQuery({
          _id: new Types.ObjectId(userId),
          tenantId: new Types.ObjectId(tenantId),
          role: 'USER',
          status: 'ACTIVE',
          authVersion: 1,
        }),
      ),
    };
    gateway = new ChatGateway(
      jwtService as any,
      roomModel as any,
      messageModel,
      userModel as any,
    );
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      sockets: { sockets: new Map() },
      in: jest
        .fn()
        .mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([]) }),
    } as any;
  });

  it('rejects expired JWT sockets', async () => {
    jwtService.verify.mockImplementation(() => {
      throw new Error('jwt expired');
    });
    const client = createClient();

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.data.user).toBeUndefined();
  });

  it('rejects stale authVersion sockets', async () => {
    jwtService.verify.mockReturnValueOnce({
      sub: userId,
      tenantId,
      role: 'USER',
      authVersion: 1,
    });
    userModel.findById.mockReturnValueOnce(
      createSelectLeanQuery({
        _id: new Types.ObjectId(userId),
        tenantId: new Types.ObjectId(tenantId),
        role: 'USER',
        status: 'ACTIVE',
        authVersion: 2,
      }),
    );
    const client = createClient();

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.data.user).toBeUndefined();
  });

  it('allows a room member to join a chat room', async () => {
    const client = createClient();
    await gateway.handleConnection(client);
    roomModel.findOne.mockReturnValueOnce(
      createQueryResult({
        _id: new Types.ObjectId(roomId),
        tenantId: new Types.ObjectId(tenantId),
        members: [new Types.ObjectId(userId)],
      }),
    );

    const result = await gateway.handleJoinChatRoom({ roomId }, client);

    expect(result).toEqual({
      status: 'success',
      message: `Joined chat_${roomId}`,
    });
    expect(client.join).toHaveBeenCalledWith(`chat_${roomId}`);
    expect(roomModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: expect.any(Types.ObjectId),
        tenantId: expect.any(Types.ObjectId),
        members: expect.any(Types.ObjectId),
        archivedAt: { $exists: false },
        deletedAt: { $exists: false },
      }),
    );
  });

  it('blocks non-members from joining a room', async () => {
    const client = createClient();
    await gateway.handleConnection(client);
    roomModel.findOne.mockReturnValueOnce(createQueryResult(null));

    const result = await gateway.handleJoinChatRoom({ roomId }, client);

    expect(result).toEqual({
      status: 'error',
      message: 'Chat room access denied',
    });
    expect(client.join).not.toHaveBeenCalledWith(`chat_${roomId}`);
  });

  it('blocks sockets from joining another tenant room', async () => {
    const otherTenantRoomId = new Types.ObjectId().toString();
    const client = createClient();
    await gateway.handleConnection(client);
    roomModel.findOne.mockReturnValueOnce(createQueryResult(null));

    const result = await gateway.handleJoinChatRoom(
      { roomId: otherTenantRoomId },
      client,
    );

    expect(result).toEqual({
      status: 'error',
      message: 'Chat room access denied',
    });
  });

  it('kicks removed users from the chat room', async () => {
    const targetSocket = {
      data: { user: { userId, tenantId } },
      emit: jest.fn(),
      leave: jest.fn().mockResolvedValue(undefined),
    };
    const otherSocket = {
      data: { user: { userId: new Types.ObjectId().toString(), tenantId } },
      emit: jest.fn(),
      leave: jest.fn(),
    };
    const fetchSockets = jest
      .fn()
      .mockResolvedValue([targetSocket, otherSocket]);
    gateway.server = {
      in: jest.fn().mockReturnValue({ fetchSockets }),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      sockets: { sockets: new Map() },
    } as any;

    await gateway.revokeChatRoomAccess(roomId, userId);

    expect(gateway.server.in).toHaveBeenCalledWith(`chat_${roomId}`);
    expect(targetSocket.emit).toHaveBeenCalledWith('chatRoomAccessRevoked', {
      roomId,
    });
    expect(targetSocket.leave).toHaveBeenCalledWith(`chat_${roomId}`);
    expect(otherSocket.emit).not.toHaveBeenCalled();
    expect(otherSocket.leave).not.toHaveBeenCalled();
  });

  it('sends direct user events to the active user socket', async () => {
    const client = createClient();
    await gateway.handleConnection(client);
    const emit = jest.fn();
    (gateway.server.to as jest.Mock).mockReturnValueOnce({ emit });

    gateway.sendUserEvent(userId, 'permissionsUpdated', {
      permissionVersion: 2,
    });

    expect(gateway.server.to).toHaveBeenCalledWith(client.id);
    expect(emit).toHaveBeenCalledWith('permissionsUpdated', {
      permissionVersion: 2,
    });
  });

  it('emits sessionRevoked and disconnects all active user sockets', async () => {
    const client = createClient();
    await gateway.handleConnection(client);
    const emit = jest.fn();
    const socket = { disconnect: jest.fn() };
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit }),
      sockets: { sockets: new Map([[client.id, socket]]) },
      in: jest
        .fn()
        .mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([]) }),
    } as any;

    gateway.revokeUserSession(userId, 'LOCKED');

    expect(gateway.server.to).toHaveBeenCalledWith(client.id);
    expect(emit).toHaveBeenCalledWith('sessionRevoked', { reason: 'LOCKED' });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
