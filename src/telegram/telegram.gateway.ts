import {
  ConnectedSocket,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TelegramService } from './telegram.service';
import { Inject } from '@nestjs/common';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { LoginData } from './telegram.types';

@WebSocketGateway({ cors: true })
export class TelegramGateway implements OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  // One interval per socket connection
  private statusIntervals = new Map<string, NodeJS.Timeout>();

  constructor(
    private telegramService: TelegramService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  /**
   * Client asks to start a new QR login session.
   * Responds with `telegram.qr` containing the deep-link URL and loginId.
   * Also kicks off a 1-second server-side poller that pushes status updates.
   */
  @SubscribeMessage('telegram.qr.create')
  async exportLoginToken(@ConnectedSocket() socket: Socket) {
    // Clean up any pre-existing interval for this socket (e.g. QR refresh)
    this.clearSocketInterval(socket.id);

    const data = await this.telegramService.exportLoginToken(socket.id);
    socket.emit('telegram.qr', data);
    this.startStatusWatcher(socket, data.loginId);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private startStatusWatcher(socket: Socket, loginId: string) {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const interval = setInterval(async () => {
      const loginData = await this.cache.get<LoginData>(`tg:login:${loginId}`);

      // Cache entry gone → QR expired
      if (!loginData) {
        socket.emit('telegram.qr.status', { status: 'expired' });
        this.clearSocketInterval(socket.id);
        return;
      }

      socket.emit('telegram.qr.status', {
        status: loginData.status,
        userId: loginData.userId ?? null,
        twoFaError:
          loginData.status === 'awaiting_2fa'
            ? (loginData.twoFaError ?? null)
            : null,
      });

      // Terminal states — stop polling
      if (loginData.status === 'success' || loginData.status === 'expired') {
        this.clearSocketInterval(socket.id);
      }
    }, 1000);

    this.statusIntervals.set(socket.id, interval);
  }

  private clearSocketInterval(socketId: string) {
    const existing = this.statusIntervals.get(socketId);
    if (existing) {
      clearInterval(existing);
      this.statusIntervals.delete(socketId);
    }
  }

  handleDisconnect(socket: Socket) {
    this.clearSocketInterval(socket.id);
  }
}
