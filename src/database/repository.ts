import { getDatabase } from './db';

// ----------------------------------------------------
// Interfaces
// ----------------------------------------------------
export interface ModelRecord {
  id: string;
  original_name: string;
  original_uri: string;
  size_bytes: number | null;
  is_default: number;
  is_embedding: number;
  created_at: number;
  modality?: 'text' | 'vision';
  mmproj_uri?: string | null;
  mmproj_filename?: string | null;
  mmproj_size_bytes?: number | null;
}

export interface ConversationRecord {
  id: string;
  title: string;
  model_id: string | null;
  created_at: number;
  updated_at: number;
  system_prompt: string | null;
  is_custom_title: number;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  tokens_count: number;
  created_at: number;
}

export interface MessageEmbeddingRecord {
  id: string;
  message_id: string;
  conversation_id: string;
  chunk_text: string;
  embedding_vector: Uint8Array;
  created_at: number;
}

export interface UserFactRecord {
  id: string;
  fact_text: string;
  category: string;
  embedding_vector: Uint8Array;
  confidence: number;
  created_at: number;
}

// MindSpace Multimodal Notebook Models
export interface NotebookRecord {
  id: string;
  title: string;
  description: string | null;
  color_tag: string;
  notebook_notes: string;
  created_at: number;
  updated_at: number;
}

export type AssetType = 'screenshot' | 'image' | 'text_note' | 'document';

export interface NotebookAssetRecord {
  id: string;
  notebook_id: string;
  type: AssetType;
  title: string;
  file_uri: string | null;
  extracted_text: string | null;
  structured_card: string | null;
  user_note: string;
  metadata_json: string | null;
  created_at: number;
}

export interface AssetChunkRecord {
  id: string;
  notebook_id: string;
  asset_id: string;
  chunk_index: number;
  chunk_text: string;
  embedding: Uint8Array;
  tokens_count: number;
  created_at: number;
}

export interface NotebookConversationRecord {
  id: string;
  notebook_id: string;
  target_asset_id: string | null;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface NotebookMessageRecord {
  id: string;
  conversation_id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  sources_json: string | null;
  tokens_count: number;
  created_at: number;
}

// ----------------------------------------------------
// Vector & UUID Helpers
// ----------------------------------------------------
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function blobToVector(blob: Uint8Array): Float32Array {
  const byteOffset = blob.byteOffset;
  const byteLength = blob.byteLength;
  return new Float32Array(blob.buffer.slice(byteOffset, byteOffset + byteLength));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ----------------------------------------------------
// Models CRUD
// ----------------------------------------------------
export async function getAllModels(): Promise<ModelRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<ModelRecord>('SELECT * FROM models ORDER BY created_at DESC;');
}

export async function getChatModels(): Promise<ModelRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<ModelRecord>(
    'SELECT * FROM models WHERE is_embedding = 0 ORDER BY created_at DESC;'
  );
}

export async function getEmbeddingModel(): Promise<ModelRecord | null> {
  const db = await getDatabase();
  return db.getFirstAsync<ModelRecord>(
    'SELECT * FROM models WHERE is_embedding = 1 LIMIT 1;'
  );
}

export async function getModelById(id: string): Promise<ModelRecord | null> {
  const db = await getDatabase();
  return db.getFirstAsync<ModelRecord>('SELECT * FROM models WHERE id = ?;', [id]);
}

export async function getDefaultChatModel(): Promise<ModelRecord | null> {
  const db = await getDatabase();
  return db.getFirstAsync<ModelRecord>(
    'SELECT * FROM models WHERE is_default = 1 AND is_embedding = 0 LIMIT 1;'
  );
}

