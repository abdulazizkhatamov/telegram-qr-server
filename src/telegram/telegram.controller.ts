import { Controller } from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  // @Post('qr')
  // exportLoginToken() {
  //   return this.telegramService.exportLoginToken();
  // }
}
