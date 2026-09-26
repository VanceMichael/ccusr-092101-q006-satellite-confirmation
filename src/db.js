
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function openDatabase(databasePath) {
  const resolved = databasePath || process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
  if (resolved !== ":memory:") {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const pending = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !applied.has(path.basename(name, ".sql")));
  for (const name of pending) {
    const version = path.basename(name, ".sql");
    db.exec("BEGIN");
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

// 事务包装：多步写入要么全部生效，要么全部回滚；嵌套使用 SAVEPOINT
const txDepth = new WeakMap();

function inTransaction(db, fn) {
  const depth = txDepth.get(db) || 0;
  if (depth === 0) {
    db.exec("BEGIN");
  } else {
    db.exec(`SAVEPOINT sp_${depth}`);
  }
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    if (depth === 0) {
      db.exec("COMMIT");
    } else {
      db.exec(`RELEASE sp_${depth}`);
    }
    txDepth.set(db, depth);
    return result;
  } catch (error) {
    if (depth === 0) {
      db.exec("ROLLBACK");
    } else {
      db.exec(`ROLLBACK TO sp_${depth}`);
      db.exec(`RELEASE sp_${depth}`);
    }
    txDepth.set(db, depth);
    throw error;
  }
}

module.exports = { openDatabase, migrate, inTransaction };
