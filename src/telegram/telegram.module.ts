import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { TelegramGateway } from './telegram.gateway';
import { Module } from '@nestjs/common';

@Module({
  providers: [TelegramService, TelegramGateway],
  controllers: [TelegramController],
})
export class TelegramModule {}
