import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TelegramService } from './telegram.service';

@WebSocketGateway({ cors: true })
export class TelegramGateway {
  @WebSocketServer() server: Server;
  constructor(private telegramService: TelegramService) {}

  @SubscribeMessage('telegram.qr.create')
  async exportLoginToken(@ConnectedSocket() socket: Socket) {
    const data = await this.telegramService.exportLoginToken(socket.id);

    socket.emit('telegram.qr', data);
  }
}
