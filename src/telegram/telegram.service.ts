import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

@Injectable()
export class TelegramService {
  private clients = new Map<string, TelegramClient>();

  constructor(
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  async exportLoginToken(socketId: string) {
    const apiId = Number(this.configService.getOrThrow<string>('TG_API_ID'));
    const apiHash = this.configService.getOrThrow<string>('TG_API_HASH');

    const loginId = randomUUID();
    const session = new StringSession('');

    const client = new TelegramClient(session, apiId, apiHash, {});

    await client.connect();

    const result = await client.invoke(
      new Api.auth.ExportLoginToken({
        apiId,
        apiHash,
        exceptIds: [],
      }),
    );

    if (!(result instanceof Api.auth.LoginToken)) {
      throw new Error('Unexpected response');
    }

    const token = Buffer.from(result.token).toString('base64url');

    this.clients.set(loginId, client);

    await this.cache.set(
      `tg:login:${loginId}`,
      {
        socketId,
        status: 'pending',
      },
      60,
    );

    return {
      loginId,
      url: `tg://login?token=${token}`,
      expires: result.expires,
    };
  }
}
