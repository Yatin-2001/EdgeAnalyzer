import { getDatabase } from './db';

export interface ModelRecord {
    id: string;
    original_name: string;
    original_uri: string;
    size_bytes: number | null;
    is_default: number;
    is_embedding: number; // 1 = Locked embedding model
    created_at: number;
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

// ----------------------------------------------------
// Models CRUD & Dedicated Embedding Lock
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
    isEmbedding: boolean = false
): Promise<ModelRecord> {
    const db = await getDatabase();
    const id = generateUUID();
    const now = Date.now();

    const countRow = await db.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) as count FROM models WHERE is_embedding = 0;'
    );
    const isDefault = !isEmbedding && countRow && countRow.count === 0 ? 1 : 0;

    await db.runAsync(
        `INSERT INTO models (id, original_name, original_uri, size_bytes, is_default, is_embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [id, name, uri, sizeBytes, isDefault, isEmbedding ? 1 : 0, now]
    );

    return {
        id,
        original_name: name,
        original_uri: uri,
        size_bytes: sizeBytes,
        is_default: isDefault,
        is_embedding: isEmbedding ? 1 : 0,
        created_at: now,
    };
}

/**
 * Irreversibly locks a model as the dedicated embedding model.
 */
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
    return db.getFirstAsync<ConversationRecord>(
        'SELECT * FROM conversations WHERE id = ?;',
        [id]
    );
}

export async function createConversation(
    title: string,
    modelId: string | null = null,
    systemPrompt: string | null = null
): Promise<ConversationRecord> {
    const db = await getDatabase();
    const id = generateUUID();
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

export async function getMessagesByConversation(conversationId: string): Promise<MessageRecord[]> {
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
    const id = generateUUID();
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

        await db.runAsync(
            'UPDATE conversations SET updated_at = ? WHERE id = ?;',
            [now, conversationId]
        );
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