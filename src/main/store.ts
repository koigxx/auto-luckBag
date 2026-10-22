import Store from 'electron-store'
import { AppConfig, defaults } from '../shared/config'
export type { AppConfig, RunStats, RoomConfig, FudaiTypes } from '../shared/config'
export const store = new Store<AppConfig>({ defaults })
