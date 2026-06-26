import { BadRequestException, Logger } from '@nestjs/common';
import { ClientSession, Connection } from 'mongoose';

function readErrorString(error: Record<string, unknown>, key: string): string {
  const value = error[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

export function isMongoTransactionUnsupportedError(error: unknown): boolean {
  const details =
    typeof error === 'object' && error !== null
      ? {
          message: readErrorString(error as Record<string, unknown>, 'message'),
          codeName: readErrorString(
            error as Record<string, unknown>,
            'codeName',
          ),
          code:
            typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : undefined,
        }
      : { message: '', codeName: '', code: undefined as number | undefined };

  const message = details.message.toLowerCase();
  return (
    details.code === 20 ||
    details.codeName.toLowerCase() === 'illegaloperation' ||
    message.includes(
      'transaction numbers are only allowed on a replica set member or mongos',
    ) ||
    (message.includes('replica set') && message.includes('transaction'))
  );
}

export async function runTransactionSensitive<T>(
  connection: Connection,
  operation: (session: ClientSession) => Promise<T>,
  context: string,
  logger?: Logger,
): Promise<T> {
  const session = await connection.startSession();
  let result: T | undefined;

  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    });
  } catch (error) {
    if (isMongoTransactionUnsupportedError(error)) {
      logger?.warn(
        `${context}: MongoDB transaction unsupported. Use MongoDB replica set or Atlas.`,
      );
      throw new BadRequestException({
        code: 'MONGO_TRANSACTION_UNSUPPORTED',
        message:
          'MongoDB transaction is not supported. Configure MongoDB replica set or Atlas.',
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return result as T;
}
