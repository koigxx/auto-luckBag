import { app } from 'electron'
// Acquire before importing stores: a second process must not recover or mutate the ledger.
if (!app.requestSingleInstanceLock()) app.quit()
else void import('./application')
