import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Row = Record<string, SQLInputValue>;

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  create table channels(
    id text primary key,
    channel_id text not null unique,
    title text,
    handle text,
    thumbnail_url text,
    google_email text,
    uploads_playlist_id text,
    scopes text,
    status text not null default 'ok',
    status_detail text,
    is_default integer not null default 0,
    connected_at integer not null,
    refreshed_at integer
  );
  create table jobs(
    id text primary key,
    channel_row_id text not null,
    status text not null,
    source_kind text not null,
    source_ref text not null,
    file_path text,
    file_size integer,
    file_mtime integer,
    content_type text,
    metadata text not null,
    post_steps text not null,
    session_uri text,
    bytes_sent integer not null default 0,
    upload_charged integer not null default 0,
    video_id text,
    error text,
    error_code text,
    attempts integer not null default 0,
    lease_owner text,
    lease_until integer,
    result text,
    created_at integer not null,
    updated_at integer not null,
    finished_at integer
  );
  create index jobs_status on jobs(status, created_at);
  create table quota(day text primary key, units integer not null default 0, uploads integer not null default 0,
                     exhausted_kind text, exhausted_at integer);
  create table confirmations(
    token text primary key,
    action text not null,
    payload_hash text not null,
    summary text not null,
    created_at integer not null,
    expires_at integer not null
  );
  create table settings(key text primary key, value text not null);
  create table audit(
    id integer primary key autoincrement,
    at integer not null,
    action text not null,
    channel_id text,
    video_id text,
    detail text
  );
  `,
];

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(
      "pragma journal_mode = wal; pragma busy_timeout = 8000; pragma foreign_keys = on;",
    );
    this.migrate();
  }

  private migrate() {
    this.raw.exec("create table if not exists schema_version(version integer not null)");
    const row = this.raw.prepare("select version from schema_version").get() as
      { version: number } | undefined;
    let v = row?.version ?? 0;
    if (!row) this.raw.prepare("insert into schema_version(version) values (0)").run();
    for (; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.prepare("update schema_version set version = ?").run(v + 1);
      });
    }
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("begin immediate");
    try {
      const out = fn();
      this.raw.exec("commit");
      return out;
    } catch (e) {
      this.raw.exec("rollback");
      throw e;
    }
  }

  setting(key: string): string | undefined {
    return this.get<{ value: string }>("select value from settings where key = ?", key)?.value;
  }

  setSetting(key: string, value: string) {
    this.run(
      "insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
      key,
      value,
    );
  }

  audit(
    action: string,
    detail: Record<string, unknown> = {},
    channelId?: string,
    videoId?: string,
  ) {
    this.run(
      "insert into audit(at, action, channel_id, video_id, detail) values (?, ?, ?, ?, ?)",
      Date.now(),
      action,
      channelId ?? null,
      videoId ?? null,
      JSON.stringify(detail),
    );
  }

  close() {
    this.raw.close();
  }
}

export const now = () => Date.now();
