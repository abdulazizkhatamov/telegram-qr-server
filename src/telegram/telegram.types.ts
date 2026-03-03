export interface LoginData {
  socketId: string;
  status: 'pending' | 'scanned' | 'awaiting_2fa' | 'success' | 'expired';
  session?: string;
  userId?: string;
  twoFaError?: string;
}

export interface UserSession {
  userId: string;
  sessionString: string;
  firstName: string;
  lastName?: string;
  username?: string;
  phone?: string;
  createdAt: number;
  lastUsedAt: number;
}
