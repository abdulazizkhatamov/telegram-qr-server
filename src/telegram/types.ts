import { TelegramClient } from 'telegram';

export interface QrSession {
  sessionId: string;
  client: TelegramClient;
  createdAt: number;
}
