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
    // 1. Ensure core tables exist
    await db.execAsync(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY NOT NULL,
      original_name TEXT NOT NULL,
      original_uri TEXT NOT NULL UNIQUE,
      size_bytes INTEGER,
      is_default INTEGER DEFAULT 0,
      is_embedding INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      model_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      system_prompt TEXT,
      is_custom_title INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS message_embeddings (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding_vector BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_facts (
      id TEXT PRIMARY KEY NOT NULL,
      fact_text TEXT NOT NULL,
      category TEXT NOT NULL,
      embedding_vector BLOB NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation 
    ON messages(conversation_id, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_embeddings_conv 
    ON message_embeddings(conversation_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      conversation_id UNINDEXED,
      content
    );
  `);

    // 2. Safely apply column migrations if upgrading from an older DB version
    const modelCols = await db.getAllAsync<{ name: string }>(
        'PRAGMA table_info(models);'
    );
    const hasIsEmbedding = modelCols.some((col) => col.name === 'is_embedding');
    if (!hasIsEmbedding) {
        await db.execAsync(
            'ALTER TABLE models ADD COLUMN is_embedding INTEGER DEFAULT 0;'
        );
    }

    const convCols = await db.getAllAsync<{ name: string }>(
        'PRAGMA table_info(conversations);'
    );
    const hasIsCustomTitle = convCols.some((col) => col.name === 'is_custom_title');
    if (!hasIsCustomTitle) {
        await db.execAsync(
            'ALTER TABLE conversations ADD COLUMN is_custom_title INTEGER DEFAULT 0;'
        );
    }
}