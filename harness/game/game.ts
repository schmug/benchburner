/**
 * Game module facade. Re-exports the GameController interface so
 * callers can `import { GameController } from "../game/game.ts"`
 * without coupling to any specific implementation (mock in Phase 2,
 * Puppeteer + Remote File API in Phase 4).
 */

export type { GameController, GameState, ExecutionResult } from "../types.ts";
