import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { TelegramService } from './telegram.service';

class Submit2FADto {
  loginId: string;
  password: string;
}

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  /**
   * POST /telegram/2fa
   * Submit the cloud password for a login session that requires 2FA.
   */
  @Post('2fa')
  @HttpCode(200)
  async submit2FA(@Body() body: Submit2FADto) {
    await this.telegramService.submit2FAPassword(body.loginId, body.password);
    return { ok: true };
  }
}