export async function insertModel(
  name: string,
  uri: string,
  sizeBytes: number | null,
  isEmbedding: boolean = false,
  modality: 'text' | 'vision' = 'text',
  mmprojUri: string | null = null,
  mmprojFilename: string | null = null,
  mmprojSizeBytes: number | null = null
): Promise<ModelRecord> {
  const db = await getDatabase();
  const id = generateUUID();
  const now = Date.now();

  const countRow = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM models WHERE is_embedding = 0;'
  );
  const isDefault = !isEmbedding && countRow && countRow.count === 0 ? 1 : 0;

  await db.runAsync(
    `INSERT INTO models (
      id, original_name, original_uri, size_bytes, is_default, is_embedding, created_at,
      modality, mmproj_uri, mmproj_filename, mmproj_size_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      name,
      uri,
      sizeBytes,
      isDefault,
      isEmbedding ? 1 : 0,
      now,
      modality,
      mmprojUri,
      mmprojFilename,
      mmprojSizeBytes,
    ]
  );

  return {
    id,
    original_name: name,
    original_uri: uri,
    size_bytes: sizeBytes,
    is_default: isDefault,
    is_embedding: isEmbedding ? 1 : 0,
    created_at: now,
    modality,
    mmproj_uri: mmprojUri,
    mmproj_filename: mmprojFilename,
    mmproj_size_bytes: mmprojSizeBytes,
  };
}

export async function insertVisionModel(
  baseName: string,
  baseUri: string,
  baseSizeBytes: number | null,
  mmprojName: string,
  mmprojUri: string,
  mmprojSizeBytes: number | null
): Promise<ModelRecord> {
  return insertModel(
    baseName,
    baseUri,
    baseSizeBytes,
    false,
    'vision',
    mmprojUri,
    mmprojName,
    mmprojSizeBytes
  );
}

export async function lockDedicatedEmbeddingModel(id: string): Promise<void> {
  const db = await getDatabase();
  const existing = await getEmbeddingModel();
  if (existing) {
    throw new Error('A dedicated embedding model has already been locked.');
  }

  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE models SET is_default = 0, is_embedding = 1 WHERE id = ?;', [id]);
  });
}

export async function setDefaultChatModel(id: string): Promise<void> {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE models SET is_default = 0 WHERE is_embedding = 0;');
    await db.runAsync('UPDATE models SET is_default = 1 WHERE id = ? AND is_embedding = 0;', [id]);
  });
}

export async function deleteModel(id: string): Promise<void> {
  const db = await getDatabase();
  const target = await getModelById(id);
  if (target?.is_embedding === 1) {
    throw new Error('Cannot delete the locked embedding model.');
  }
  await db.runAsync('DELETE FROM models WHERE id = ?;', [id]);
}

// ----------------------------------------------------
// Conversations & Messages CRUD
// ----------------------------------------------------
export async function getAllConversations(): Promise<ConversationRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<ConversationRecord>(
    'SELECT * FROM conversations ORDER BY updated_at DESC;'
  );
}

export async function getConversationById(id: string): Promise<ConversationRecord | null> {
  const db = await getDatabase();
  return db.getFirstAsync<ConversationRecord>('SELECT * FROM conversations WHERE id = ?;', [id]);
}

export async function createConversation(
  title: string,
  modelId: string | null = null,
  systemPrompt: string | null = null
): Promise<ConversationRecord> {
  const db = await getDatabase();
  const id = `conv_${Date.now()}_${generateUUID().substring(0, 8)}`;
  const now = Date.now();

  await db.runAsync(
    `INSERT INTO conversations (id, title, model_id, created_at, updated_at, system_prompt, is_custom_title)
     VALUES (?, ?, ?, ?, ?, ?, 0);`,
    [id, title, modelId, now, now, systemPrompt]
  );

  return {
    id,
    title,
    model_id: modelId,
    created_at: now,
    updated_at: now,
    system_prompt: systemPrompt,
    is_custom_title: 0,
  };
}

export async function updateConversationTitle(
  id: string,
  title: string,
  isCustom: boolean = false
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE conversations SET title = ?, is_custom_title = ?, updated_at = ? WHERE id = ?;',
    [title, isCustom ? 1 : 0, Date.now(), id]
  );
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM messages_fts WHERE conversation_id = ?;', [id]);
    await db.runAsync('DELETE FROM conversations WHERE id = ?;', [id]);
  });
}

export async function getMessagesByConversation(
  conversationId: string
): Promise<MessageRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<MessageRecord>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC;',
    [conversationId]
  );
}

export async function insertMessage(
  conversationId: string,
  role: 'system' | 'user' | 'assistant',
  content: string,
  tokensCount: number = 0
): Promise<MessageRecord> {
  const db = await getDatabase();
  const id = `msg_${Date.now()}_${generateUUID().substring(0, 8)}`;
  const now = Date.now();

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO messages (id, conversation_id, role, content, tokens_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, conversationId, role, content, tokensCount, now]
    );

    await db.runAsync(
      `INSERT INTO messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?);`,
      [id, conversationId, content]
    );

    await db.runAsync('UPDATE conversations SET updated_at = ? WHERE id = ?;', [
      now,
      conversationId,
    ]);
  });

  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    tokens_count: tokensCount,
    created_at: now,
  };
}

export async function searchMessagesFTS(
  query: string,
  limit: number = 30
): Promise<Array<{ message_id: string; conversation_id: string; content: string }>> {
  const db = await getDatabase();
  const sanitizedQuery = query.replace(/[^\w\s]/gi, '').trim();
  if (!sanitizedQuery) return [];

  return db.getAllAsync(
    `SELECT message_id, conversation_id, content FROM messages_fts
     WHERE messages_fts MATCH ? LIMIT ?;`,
    [`${sanitizedQuery}*`, limit]
  );
}

// ----------------------------------------------------
// Memory Embeddings & User Facts
// ----------------------------------------------------
export async function insertMessageEmbedding(
  messageId: string,
  conversationId: string,
  chunkText: string,
  vector: Float32Array
): Promise<void> {
  const db = await getDatabase();
  const id = generateUUID();
  const blob = vectorToBlob(vector);
  await db.runAsync(
    `INSERT INTO message_embeddings (id, message_id, conversation_id, chunk_text, embedding_vector, created_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [id, messageId, conversationId, chunkText, blob, Date.now()]
  );
}

