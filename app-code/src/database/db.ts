import * as SQLite from 'expo-sqlite';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function initDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('edge_analyzer.db');

  // Enable Write-Ahead Logging (WAL) and foreign keys
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');

  // Core & MVP-1.0 Tables
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      original_uri TEXT NOT NULL,
      size_bytes INTEGER,
      is_default INTEGER DEFAULT 0,
      is_embedding INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      modality TEXT DEFAULT 'text',
      mmproj_uri TEXT,
      mmproj_filename TEXT,
      mmproj_size_bytes INTEGER
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      system_prompt TEXT,
      is_custom_title INTEGER DEFAULT 0,
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      conversation_id UNINDEXED,
      content
    );

    CREATE TABLE IF NOT EXISTS message_embeddings (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding_vector BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_facts (
      id TEXT PRIMARY KEY,
      fact_text TEXT NOT NULL,
      category TEXT NOT NULL,
      embedding_vector BLOB NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL
    );
  `);

  // MindSpace Multimodal Notebook Tables (MVP 2.0) & Distributed Mesh (MVP 3.0)
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      color_tag TEXT DEFAULT '#3B82F6',
      notebook_notes TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notebook_assets (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      file_uri TEXT,
      extracted_text TEXT,
      structured_card TEXT,
      user_note TEXT DEFAULT '',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS asset_chunks (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      tokens_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES notebook_assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notebook_conversations (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      target_asset_id TEXT,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
      FOREIGN KEY (target_asset_id) REFERENCES notebook_assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notebook_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sources_json TEXT,
      tokens_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES notebook_conversations(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS asset_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      notebook_id UNINDEXED,
      asset_id UNINDEXED,
      chunk_text
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform_handle TEXT,
      default_platform TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      communication_style TEXT,
      profile_summary TEXT,
      avatar_color TEXT DEFAULT '#8B5CF6',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_interactions (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      source_type TEXT NOT NULL,
      screenshot_uri TEXT,
      raw_transcript TEXT NOT NULL,
      situation_summary TEXT,
      detected_sentiment TEXT,
      user_intent TEXT,
      selected_reply TEXT,
      custom_reply_feedback TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contact_facts (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      fact_text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mesh_node_config (
      node_id TEXT PRIMARY KEY,
      node_name TEXT NOT NULL,
      node_tier TEXT NOT NULL,
      is_worker_enabled INTEGER DEFAULT 0,
      cluster_secret TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mesh_peers (
      node_id TEXT PRIMARY KEY,
      node_name TEXT NOT NULL,
      device_tier TEXT NOT NULL,
      shared_token TEXT NOT NULL,
      last_known_ip TEXT NOT NULL,
      last_known_port INTEGER NOT NULL,
      is_trusted INTEGER DEFAULT 1,
      capabilities_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  return db;
}

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = initDatabase().catch((err) => {
      // Reset promise if init failed so subsequent calls can retry
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}