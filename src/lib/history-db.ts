import type { D1Database } from '@cloudflare/workers-types';
import mysql from 'mysql2/promise';
import { getUserDatabase } from '@/lib/user-db';

export type GenerationHistoryItem = {
  id: string;
  title: string;
  snippet: string;
  wordCount: number;
  createdAt: string;
};

export type GenerationHistoryDetail = GenerationHistoryItem & {
  content: string;
  locale: string;
};

export const HISTORY_MAX_PER_USER = 100;
export const HISTORY_MAX_CONTENT_LENGTH = 800_000;
export const HISTORY_MAX_TITLE_LENGTH = 120;

const HISTORY_PAGE_SIZE = 10;

const HISTORY_D1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_generation_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'zh',
    word_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_app_gen_history_user_time ON app_generation_history(user_id, created_at)',
];

const HISTORY_MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_generation_history (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    title VARCHAR(256) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    locale VARCHAR(8) NOT NULL DEFAULT 'zh',
    word_count INT NOT NULL DEFAULT 0,
    created_at VARCHAR(64) NOT NULL,
    INDEX idx_app_gen_history_user_time (user_id, created_at)
  )`,
];

let historyReady = false;
let d1HistoryReadyPromise: Promise<void> | null = null;

async function ensureHistorySchema(database: NonNullable<Awaited<ReturnType<typeof getUserDatabase>>>) {
  if (database.kind === 'd1') {
    if (!d1HistoryReadyPromise) {
      d1HistoryReadyPromise = (async () => {
        for (const sql of HISTORY_D1_SCHEMA) await (database.db as D1Database).prepare(sql).run();
      })();
    }
    try {
      await d1HistoryReadyPromise;
    } catch (error) {
      d1HistoryReadyPromise = null;
      throw error;
    }
    return;
  }
  if (!historyReady) {
    for (const sql of HISTORY_MYSQL_SCHEMA) await database.db.query(sql);
    historyReady = true;
  }
}

async function getHistoryDatabase() {
  const database = await getUserDatabase();
  await ensureHistorySchema(database);
  return database;
}

export function deriveHistoryTitle(content: string): string {
  const lines = (content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const htmlH1 = line.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (htmlH1?.[1]) {
      const title = htmlH1[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (title) return title.slice(0, HISTORY_MAX_TITLE_LENGTH);
    }
    const mdH1 = line.match(/^#\s+(.+)$/);
    if (mdH1?.[1]) {
      const title = mdH1[1].replace(/\s+/g, ' ').trim();
      if (title) return title.slice(0, HISTORY_MAX_TITLE_LENGTH);
    }
  }
  const firstLine = lines[0] || '';
  return (firstLine.replace(/[#>*`\-\[\]]/g, '').trim() || 'AI排版美化文档').slice(0, HISTORY_MAX_TITLE_LENGTH);
}

