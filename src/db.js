const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'extracard.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    referansNo      TEXT UNIQUE,
    isim            TEXT,
    soyisim         TEXT,
    kartNo          TEXT,
    gsm             TEXT,
    plaka           TEXT,
    gonderilenSms   TEXT,
    manuelSmsLimiti TEXT,
    kayitTarihi     TEXT,
    kayitTarihi_iso TEXT,
    sonKullanimTarihi TEXT,
    sonKullanimiIso TEXT,
    scrapedAt       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scrape_state (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    lastPage    INTEGER DEFAULT 0,
    totalPages  INTEGER DEFAULT 0,
    rowsPerPage INTEGER DEFAULT 30,
    totalRecords INTEGER DEFAULT 0,
    lastRun     TEXT,
    status      TEXT DEFAULT 'idle'
  );

  INSERT OR IGNORE INTO scrape_state (id) VALUES (1);

  CREATE INDEX IF NOT EXISTS idx_kayit_iso ON records(kayitTarihi_iso);
  CREATE INDEX IF NOT EXISTS idx_son_iso   ON records(sonKullanimiIso);
`);

// DD.MM.YYYY HH:MM:SS → YYYY-MM-DD
function toISO(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO records
    (referansNo, isim, soyisim, kartNo, gsm, plaka, gonderilenSms,
     manuelSmsLimiti, kayitTarihi, kayitTarihi_iso, sonKullanimTarihi, sonKullanimiIso)
  VALUES
    (@referansNo, @isim, @soyisim, @kartNo, @gsm, @plaka, @gonderilenSms,
     @manuelSmsLimiti, @kayitTarihi, @kayitTarihi_iso, @sonKullanimTarihi, @sonKullanimiIso)
`);

const bulkInsert = db.transaction((records) => {
  let inserted = 0;
  for (const r of records) {
    const info = insertStmt.run({
      ...r,
      kayitTarihi_iso: toISO(r.kayitTarihi),
      sonKullanimiIso: toISO(r.sonKullanimTarihi),
    });
    if (info.changes > 0) inserted++;
  }
  return inserted;
});

function getState() {
  return db.prepare('SELECT * FROM scrape_state WHERE id=1').get();
}

function setState(fields) {
  const keys = Object.keys(fields);
  const set = keys.map(k => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE scrape_state SET ${set} WHERE id=1`).run(fields);
}

function getCount() {
  return db.prepare('SELECT COUNT(*) as n FROM records').get().n;
}

function queryRecords({ dateFrom, dateTo, field } = {}) {
  let sql = 'SELECT referansNo, isim, soyisim, kartNo, gsm, plaka, gonderilenSms, manuelSmsLimiti, kayitTarihi, sonKullanimTarihi FROM records';
  const params = {};
  const conditions = [];

  if (dateFrom || dateTo) {
    const col = field === 'son' ? 'sonKullanimiIso' : 'kayitTarihi_iso';
    if (dateFrom) { conditions.push(`${col} >= @dateFrom`); params.dateFrom = dateFrom; }
    if (dateTo)   { conditions.push(`${col} <= @dateTo`);   params.dateTo = dateTo; }
  }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY kayitTarihi_iso ASC, referansNo ASC';

  return db.prepare(sql).all(params);
}

module.exports = { bulkInsert, getState, setState, getCount, queryRecords, db };
