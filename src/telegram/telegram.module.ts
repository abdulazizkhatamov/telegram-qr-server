import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { TelegramGateway } from './telegram.gateway';

@Module({
  providers: [TelegramService, TelegramGateway],
  controllers: [TelegramController],
})
export class TelegramModule {}
