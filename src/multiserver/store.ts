// Server bindings, preferences and snapshots live in MySQL; credentials are sealed with AES-256-GCM.
import { appStore } from "../store/index.js"

export { seal, unseal } from "../store/mysql-stores.js"

export function serverStore() { return appStore().servers }
