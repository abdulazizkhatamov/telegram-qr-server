import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Api, errors, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { LoginData, UserSession } from './telegram.types';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
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
      await client.disconnect();
      throw new Error('Unexpected response from exportLoginToken');
    }

    const token = Buffer.from(result.token).toString('base64url');

    this.clients.set(loginId, client);

    await this.cache.set(
      `tg:login:${loginId}`,
      {
        socketId,
        status: 'pending',
      } as LoginData,
      60 * 1000, // 60 seconds TTL
    );

    this.setupLoginTokenListener(loginId, client);
    this.logger.log(`QR login initiated for loginId: ${loginId}`);

    return {
      loginId,
      url: `tg://login?token=${token}`,
      expires: result.expires,
    };
  }

  /**
   * Submit 2FA password for a pending login
   */
  async submit2FAPassword(loginId: string, password: string): Promise<void> {
    const loginData = await this.cache.get<LoginData>(`tg:login:${loginId}`);
    if (!loginData || loginData.status !== 'awaiting_2fa') {
      throw new Error('No 2FA pending for this loginId');
    }

    const client = this.clients.get(loginId);
    if (!client) {
      throw new Error('Client not found for loginId');
    }

    try {
      // Get the current password SRP parameters
      const passwordInfo = await client.invoke(new Api.account.GetPassword());

      // Compute the SRP check using the provided password
      const srpCheck = await computeCheck(passwordInfo, password);

      // Submit the password
      const result = await client.invoke(
        new Api.auth.CheckPassword({ password: srpCheck }),
      );

      if (result instanceof Api.auth.Authorization) {
        // Success — treat like a successful login
        await this.finalizeLogin(loginId, client);
      } else {
        throw new Error('Unexpected result from CheckPassword');
      }
    } catch (error: unknown) {
      if (
        error instanceof errors.RPCError &&
        error.errorMessage === 'PASSWORD_HASH_INVALID'
      ) {
        loginData.status = 'awaiting_2fa';
        loginData.twoFaError = 'Incorrect password. Please try again.';
        await this.cache.set(`tg:login:${loginId}`, loginData, 300 * 1000);
      } else {
        this.logger.error(`2FA error for ${loginId}:`, error);
        await this.cleanupLogin(loginId);
        throw error;
      }
    }
  }

  private setupLoginTokenListener(loginId: string, client: TelegramClient) {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    client.addEventHandler(async (update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateLoginToken) {
        this.logger.log(`UpdateLoginToken received for loginId: ${loginId}`);
        await this.handleUpdateLoginToken(loginId, client);
      }
    });
  }

  private async handleUpdateLoginToken(
    loginId: string,
    client: TelegramClient,
  ) {
    try {
      const loginData = await this.cache.get<LoginData>(`tg:login:${loginId}`);
      if (!loginData) {
        this.logger.warn(`Login data not found for loginId: ${loginId}`);
        return;
      }

      loginData.status = 'scanned';
      await this.cache.set(`tg:login:${loginId}`, loginData, 60 * 1000);

      const apiId = Number(this.configService.getOrThrow<string>('TG_API_ID'));
      const apiHash = this.configService.getOrThrow<string>('TG_API_HASH');

      const result = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId,
          apiHash,
          exceptIds: [],
        }),
      );

      if (result instanceof Api.auth.LoginTokenSuccess) {
        await this.handleLoginSuccess(loginId, client, result);
      } else if (result instanceof Api.auth.LoginTokenMigrateTo) {
        await this.handleLoginMigration(loginId, client, result);
      } else {
        this.logger.warn(
          `Unexpected result type after UpdateLoginToken: ${result.className}`,
        );
      }
    } catch (error: unknown) {
      if (
        error instanceof errors.RPCError &&
        error.errorMessage === 'SESSION_PASSWORD_NEEDED'
      ) {
        await this.handle2FARequired(loginId);
      } else {
        this.logger.error(
          `Error handling UpdateLoginToken for ${loginId}:`,
          error,
        );
        await this.cleanupLogin(loginId);
      }
    }
  }

  /**
   * Mark login as requiring 2FA — client will prompt user for password
   */
  private async handle2FARequired(loginId: string) {
    const loginData = await this.cache.get<LoginData>(`tg:login:${loginId}`);
    if (!loginData) return;

    loginData.status = 'awaiting_2fa';
    await this.cache.set(`tg:login:${loginId}`, loginData, 300 * 1000); // 5 min to enter password
    this.logger.log(`2FA required for loginId: ${loginId}`);
  }

  /**
   * Finalize a successful login after 2FA (or directly)
   */
  private async finalizeLogin(loginId: string, client: TelegramClient) {
    const sessionString = client.session.save() as unknown as string;
    const me = await client.getMe();
    const userId = me.id.toString();

    const loginData = await this.cache.get<LoginData>(`tg:login:${loginId}`);
    if (loginData) {
      loginData.status = 'success';
      loginData.session = sessionString;
      loginData.userId = userId;
      delete loginData.twoFaError;
      await this.cache.set(`tg:login:${loginId}`, loginData, 300 * 1000);
    }

    const userSession: UserSession = {
      userId,
      sessionString,
      firstName: me.firstName || '',
      lastName: me.lastName,
      username: me.username,
      phone: me.phone,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    await this.cache.set(`tg:user:${userId}`, userSession, 0);

    this.logger.log(
      `Login successful for loginId: ${loginId}, userId: ${userId}. Session stored permanently.`,
    );
  }

  private async handleLoginSuccess(
    loginId: string,
    client: TelegramClient,
    result: Api.auth.LoginTokenSuccess,
  ) {
    try {
      if (!(result.authorization instanceof Api.auth.Authorization)) {
        throw new Error('Invalid authorization object');
      }
      await this.finalizeLogin(loginId, client);
    } catch (error) {
      this.logger.error(`Error in handleLoginSuccess for ${loginId}:`, error);
      await this.cleanupLogin(loginId);
    }
  }

  private async handleLoginMigration(
    loginId: string,
    client: TelegramClient,
    result: Api.auth.LoginTokenMigrateTo,
  ) {
    try {
      this.logger.log(`Migrating to DC ${result.dcId} for loginId: ${loginId}`);

      await client._switchDC(result.dcId);

      const importResult = await client.invoke(
        new Api.auth.ImportLoginToken({
          token: result.token,
        }),
      );

      if (importResult instanceof Api.auth.LoginTokenSuccess) {
        await this.handleLoginSuccess(loginId, client, importResult);
      } else {
        throw new Error('Unexpected result from importLoginToken');
      }
    } catch (error: unknown) {
      if (
        error instanceof errors.RPCError &&
        error.errorMessage === 'SESSION_PASSWORD_NEEDED'
      ) {
        await this.handle2FARequired(loginId);
      } else {
        this.logger.error(
          `Error in handleLoginMigration for ${loginId}:`,
          error,
        );
        await this.cleanupLogin(loginId);
      }
    }
  }

  private async cleanupLogin(loginId: string) {
    const client = this.clients.get(loginId);
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        this.logger.error(`Error disconnecting client for ${loginId}:`, error);
      }
      this.clients.delete(loginId);
    }
    await this.cache.del(`tg:login:${loginId}`);
  }
}
