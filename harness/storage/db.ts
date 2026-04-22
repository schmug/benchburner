/**
 * Thin wrapper around better-sqlite3: opens the per-run state.db,
 * applies the idempotent schema on init, sets pragmas for WAL +
 * foreign keys, and exposes the raw handle for writers/export.
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolve schema.sql relative to this module — works both when running
// TS source via tsx (file lives next to db.ts) and when running compiled
// dist/ output (copy schema.sql alongside at build time).
const SCHEMA_PATH = resolve(HERE, "schema.sql");

export class Db {
  readonly raw: Database.Database;

  constructor(filePath: string) {
    this.raw = new Database(filePath);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    this.raw.exec(schema);
  }

  close(): void {
    this.raw.close();
  }
}

export function openDb(filePath: string): Db {
  return new Db(filePath);
}
