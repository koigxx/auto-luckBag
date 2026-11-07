export type AuthState = 'checking' | 'connected' | 'expired' | 'unknown' | 'signed-out'
export type AuthCheck = 'pending' | 'passed' | 'failed' | 'unknown'
export interface AuthDiagnostics {
  mode: 'saved' | 'manual'
  startedAt: number
  updatedAt: number
  browser: AuthCheck
  page: AuthCheck
  evidence: AuthCheck
  identity: AuthCheck
  challenge: boolean
  reason: 'checking' | 'no-session' | 'expired' | 'no-evidence' | 'browser-error' | 'page-error' | 'closed' | 'account-changed' | 'connected'
}
export interface AuthStatus { isLoggedIn: boolean; state: AuthState; checkedAt: number | null; diagnostics?: AuthDiagnostics; accountRevision?: number }
