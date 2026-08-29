// Caller memory — looks up prior visits by phone number.
import db from './db.js';

export function recall(phone) {
  return db.prepare('SELECT * FROM callers WHERE phone = ?').get(phone) ?? null;
}

export function remember(phone, record) {
  db.prepare('INSERT OR REPLACE INTO callers (phone, data) VALUES (?, ?)')
    .run(phone, JSON.stringify(record));
}
