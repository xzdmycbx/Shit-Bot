import { Database } from 'bun:sqlite';
import * as path from 'path';
import * as fs from 'fs';

function resolveDataDir(): string {
  const cwd = path.join(process.cwd(), 'data');
  if (fs.existsSync(cwd)) return cwd;
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, 'bot.db');

let db: Database | null = null;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function initDatabase(): void {
  ensureDataDir();

  db = new Database(DB_PATH);

  db.run('PRAGMA journal_mode = WAL');

  db.run(`
    CREATE TABLE IF NOT EXISTS sent_tweets (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      content TEXT,
      url TEXT,
      sent_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS image_cache (
      tweet_id TEXT PRIMARY KEY,
      image_data BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_sent_tweets_author ON sent_tweets(author)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sent_tweets_sent_at ON sent_tweets(sent_at)');

  console.log(`Database initialized: ${DB_PATH}`);
}

export function getDatabase(): Database {
  if (!db) {
    initDatabase();
  }
  return db!;
}

export function markAsSent(tweetId: string, author?: string, content?: string, url?: string): void {
  const database = getDatabase();
  database.run(
    `INSERT OR IGNORE INTO sent_tweets (id, author, content, url, sent_at) VALUES (?, ?, ?, ?, ?)`,
    [tweetId, author || '', content || '', url || '', Date.now()]
  );
}

export function isAlreadySent(tweetId: string): boolean {
  const database = getDatabase();
  const row = database.query('SELECT 1 FROM sent_tweets WHERE id = ?').get(tweetId);
  return !!row;
}

export function markMultipleAsSent(tweets: Array<{ id: string; author: string; content: string; url: string }>): void {
  const database = getDatabase();

  const insert = database.transaction((items: typeof tweets) => {
    for (const tweet of items) {
      database.run(
        `INSERT OR IGNORE INTO sent_tweets (id, author, content, url, sent_at) VALUES (?, ?, ?, ?, ?)`,
        [tweet.id, tweet.author, tweet.content, tweet.url, Date.now()]
      );
    }
  });

  insert(tweets);
}

export function isTooOld(publishedAt: Date, maxAgeMinutes: number): boolean {
  const now = Date.now();
  const tweetTime = publishedAt.getTime();
  const ageMinutes = (now - tweetTime) / (1000 * 60);
  return ageMinutes > maxAgeMinutes;
}

export function cleanupOldRecords(maxAgeDays: number = 30): number {
  const database = getDatabase();
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const result = database.run('DELETE FROM sent_tweets WHERE sent_at < ?', [cutoff]);

  if (result.changes > 0) {
    console.log(`Cleaned up ${result.changes} old records`);
  }

  return result.changes;
}

export function getSentCount(): number {
  const database = getDatabase();
  const row = database.query('SELECT COUNT(*) as count FROM sent_tweets').get() as { count: number };
  return row.count;
}

export function getRecentTweets(limit: number = 10): Array<{
  id: string;
  author: string;
  content: string;
  url: string;
  sent_at: number;
}> {
  const database = getDatabase();
  return database.query('SELECT * FROM sent_tweets ORDER BY sent_at DESC LIMIT ?').all(limit) as any[];
}

export function cacheImage(tweetId: string, imageBuffer: Buffer): void {
  const database = getDatabase();
  database.run(
    `INSERT OR REPLACE INTO image_cache (tweet_id, image_data, created_at) VALUES (?, ?, ?)`,
    [tweetId, imageBuffer, Date.now()]
  );
}

export function getCachedImage(tweetId: string): Buffer | null {
  const database = getDatabase();
  const row = database.query('SELECT image_data FROM image_cache WHERE tweet_id = ?').get(tweetId) as { image_data: Buffer } | undefined;
  return row ? row.image_data : null;
}

export function cleanupExpiredImages(maxAgeMinutes: number = 60): number {
  const database = getDatabase();
  const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
  const result = database.run('DELETE FROM image_cache WHERE created_at < ?', [cutoff]);

  if (result.changes > 0) {
    console.log(`Cleaned up ${result.changes} expired cached images`);
  }

  return result.changes;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('Database closed');
  }
}
