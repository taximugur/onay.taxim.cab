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

  CREATE TABLE IF NOT EXISTS sms_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    referansNo      TEXT NOT NULL,
    tarih           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    durum           TEXT NOT NULL,
    gonderilenSms   INTEGER,
    manuelLimit     INTEGER,
    sonKullanimTarihi TEXT,
    hata            TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sms_log_ref   ON sms_log(referansNo);
  CREATE INDEX IF NOT EXISTS idx_sms_log_tarih ON sms_log(tarih);
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

const logSMSStmt = db.prepare(`
  INSERT INTO sms_log (referansNo, durum, gonderilenSms, manuelLimit, sonKullanimTarihi, hata)
  VALUES (@referansNo, @durum, @gonderilenSms, @manuelLimit, @sonKullanimTarihi, @hata)
`);

// SMS gönderildikten sonra gonderilenSms'i artır, sonKullanimTarihi'ni güncelle
const updateSMSCountStmt = db.prepare(`
  UPDATE records
  SET gonderilenSms = CAST(COALESCE(gonderilenSms, '0') AS INTEGER) + 1,
      sonKullanimTarihi = COALESCE(@sonKullanimTarihi, sonKullanimTarihi),
      sonKullanimiIso   = COALESCE(@sonKullanimiIso,   sonKullanimiIso)
  WHERE referansNo = @referansNo
`);

function updateAfterSMS(referansNo, sonKullanimTarihi) {
  updateSMSCountStmt.run({
    referansNo,
    sonKullanimTarihi: sonKullanimTarihi || null,
    sonKullanimiIso:   sonKullanimTarihi ? toISO(sonKullanimTarihi) : null,
  });
}

// Bu sistemle daha önce (herhangi bir günde) başarıyla SMS gönderilmiş TÜM ref'leri döner (Set)
// Bir kez SMS gönderildi mi, bir daha gönderilmez
function getTodayBlockedRefs() {
  const rows = db.prepare(`
    SELECT DISTINCT referansNo
    FROM sms_log
    WHERE durum = 'ok'
  `).all();
  return new Set(rows.map(r => r.referansNo));
}

function logSMS({ referansNo, durum, gonderilenSms, manuelLimit, sonKullanimTarihi, hata }) {
  logSMSStmt.run({
    referansNo,
    durum,
    gonderilenSms: gonderilenSms || null,
    manuelLimit:   manuelLimit   || null,
    sonKullanimTarihi: sonKullanimTarihi || null,
    hata:          hata          || null,
  });
}

// Tarih aralığına göre referansNo Set'i döner (backend filtre için)
function getRefsByDateRange(startISO, endISO) {
  const rows = db.prepare(
    'SELECT referansNo FROM records WHERE kayitTarihi_iso >= ? AND kayitTarihi_iso <= ?'
  ).all(startISO, endISO);
  return new Set(rows.map(r => r.referansNo));
}

// Tarih aralığındaki kayıt sayısını döner
function countByDateRange(startISO, endISO) {
  return db.prepare(
    'SELECT COUNT(*) as n FROM records WHERE kayitTarihi_iso >= ? AND kayitTarihi_iso <= ?'
  ).get(startISO, endISO).n;
}

module.exports = { bulkInsert, getState, setState, getCount, queryRecords, logSMS, updateAfterSMS, getTodayBlockedRefs, getRefsByDateRange, countByDateRange, db };
