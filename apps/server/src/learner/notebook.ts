import type {
  HighlightCreate,
  LessonBookmark,
  LessonHighlight,
  LessonNote,
  Notebook,
} from '@compilerlab/shared';
import type { SqlDatabase } from '../db/driver';
import { logActivity, sqlTimeToIso } from './activity';

interface NoteRow {
  topic_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

interface HighlightRow {
  id: number;
  topic_id: string;
  quote: string;
  prefix: string;
  suffix: string;
  created_at: string;
}

function toNote(row: NoteRow): LessonNote {
  return {
    topicId: row.topic_id,
    body: row.body,
    createdAt: sqlTimeToIso(row.created_at),
    updatedAt: sqlTimeToIso(row.updated_at),
  };
}

function toHighlight(row: HighlightRow): LessonHighlight {
  return {
    id: row.id,
    topicId: row.topic_id,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    createdAt: sqlTimeToIso(row.created_at),
  };
}

export function readNotes(db: SqlDatabase): LessonNote[] {
  const rows = db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all() as NoteRow[];
  return rows.map(toNote);
}

export function readNotebook(db: SqlDatabase): Notebook {
  const bookmarks = db
    .prepare('SELECT topic_id, created_at FROM bookmarks ORDER BY created_at DESC')
    .all() as { topic_id: string; created_at: string }[];
  const highlights = db
    .prepare('SELECT * FROM highlights ORDER BY created_at DESC, id DESC')
    .all() as HighlightRow[];
  return {
    notes: readNotes(db),
    bookmarks: bookmarks.map((row): LessonBookmark => ({
      topicId: row.topic_id,
      createdAt: sqlTimeToIso(row.created_at),
    })),
    highlights: highlights.map(toHighlight),
  };
}

/** An empty note is no note, so saving nothing deletes it and it leaves the list. */
export function saveNote(db: SqlDatabase, topicId: string, body: string): LessonNote | null {
  if (body.trim() === '') {
    deleteNote(db, topicId);
    return null;
  }
  const existed = db.prepare('SELECT 1 FROM notes WHERE topic_id = ?').get(topicId) !== undefined;
  db.prepare(
    `INSERT INTO notes (topic_id, body) VALUES (?, ?)
     ON CONFLICT (topic_id) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`,
  ).run(topicId, body);
  // Notes autosave on every pause, so only starting a note counts as something that happened.
  if (!existed) logActivity(db, 'note-saved', topicId);
  return toNote(db.prepare('SELECT * FROM notes WHERE topic_id = ?').get(topicId) as NoteRow);
}

export function deleteNote(db: SqlDatabase, topicId: string): void {
  db.prepare('DELETE FROM notes WHERE topic_id = ?').run(topicId);
}

export function addBookmark(db: SqlDatabase, topicId: string): void {
  const added = db.prepare('SELECT 1 FROM bookmarks WHERE topic_id = ?').get(topicId) === undefined;
  if (!added) return;
  db.prepare('INSERT INTO bookmarks (topic_id) VALUES (?)').run(topicId);
  logActivity(db, 'bookmark-added', topicId);
}

export function deleteBookmark(db: SqlDatabase, topicId: string): void {
  db.prepare('DELETE FROM bookmarks WHERE topic_id = ?').run(topicId);
}

export function addHighlight(db: SqlDatabase, highlight: HighlightCreate): LessonHighlight {
  const { topicId, quote, prefix, suffix } = highlight;
  const row = db
    .prepare(
      'INSERT INTO highlights (topic_id, quote, prefix, suffix) VALUES (?, ?, ?, ?) RETURNING *',
    )
    .get(topicId, quote, prefix, suffix) as HighlightRow;
  logActivity(db, 'highlight-added', topicId);
  return toHighlight(row);
}

/** Returns false if there was no such highlight. */
export function deleteHighlight(db: SqlDatabase, id: number): boolean {
  const existed = db.prepare('SELECT 1 FROM highlights WHERE id = ?').get(id) !== undefined;
  db.prepare('DELETE FROM highlights WHERE id = ?').run(id);
  return existed;
}
