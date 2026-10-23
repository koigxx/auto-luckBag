export type AuthState = 'checking' | 'connected' | 'expired' | 'unknown' | 'signed-out'
export interface AuthStatus { isLoggedIn: boolean; state: AuthState; checkedAt: number | null }