export async function getAllMessageEmbeddings(): Promise<MessageEmbeddingRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<MessageEmbeddingRecord>('SELECT * FROM message_embeddings;');
}

export async function insertUserFact(
  factText: string,
  category: string,
  vector: Float32Array,
  confidence: number = 1.0
): Promise<void> {
  const db = await getDatabase();
  const id = generateUUID();
  const blob = vectorToBlob(vector);
  await db.runAsync(
    `INSERT INTO user_facts (id, fact_text, category, embedding_vector, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [id, factText, category, blob, confidence, Date.now()]
  );
}

export async function getAllUserFacts(): Promise<UserFactRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<UserFactRecord>('SELECT * FROM user_facts ORDER BY created_at DESC;');
}

// ----------------------------------------------------
// MindSpace Multimodal Notebooks CRUD (MVP 2.0)
// ----------------------------------------------------
export async function getAllNotebooks(): Promise<
  Array<NotebookRecord & { asset_count: number }>
> {
  const db = await getDatabase();
  return db.getAllAsync<NotebookRecord & { asset_count: number }>(`
    SELECT n.*, COUNT(a.id) as asset_count
    FROM notebooks n
    LEFT JOIN notebook_assets a ON n.id = a.notebook_id
    GROUP BY n.id
    ORDER BY n.updated_at DESC;
  `);
}

export async function getNotebookById(id: string): Promise<NotebookRecord | null> {
  const db = await getDatabase();
  return db.getFirstAsync<NotebookRecord>('SELECT * FROM notebooks WHERE id = ?;', [id]);
}

export async function createNotebook(
  title: string,
  description: string | null = null,
  colorTag: string = '#3B82F6'
): Promise<NotebookRecord> {
  const db = await getDatabase();
  const id = `nb_${Date.now()}_${generateUUID().substring(0, 8)}`;
  const now = Date.now();

  await db.runAsync(
    `INSERT INTO notebooks (id, title, description, color_tag, notebook_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?);`,
    [id, title, description, colorTag, now, now]
  );

  return {
    id,
    title,
    description,
    color_tag: colorTag,
    notebook_notes: '',
    created_at: now,
    updated_at: now,
  };
}

export async function updateNotebook(
  id: string,
  title: string,
  description: string | null,
  colorTag: string
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE notebooks SET title = ?, description = ?, color_tag = ?, updated_at = ? WHERE id = ?;',
    [title, description, colorTag, Date.now(), id]
  );
}

export async function updateNotebookNotes(id: string, notes: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE notebooks SET notebook_notes = ?, updated_at = ? WHERE id = ?;',
    [notes, Date.now(), id]
  );
}

export async function deleteNotebook(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM notebooks WHERE id = ?;', [id]);
}

// Notebook Assets
export async function getAssetsByNotebook(notebookId: string): Promise<NotebookAssetRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<NotebookAssetRecord>(
    'SELECT * FROM notebook_assets WHERE notebook_id = ? ORDER BY created_at DESC;',
    [notebookId]
  );
}

export async function getAssetById(id: string): Promise<NotebookAssetRecord | null> {
  const db = await getDatabase();
  return db.getFirstAsync<NotebookAssetRecord>('SELECT * FROM notebook_assets WHERE id = ?;', [id]);
}

export async function insertNotebookAsset(
  notebookId: string,
  type: AssetType,
  title: string,
  fileUri: string | null,
  extractedText: string | null,
  structuredCard: string | null,
  metadata: Record<string, any> = {},
  userNote: string = ''
): Promise<NotebookAssetRecord> {
  const db = await getDatabase();
  const id = `asset_${Date.now()}_${generateUUID().substring(0, 8)}`;
  const now = Date.now();
  const metaJson = JSON.stringify(metadata);

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO notebook_assets (
        id, notebook_id, type, title, file_uri, extracted_text, structured_card, user_note, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        notebookId,
        type,
        title,
        fileUri,
        extractedText,
        structuredCard,
        userNote,
        metaJson,
        now,
      ]
    );

    await db.runAsync('UPDATE notebooks SET updated_at = ? WHERE id = ?;', [now, notebookId]);
  });

  return {
    id,
    notebook_id: notebookId,
    type,
    title,
    file_uri: fileUri,
    extracted_text: extractedText,
    structured_card: structuredCard,
    user_note: userNote,
    metadata_json: metaJson,
    created_at: now,
  };
}

export async function updateAssetNote(assetId: string, userNote: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE notebook_assets SET user_note = ? WHERE id = ?;', [userNote, assetId]);
}

export async function updateAssetStructuredCard(
  assetId: string,
  structuredCard: string
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE notebook_assets SET structured_card = ? WHERE id = ?;', [
    structuredCard,
    assetId,
  ]);
}

export async function getAssetChunksByNotebook(notebookId: string): Promise<AssetChunkRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<AssetChunkRecord>(
    'SELECT * FROM asset_chunks WHERE notebook_id = ? ORDER BY chunk_index ASC;',
    [notebookId]
  );
}

// Notebook Conversations & Messages
export async function getNotebookConversations(
  notebookId: string,
  targetAssetId: string | null = null
): Promise<NotebookConversationRecord[]> {
  const db = await getDatabase();
  if (targetAssetId) {
    return db.getAllAsync<NotebookConversationRecord>(
      'SELECT * FROM notebook_conversations WHERE notebook_id = ? AND target_asset_id = ? ORDER BY updated_at DESC;',
      [notebookId, targetAssetId]
    );
  }
  return db.getAllAsync<NotebookConversationRecord>(
    'SELECT * FROM notebook_conversations WHERE notebook_id = ? AND target_asset_id IS NULL ORDER BY updated_at DESC;',
    [notebookId]
  );
}

export async function getOrCreateNotebookConversation(
  notebookId: string,
  targetAssetId: string | null = null,
  defaultTitle: string = 'Notebook Research'
): Promise<NotebookConversationRecord> {
  const db = await getDatabase();
  let existing: NotebookConversationRecord | null = null;

  if (targetAssetId) {
    existing = await db.getFirstAsync<NotebookConversationRecord>(
      'SELECT * FROM notebook_conversations WHERE notebook_id = ? AND target_asset_id = ? LIMIT 1;',
      [notebookId, targetAssetId]
    );
  } else {
    existing = await db.getFirstAsync<NotebookConversationRecord>(
      'SELECT * FROM notebook_conversations WHERE notebook_id = ? AND target_asset_id IS NULL LIMIT 1;',
      [notebookId]
    );
  }

  if (existing) return existing;

  const id = `nb_conv_${Date.now()}_${generateUUID().substring(0, 8)}`;
  const now = Date.now();

  await db.runAsync(
    `INSERT INTO notebook_conversations (id, notebook_id, target_asset_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [id, notebookId, targetAssetId, defaultTitle, now, now]
  );

  return {
    id,
    notebook_id: notebookId,
    target_asset_id: targetAssetId,
    title: defaultTitle,
    created_at: now,
    updated_at: now,
  };
}

export async function getNotebookMessages(conversationId: string): Promise<NotebookMessageRecord[]> {
  const db = await getDatabase();
  return db.getAllAsync<NotebookMessageRecord>(
    'SELECT * FROM notebook_messages WHERE conversation_id = ? ORDER BY created_at ASC;',
    [conversationId]
  );
}

export async function insertNotebookMessage(
  conversationId: string,
  role: 'system' | 'user' | 'assistant',
  content: string,
  sources: Array<{ asset_id: string; title: string; chunk_preview: string }> = [],
  tokensCount: number = 0
): Promise<NotebookMessageRecord> {
  const db = await getDatabase();
  const id = `nb_msg_${Date.now()}_${generateUUID().substring(0, 8)}`;
  const now = Date.now();
  const sourcesJson = sources.length > 0 ? JSON.stringify(sources) : null;

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO notebook_messages (id, conversation_id, role, content, sources_json, tokens_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [id, conversationId, role, content, sourcesJson, tokensCount, now]
    );

    await db.runAsync('UPDATE notebook_conversations SET updated_at = ? WHERE id = ?;', [
      now,
      conversationId,
    ]);
  });

  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    sources_json: sourcesJson,
    tokens_count: tokensCount,
    created_at: now,
  };
}


