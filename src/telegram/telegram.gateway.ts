import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TelegramService } from './telegram.service';
import { Inject } from '@nestjs/common';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { LoginData } from './telegram.types';

@WebSocketGateway({ cors: true })
export class TelegramGateway implements OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private statusIntervals = new Map<string, NodeJS.Timeout>();

  constructor(
    private telegramService: TelegramService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  @SubscribeMessage('telegram.qr.create')
  async exportLoginToken(@ConnectedSocket() socket: Socket) {
    const data = await this.telegramService.exportLoginToken(socket.id);

    socket.emit('telegram.qr', data);

    this.startStatusWatcher(socket, data.loginId);
  }

  private startStatusWatcher(socket: Socket, loginId: string) {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const interval = setInterval(async () => {
      const loginData: LoginData | undefined = await this.cache.get(
        `tg:login:${loginId}`,
      );

      if (!loginData) {
        clearInterval(interval);
        this.statusIntervals.delete(socket.id);
        return;
      }

      socket.emit('telegram.qr.status', {
        status: loginData.status,
        userId: loginData.userId,
      });

      if (loginData.status === 'success') {
        clearInterval(interval);
        this.statusIntervals.delete(socket.id);
      }
    }, 1000);

    this.statusIntervals.set(socket.id, interval);
  }

  handleDisconnect(socket: Socket) {
    const interval = this.statusIntervals.get(socket.id);
    if (interval) {
      clearInterval(interval);
      this.statusIntervals.delete(socket.id);
    }
  }
}
