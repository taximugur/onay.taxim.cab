const { scrapeAllRecords } = require('./scraper');
const { sendBulkSMS } = require('./sms-sender');
const { getState, setState, getCount, queryRecords } = require('./db');
const logger = require('./logger');

class JobManager {
  constructor(eventBus) {
    this.bus = eventBus;
    this.currentJob = null;
    this._paused = false;
    this._stopped = false;
    this._page = null;
  }

  setPage(page) { this._page = page; }

  async checkPauseStop() {
    while (this._paused && !this._stopped) {
      await new Promise(r => setTimeout(r, 300));
    }
    if (this._stopped) {
      const err = new Error('JOB_STOPPED');
      err.code = 'JOB_STOPPED';
      throw err;
    }
  }

  pause() {
    if (!this.currentJob) return;
    this._paused = true;
    this.bus.emit('status', { module: this.currentJob, state: 'paused' });
    logger.info('Job duraklatıldı: ' + this.currentJob);
  }

  resume() {
    if (!this.currentJob) return;
    this._paused = false;
    this.bus.emit('status', { module: this.currentJob, state: 'running' });
    logger.info('Job devam ediyor: ' + this.currentJob);
  }

  stop() {
    this._stopped = true;
    this._paused = false;
    if (this.currentJob) {
      this.bus.emit('status', { module: this.currentJob, state: 'stopped' });
      logger.info('Job durduruldu: ' + this.currentJob);
    }
    this.currentJob = null;
  }

  isRunning() { return !!this.currentJob && !this._paused && !this._stopped; }

  // ─── Scraper ─────────────────────────────────────────────────────────────
  async startScraper(fresh = false) {
    if (this.currentJob) throw new Error('Zaten çalışıyor: ' + this.currentJob);
    if (!this._page) throw new Error('Browser sayfası hazır değil');

    this.currentJob = 'scraper';
    this._paused = false;
    this._stopped = false;

    const startTime = Date.now();
    this.bus.emit('status', { module: 'scraper', state: 'running', startTime });

    if (fresh) {
      setState({ lastPage: 0, totalPages: 0, status: 'idle' });
      logger.info('Sayfa sayacı sıfırlandı');
    }

    try {
      await scrapeAllRecords(this._page, async (progress) => {
        await this.checkPauseStop();
        const dbCount = getCount();
        this.bus.emit('scraper:page', {
          page: progress.page,
          totalPages: progress.totalPages,
          inserted: progress.inserted,
          pageSize: progress.pageSize,
          dbCount,
          percent: Math.round((progress.page / progress.totalPages) * 100),
          elapsed: Date.now() - startTime,
        });
      });

      const duration = Date.now() - startTime;
      const dbCount = getCount();
      this.bus.emit('scraper:done', { dbCount, duration });
      this.bus.emit('status', { module: 'scraper', state: 'done' });
      logger.info('Scraper tamamlandı: ' + dbCount + ' kayıt');
    } catch (e) {
      if (e.code === 'JOB_STOPPED') {
        this.bus.emit('status', { module: 'scraper', state: 'stopped' });
      } else {
        logger.error('Scraper hata: ' + e.message);
        this.bus.emit('scraper:error', { error: e.message });
        this.bus.emit('status', { module: 'scraper', state: 'error' });
      }
    } finally {
      this.currentJob = null;
    }
  }

  // ─── SMS ─────────────────────────────────────────────────────────────────
  async countSMS(filters) {
    const records = this._queryForSMS(filters);
    return records.length;
  }

  async startSMS(filters) {
    if (this.currentJob) throw new Error('Zaten çalışıyor: ' + this.currentJob);
    if (!this._page) throw new Error('Browser sayfası hazır değil');

    this.currentJob = 'sms';
    this._paused = false;
    this._stopped = false;

    const records = this._queryForSMS(filters);
    const totalCount = records.length;
    const startTime = Date.now();

    // referansNo Set — sendBulkSMS bunu kullanır
    const targetRefs = new Set(records.map(r => r.referansNo));

    this.bus.emit('status', { module: 'sms', state: 'running', startTime });
    this.bus.emit('sms:start', { totalCount, filters });
    logger.info('SMS gönderimi başladı: ' + totalCount + ' kayıt');

    try {
      const result = await sendBulkSMS(
        this._page,
        targetRefs,
        // onProgress callback — her SMS sonrası çağrılır
        (prog) => {
          const elapsed = Date.now() - startTime;
          const processed = prog.sent + prog.skipped + prog.failed;
          const rate = processed > 0 ? processed / (elapsed / 60000) : 0;
          const eta = rate > 0 ? Math.round((totalCount - processed) / rate) : 0;

          // Bus event
          this.bus.emit('sms:sent', {
            ref: prog.ref, status: prog.status,
            sent: prog.sent, skipped: prog.skipped, failed: prog.failed,
          });
          this.bus.emit('sms:progress', {
            processed, success: prog.sent, failed: prog.failed,
            skipped: prog.skipped, totalCount,
            percent: Math.round((processed / totalCount) * 100),
            rate: Math.round(rate), eta,
          });

          // pause/stop kontrolü — sendBulkSMS checkStop ile ayrıca kontrol ediyor
        },
        // checkStop callback
        () => this._stopped
      );

      const duration = Date.now() - startTime;
      this.bus.emit('sms:done', {
        processed: result.sent + result.skipped + result.failed,
        success: result.sent, failed: result.failed,
        skipped: result.skipped, duration,
      });
      this.bus.emit('status', { module: 'sms', state: 'done' });
      logger.info('SMS tamamlandı: gönderildi=' + result.sent + ' atlandı=' + result.skipped + ' hata=' + result.failed);

    } catch (e) {
      if (e.code === 'JOB_STOPPED') {
        this.bus.emit('sms:done', { stopped: true, duration: Date.now() - startTime });
        this.bus.emit('status', { module: 'sms', state: 'stopped' });
      } else {
        logger.error('SMS hata: ' + e.message);
        this.bus.emit('sms:error', { error: e.message });
        this.bus.emit('status', { module: 'sms', state: 'error' });
      }
    } finally {
      this.currentJob = null;
    }
  }

  _queryForSMS(filters = {}) {
    const { kayitStart, kayitEnd, sonStart, sonEnd, search } = filters;
    const { db } = require('./db');
    let sql = 'SELECT referansNo, isim, soyisim, gsm, plaka, kayitTarihi FROM records WHERE gsm IS NOT NULL AND gsm != ""';
    const params = [];
    if (kayitStart) { sql += ' AND kayitTarihi_iso >= ?'; params.push(kayitStart); }
    if (kayitEnd)   { sql += ' AND kayitTarihi_iso <= ?'; params.push(kayitEnd); }
    if (sonStart)   { sql += ' AND sonKullanimiIso >= ?'; params.push(sonStart); }
    if (sonEnd)     { sql += ' AND sonKullanimiIso <= ?'; params.push(sonEnd); }
    if (search) {
      sql += ' AND (isim LIKE ? OR soyisim LIKE ? OR plaka LIKE ? OR gsm LIKE ? OR referansNo LIKE ?)';
      const s = '%' + search + '%';
      params.push(s, s, s, s, s);
    }
    sql += ' ORDER BY kayitTarihi_iso ASC';
    return db.prepare(sql).all(...params);
  }
}

module.exports = JobManager;
