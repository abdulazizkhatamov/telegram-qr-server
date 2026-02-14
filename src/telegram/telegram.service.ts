import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
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
      60 * 1000, // 60 seconds TTL - only for QR login process
    );

    // Start listening for UpdateLoginToken
    this.setupLoginTokenListener(loginId, client);
    this.logger.log(`QR login initiated for loginId: ${loginId}`);

    return {
      loginId,
      url: `tg://login?token=${token}`,
      expires: result.expires,
    };
  }

  /**
   * Setup event listener for UpdateLoginToken
   * This fires when user scans the QR code
   */
  private setupLoginTokenListener(loginId: string, client: TelegramClient) {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    client.addEventHandler(async (update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateLoginToken) {
        this.logger.log(`UpdateLoginToken received for loginId: ${loginId}`);
        await this.handleUpdateLoginToken(loginId, client);
      }
    });
  }

  /**
   * Handle UpdateLoginToken event - called after QR code is scanned
   * Need to call exportLoginToken again to get the actual authorization
   */
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

      // Update status to scanned
      loginData.status = 'scanned';
      await this.cache.set(`tg:login:${loginId}`, loginData, 60 * 1000);

      const apiId = Number(this.configService.getOrThrow<string>('TG_API_ID'));
      const apiHash = this.configService.getOrThrow<string>('TG_API_HASH');

      // Call exportLoginToken again after UpdateLoginToken
      const result = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId,
          apiHash,
          exceptIds: [],
        }),
      );

      if (result instanceof Api.auth.LoginTokenSuccess) {
        // Success! We got the authorization
        await this.handleLoginSuccess(loginId, client, result);
      } else if (result instanceof Api.auth.LoginTokenMigrateTo) {
        // DC mismatch - need to migrate
        await this.handleLoginMigration(loginId, client, result);
      } else {
        this.logger.warn(
          `Unexpected result type after UpdateLoginToken: ${result.className}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error handling UpdateLoginToken for ${loginId}:`,
        error,
      );
      await this.cleanupLogin(loginId);
    }
  }

  /**
   * Handle successful login
   */
  private async handleLoginSuccess(
    loginId: string,
    client: TelegramClient,
    result: Api.auth.LoginTokenSuccess,
  ) {
    try {
      if (!(result.authorization instanceof Api.auth.Authorization)) {
        throw new Error('Invalid authorization object');
      }

      // Get the session string to save
      const sessionString = client.session.save() as unknown as string;

      // Get user info
      const me = await client.getMe();
      const userId = me.id.toString();

      // Update TEMPORARY login data with session (for the completion flow)
      const loginData = await this.cache.get<LoginData>(`tg:login:${loginId}`);
      if (loginData) {
        loginData.status = 'success';
        loginData.session = sessionString;
        loginData.userId = userId;
        await this.cache.set(`tg:login:${loginId}`, loginData, 300 * 1000); // 5 minutes to retrieve
      }

      // Store PERSISTENT user session in Redis WITHOUT expiration
      // This is the actual user session that persists
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

      // Store with NO TTL (0 means no expiration in cache-manager)
      await this.cache.set(`tg:user:${userId}`, userSession, 0);

      this.logger.log(
        `Login successful for loginId: ${loginId}, userId: ${userId}. Session stored permanently.`,
      );
    } catch (error) {
      this.logger.error(`Error in handleLoginSuccess for ${loginId}:`, error);
      await this.cleanupLogin(loginId);
    }
  }

  /**
   * Handle DC migration
   */
  private async handleLoginMigration(
    loginId: string,
    client: TelegramClient,
    result: Api.auth.LoginTokenMigrateTo,
  ) {
    try {
      this.logger.log(`Migrating to DC ${result.dcId} for loginId: ${loginId}`);

      // Switch to the correct DC
      await client._switchDC(result.dcId);

      // Import the login token on the new DC
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
    } catch (error) {
      this.logger.error(`Error in handleLoginMigration for ${loginId}:`, error);
      await this.cleanupLogin(loginId);
    }
  }

  /**
   * Cleanup login resources (temporary data only)
   */
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

    // Only delete temporary login data, NOT the user session
    await this.cache.del(`tg:login:${loginId}`);
  }
}
