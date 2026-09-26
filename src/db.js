
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { migrate } = require("../scripts/migrate");

let defaultDatabase;

function openDatabase(databasePath) {
  const db = migrate(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

function getDatabase() {
  if (!defaultDatabase) {
    const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
    defaultDatabase = openDatabase(databasePath);
  }
  return defaultDatabase;
}

function setDatabase(db) {
  defaultDatabase = db;
}

module.exports = { openDatabase, getDatabase, setDatabase };
