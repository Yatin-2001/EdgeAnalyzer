import * as SQLite from 'expo-sqlite';

let dbInstance: SQLite.SQLiteDatabase | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
    if (!dbInstance) {
        dbInstance = await SQLite.openDatabaseAsync('edge_analyzer.db');
        await dbInstance.execAsync('PRAGMA foreign_keys = ON;');
        await runMigrations(dbInstance);
    }
    return dbInstance;
}

async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
    await db.execAsync(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY NOT NULL,
      original_name TEXT NOT NULL,
      original_uri TEXT NOT NULL UNIQUE,
      size_bytes INTEGER,
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      model_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      system_prompt TEXT,
      FOREIGN KEY (model_id) REFERENCES models (id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      content TEXT NOT NULL,
      tokens_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation 
    ON messages(conversation_id, created_at ASC);
  `);
}