/** Strips HTML tags and markdown syntax so history snippets show plain text only. */
export function deriveHistorySnippet(content: string, maxLength = 140): string {
  const cleaned = (content || '')
    // block-level html wrappers commonly emitted by the formatter
    .replace(/<div\s+align=["'](?:center|right)["']>/gi, ' ')
    .replace(/<\/(?:div|h[1-6]|p|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/[*`_>]/g, '')
    .replace(/^\s*[-—]{3,}\s*$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

export async function saveGenerationHistory(input: {
  userId: string;
  title: string;
  content: string;
  locale: string;
  wordCount: number;
}): Promise<string> {
  const database = await getHistoryDatabase();
  const id = crypto.randomUUID();
  const title = (input.title || '').trim().slice(0, HISTORY_MAX_TITLE_LENGTH) || deriveHistoryTitle(input.content);
  const createdAt = new Date().toISOString();

  if (database.kind === 'd1') {
    const db = database.db as D1Database;
    await db.prepare('INSERT INTO app_generation_history(id, user_id, title, content, locale, word_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, input.userId, title, input.content, input.locale === 'en' ? 'en' : 'zh', Math.max(0, Math.floor(input.wordCount) || 0), createdAt).run();
    await db.prepare(`DELETE FROM app_generation_history WHERE user_id = ? AND id NOT IN (
      SELECT id FROM app_generation_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    )`).bind(input.userId, input.userId, HISTORY_MAX_PER_USER).run();
  } else {
    const db = database.db as mysql.Pool;
    await db.query('INSERT INTO app_generation_history(id, user_id, title, content, locale, word_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, input.userId, title, input.content, input.locale === 'en' ? 'en' : 'zh', Math.max(0, Math.floor(input.wordCount) || 0), createdAt]);
    await db.query(`DELETE FROM app_generation_history WHERE user_id = ? AND id NOT IN (
      SELECT id FROM (SELECT id FROM app_generation_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?) AS keep
    )`, [input.userId, input.userId, HISTORY_MAX_PER_USER]);
  }
  return id;
}

export async function listGenerationHistory(userId: string, page: number): Promise<{ items: GenerationHistoryItem[]; total: number; page: number; pageSize: number }> {
  const database = await getHistoryDatabase();
  const safePage = Math.max(1, Math.floor(page) || 1);
  const offset = (safePage - 1) * HISTORY_PAGE_SIZE;

  if (database.kind === 'd1') {
    const db = database.db as D1Database;
    const countRow = await db.prepare('SELECT COUNT(*) AS total FROM app_generation_history WHERE user_id = ?').bind(userId).first<{ total: number }>();
    const rows = await db.prepare(`SELECT id, title, substr(content, 1, 800) AS snippet, word_count AS wordCount, created_at AS createdAt
      FROM app_generation_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(userId, HISTORY_PAGE_SIZE, offset).all<GenerationHistoryItem>();
    return {
      items: (rows.results || []).map((row) => ({ ...row, snippet: deriveHistorySnippet(row.snippet), wordCount: Number(row.wordCount) || 0 })),
      total: Number(countRow?.total) || 0,
      page: safePage,
      pageSize: HISTORY_PAGE_SIZE,
    };
  }

  const db = database.db as mysql.Pool;
  const [countRows] = await db.query('SELECT COUNT(*) AS total FROM app_generation_history WHERE user_id = ?', [userId]) as [mysql.RowDataPacket[], unknown];
  const [rows] = await db.query(`SELECT id, title, LEFT(content, 800) AS snippet, word_count AS wordCount, created_at AS createdAt
    FROM app_generation_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [userId, HISTORY_PAGE_SIZE, offset]) as [mysql.RowDataPacket[], unknown];
  return {
    items: (rows as GenerationHistoryItem[]).map((row) => ({
      ...row,
      snippet: deriveHistorySnippet(String(row.snippet || '')),
      wordCount: Number(row.wordCount) || 0,
    })),
    total: Number((countRows[0] as { total: number } | undefined)?.total) || 0,
    page: safePage,
    pageSize: HISTORY_PAGE_SIZE,
  };
}

export async function getGenerationHistoryDetail(userId: string, id: string): Promise<GenerationHistoryDetail | null> {
  const database = await getHistoryDatabase();
  const sql = `SELECT id, title, content, locale, word_count AS wordCount, created_at AS createdAt,
    '' AS snippet FROM app_generation_history WHERE user_id = ? AND id = ? LIMIT 1`;
  if (database.kind === 'd1') {
    const row = await (database.db as D1Database).prepare(sql).bind(userId, id).first<GenerationHistoryDetail>();
    return row ? { ...row, wordCount: Number(row.wordCount) || 0 } : null;
  }
  const [rows] = await (database.db as mysql.Pool).query(sql, [userId, id]) as [mysql.RowDataPacket[], unknown];
  const row = rows[0] as GenerationHistoryDetail | undefined;
  return row ? { ...row, wordCount: Number(row.wordCount) || 0 } : null;
}

export async function deleteGenerationHistory(userId: string, id: string): Promise<boolean> {
  const database = await getHistoryDatabase();
  if (database.kind === 'd1') {
    const result = await (database.db as D1Database).prepare('DELETE FROM app_generation_history WHERE user_id = ? AND id = ?').bind(userId, id).run();
    return Number(result.meta.changes) > 0;
  }
  const [result] = await (database.db as mysql.Pool).query('DELETE FROM app_generation_history WHERE user_id = ? AND id = ?', [userId, id]) as [mysql.ResultSetHeader, unknown];
  return result.affectedRows > 0;
}
