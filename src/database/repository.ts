import { getDatabase } from './db';

export interface ModelRecord {
    id: string;
    original_name: string;
    original_uri: string;
    size_bytes: number | null;
    is_default: number; // 0 | 1
    created_at: number;
}

export interface ConversationRecord {
    id: string;
    title: string;
    model_id: string | null;
    created_at: number;
    updated_at: number;
    system_prompt: string | null;
}

export interface MessageRecord {
    id: string;
    conversation_id: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    tokens_count: number;
    created_at: number;
}

export function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

// ----------------------------------------------------
// Models CRUD
// ----------------------------------------------------
export async function getAllModels(): Promise<ModelRecord[]> {
    const db = await getDatabase();
    return db.getAllAsync<ModelRecord>(
        'SELECT * FROM models ORDER BY created_at DESC;'
    );
}

export async function getModelById(id: string): Promise<ModelRecord | null> {
    const db = await getDatabase();
    return db.getFirstAsync<ModelRecord>(
        'SELECT * FROM models WHERE id = ?;',
        [id]
    );
}

export async function getDefaultModel(): Promise<ModelRecord | null> {
    const db = await getDatabase();
    return db.getFirstAsync<ModelRecord>(
        'SELECT * FROM models WHERE is_default = 1 LIMIT 1;'
    );
}

export async function insertModel(
    name: string,
    uri: string,
    sizeBytes: number | null
): Promise<ModelRecord> {
    const db = await getDatabase();
    const id = generateUUID();
    const now = Date.now();

    const countRow = await db.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) as count FROM models;'
    );
    const isDefault = countRow && countRow.count === 0 ? 1 : 0;

    await db.runAsync(
        `INSERT INTO models (id, original_name, original_uri, size_bytes, is_default, created_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
        [id, name, uri, sizeBytes, isDefault, now]
    );

    return {
        id,
        original_name: name,
        original_uri: uri,
        size_bytes: sizeBytes,
        is_default: isDefault,
        created_at: now,
    };
}

export async function setDefaultModel(id: string): Promise<void> {
    const db = await getDatabase();
    await db.withTransactionAsync(async () => {
        await db.runAsync('UPDATE models SET is_default = 0;');
        await db.runAsync('UPDATE models SET is_default = 1 WHERE id = ?;', [id]);
    });
}

export async function deleteModel(id: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM models WHERE id = ?;', [id]);
}

// ----------------------------------------------------
// Conversations CRUD
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
        `INSERT INTO conversations (id, title, model_id, created_at, updated_at, system_prompt)
     VALUES (?, ?, ?, ?, ?, ?);`,
        [id, title, modelId, now, now, systemPrompt]
    );

    return {
        id,
        title,
        model_id: modelId,
        created_at: now,
        updated_at: now,
        system_prompt: systemPrompt,
    };
}

export async function updateConversationTitle(id: string, title: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
        'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?;',
        [title, Date.now(), id]
    );
}

export async function updateConversationModel(id: string, modelId: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
        'UPDATE conversations SET model_id = ?, updated_at = ? WHERE id = ?;',
        [modelId, Date.now(), id]
    );
}

export async function deleteConversation(id: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM conversations WHERE id = ?;', [id]);
}

// ----------------------------------------------------
// Messages CRUD
// ----------------------------------------------------
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
    const id = generateUUID();
    const now = Date.now();

    await db.withTransactionAsync(async () => {
        await db.runAsync(
            `INSERT INTO messages (id, conversation_id, role, content, tokens_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
            [id, conversationId, role, content, tokensCount, now]
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