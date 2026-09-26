
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function migrate(databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3")) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const migrationsDir = path.join(process.cwd(), "migrations");
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    database.exec("BEGIN");
    try {
      database.exec(sql);
      database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(version);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return database;
}

if (require.main === module) {
  const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
  const database = migrate(databasePath);
  database.close();
  console.log(`数据库迁移完成：${databasePath}`);
}

module.exports = { migrate };
