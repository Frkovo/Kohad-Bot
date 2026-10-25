// Compatibility accessor for the score store. The implementation (MySQL or the test double) lives in src/store.
import { appStore } from "../store/index.js"

export function scoreDatabase() { return appStore().scores }
