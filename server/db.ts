import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
// Money is kept in minor units (kuruş for TRY) as integers, so sums never round.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- A campaign. utm is its utm_campaign, made by the file's naming rules and unique, so every channel reports under
   -- one name. start_day and end_day are days in the file's time zone.
   CREATE TABLE campaigns (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     utm TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL CHECK (status IN ('planned', 'live', 'ended', 'cancelled')),
     start_day TEXT NOT NULL,
     end_day TEXT NOT NULL,
     brief TEXT,
     -- The one thing it says, and who it says it to.
     message TEXT,
     audience TEXT,
     owner_id TEXT,
     owner_name TEXT,
     budget_minor INTEGER NOT NULL DEFAULT 0,
     -- The ad platforms' campaign names or ids whose spend is this campaign's, beyond those that carry utm.
     ad_names TEXT NOT NULL DEFAULT '[]',
     -- The Messages campaigns (by id) whose sends count here, beyond those whose slug is utm.
     messages_ids TEXT NOT NULL DEFAULT '[]',
     launched_at TEXT,
     ended_at TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX campaigns_days ON campaigns (start_day, end_day);
   -- The channels a campaign runs on, each with its planned budget.
   CREATE TABLE campaign_channels (
     campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
     channel TEXT NOT NULL,
     budget_minor INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (campaign_id, channel)
   );
   -- What the campaign aims for: visits, a goal of Analytics, clicks, opens, won deals or revenue.
   CREATE TABLE goals (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
     metric TEXT NOT NULL,
     goal TEXT,
     target REAL NOT NULL,
     pos INTEGER NOT NULL
   );
   CREATE INDEX goals_campaign ON goals (campaign_id, pos);
   -- The members a campaign names as approvers, and what each decided. An approval is of the campaign as it was:
   -- a change to its dates, brief, budget or channels sets every decision back to waiting.
   CREATE TABLE approvals (
     campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
     email TEXT NOT NULL,
     name TEXT,
     state TEXT NOT NULL CHECK (state IN ('waiting', 'approved', 'changes')),
     note TEXT,
     decided_at TEXT,
     PRIMARY KEY (campaign_id, email)
   );
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     channel TEXT,
     owner_id TEXT,
     owner_name TEXT,
     due_day TEXT,
     done_at TEXT,
     done_by TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX tasks_campaign ON tasks (campaign_id);
   CREATE INDEX tasks_owner ON tasks (owner_id, done_at, due_day);
   -- Work a campaign uses: a design, a landing page, a file in Files. Kept as a name and an address.
   CREATE TABLE assets (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     url TEXT NOT NULL,
     channel TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE INDEX assets_campaign ON assets (campaign_id);
   -- A tagged link. url is the destination with the five utm_ parameters; the same url is made once.
   CREATE TABLE links (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
     channel TEXT NOT NULL,
     destination TEXT NOT NULL,
     source TEXT NOT NULL,
     medium TEXT NOT NULL,
     content TEXT,
     term TEXT,
     url TEXT NOT NULL UNIQUE,
     label TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE INDEX links_campaign ON links (campaign_id);
   -- Money spent, a day and a channel at a time. key makes an import idempotent: the same platform, ad campaign and
   -- day, or the same CSV campaign, channel and day, replaces what was there. campaign_id is null for spend an ad
   -- platform reported that no campaign claims yet.
   CREATE TABLE spend (
     id TEXT PRIMARY KEY,
     campaign_id TEXT REFERENCES campaigns (id) ON DELETE CASCADE,
     channel TEXT,
     day TEXT NOT NULL,
     amount_minor INTEGER NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('manual', 'csv', 'google', 'meta')),
     ad_campaign TEXT,
     ad_campaign_id TEXT,
     clicks INTEGER,
     impressions INTEGER,
     note TEXT,
     key TEXT UNIQUE,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE INDEX spend_campaign ON spend (campaign_id, day);
   CREATE INDEX spend_unmatched ON spend (source, day) WHERE campaign_id IS NULL;
   -- The last results read for a campaign from Analytics and Messages, as JSON, and when.
   CREATE TABLE results (
     campaign_id TEXT PRIMARY KEY REFERENCES campaigns (id) ON DELETE CASCADE,
     data TEXT NOT NULL,
     read_at TEXT NOT NULL,
     frozen INTEGER NOT NULL DEFAULT 0
   );
   -- Won deals from CRM, with what touched them before they were won. stamp is what the deal was when its touches were
   -- read (value, close, source), so a change reads them again. The email is kept only to find the deal's touches, and goes when
   -- Audience asks for the person to be deleted.
   CREATE TABLE deals (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     value_minor INTEGER NOT NULL,
     currency TEXT NOT NULL,
     won_at TEXT NOT NULL,
     company TEXT,
     email TEXT,
     url TEXT,
     stamp TEXT NOT NULL,
     -- The deal's touches, oldest first: [{ at, utm, medium, via }]. Which campaign each names is worked out when the
     -- results are read, so a campaign made later still counts the touches its utm_campaign was in.
     touches TEXT NOT NULL DEFAULT '[]',
     read_at TEXT NOT NULL
   );
   CREATE INDEX deals_won ON deals (won_at);
   -- What happened to a campaign: made, changed, approved, launched, ended.
   CREATE TABLE activity (
     id INTEGER PRIMARY KEY,
     campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     by_name TEXT NOT NULL,
     text TEXT NOT NULL
   );
   CREATE INDEX activity_campaign ON activity (campaign_id, at);
   -- Deletions Audience asked for, by their reference: kept so asking again gives the same answer.
   CREATE TABLE erasures (reference TEXT PRIMARY KEY, at TEXT NOT NULL, deleted INTEGER NOT NULL);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