export async function insertAssetChunk(
    notebookId: string,
    assetId: string,
    chunkIndex: number,
    chunkText: string,
    embedding: Float32Array,
    tokensCount: number
): Promise<void> {
  const db = await getDatabase();
  const id = `chk_${Date.now()}_${generateUUID().substring(0, 8)}`;
  const blob = vectorToBlob(embedding);

  await db.withTransactionAsync(async () => {
    // 1. Vector table
    await db.runAsync(
        `INSERT INTO asset_chunks (id, notebook_id, asset_id, chunk_index, chunk_text, embedding, tokens_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [id, notebookId, assetId, chunkIndex, chunkText, blob, tokensCount, Date.now()]
    );

    // 2. Full-Text Search index
    await db.runAsync(
        `INSERT INTO asset_chunks_fts (chunk_id, notebook_id, asset_id, chunk_text)
       VALUES (?, ?, ?, ?);`,
        [id, notebookId, assetId, chunkText]
    );
  });
}

export async function searchAssetChunksFTS(
    notebookId: string,
    query: string,
    limit: number = 20
): Promise<Array<{ chunk_id: string; asset_id: string; chunk_text: string; rank: number }>> {
  const db = await getDatabase();
  const sanitized = query.replace(/[^\w\s]/gi, '').trim();
  if (!sanitized) return [];

  // Match words with prefix wildcards
  const ftsQuery = sanitized
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `${w}*`)
      .join(' OR ');

  if (!ftsQuery) return [];

  try {
    return await db.getAllAsync(
        `SELECT chunk_id, asset_id, chunk_text, rank
       FROM asset_chunks_fts
       WHERE notebook_id = ? AND asset_chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?;`,
        [notebookId, ftsQuery, limit]
    );
  } catch (err) {
    console.warn('[Repository] FTS search skipped:', err);
    return [];
  }
}

export async function deleteNotebookAsset(assetId: string): Promise<void> {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM asset_chunks_fts WHERE asset_id = ?;', [assetId]);
    await db.runAsync('DELETE FROM notebook_assets WHERE id = ?;', [assetId]);
  });
}