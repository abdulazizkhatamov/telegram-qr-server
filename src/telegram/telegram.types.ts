export interface LoginData {
  socketId: string;
  status: 'pending' | 'scanned' | 'success' | 'expired';
  session?: string;
  userId?: string;
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
