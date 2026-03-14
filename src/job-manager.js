const { scrapeAllRecords } = require('./scraper');
const { sendBulkSMS, applyPortalFilters } = require('./sms-sender');
const { getState, setState, getCount, logSMS, updateAfterSMS } = require('./db');
const logger = require('./logger');

// ─── Incident Log ─────────────────────────────────────────────────────────────
// agency-agents/strategy/runbooks/scenario-incident-response.md pattern:
// Structured incident reporting: type + severity + context
function logIncident(type, severity, context) {
  // severity: 'P1' (job durdu) | 'P2' (erken çıkış) | 'P3' (uyarı)
  logger.warn('[INCIDENT:' + type + ':' + severity + '] ' + JSON.stringify(context));
}

class JobManager {
  constructor(eventBus) {
    this.bus = eventBus;
    this.currentJob = null;
    this._paused = false;
    this._stopped = false;
    this._page = null;
    this.lastSmsProgress = null; // Yeni bağlanan client'a son progress durumunu gönder
    this.smsStartTime = null;
    this._smsEventBuffer = []; // Disconnect sırasında kaçırılan sms:sent eventleri
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
    const job = this.currentJob;
    this.currentJob = null;
    if (job) {
      this.bus.emit('status', { module: job, state: 'stopped' });
      logger.info('Job durduruldu: ' + job);
    } else {
      // Aktif job yok ama UI stale state'te olabilir — her iki modülü sıfırla
      this.bus.emit('status', { module: 'scraper', state: 'stopped' });
      this.bus.emit('status', { module: 'sms', state: 'stopped' });
      logger.info('Stop çağrıldı (aktif job yoktu, UI sıfırlandı)');
    }
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
        logIncident('scraper_fatal', 'P1', { error: e.message, elapsed: Date.now() - startTime });
        this.bus.emit('scraper:error', { error: e.message });
        this.bus.emit('status', { module: 'scraper', state: 'error' });
      }
    } finally {
      this.currentJob = null;
    }
  }

  // ─── SMS: Portal'dan say ──────────────────────────────────────────────────
  async countSMS(filters) {
    if (this.currentJob) throw new Error('Zaten çalışıyor: ' + this.currentJob);
    if (!this._page) throw new Error('Browser sayfası hazır değil');

    logger.info('Portal filtre sayımı başladı...');
    const count = await applyPortalFilters(this._page, filters || {});
    this.bus.emit('sms:count', { count, source: 'portal' });
    return count;
  }

  // ─── SMS: Gönder ──────────────────────────────────────────────────────────
  async startSMS(filters) {
    if (this.currentJob) throw new Error('Zaten çalışıyor: ' + this.currentJob);
    if (!this._page) throw new Error('Browser sayfası hazır değil');

    this.currentJob = 'sms';
    this._paused = false;
    this._stopped = false;

    const startTime = Date.now();
    this.smsStartTime = startTime;
    this.lastSmsProgress = null;
    this.bus.emit('status', { module: 'sms', state: 'running', startTime });
    this.bus.emit('sms:start', { filters });
    logger.info('SMS gönderimi başladı');

    // Heartbeat: her 30sn'de "hâlâ çalışıyor" eventi — uzun sessizliklerde client'a kanıt
    const heartbeatInterval = setInterval(() => {
      if (!this.currentJob) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const p = this.lastSmsProgress;
      this.bus.emit('sms:heartbeat', {
        elapsed,
        processed: p ? p.processed : 0,
        totalCount: p ? p.totalCount : 0,
        percent:    p ? p.percent   : 0,
      });
    }, 30000);

    try {
      const result = await sendBulkSMS(
        this._page,
        filters || {},
        // onProgress
        (prog) => {
          const elapsed = Date.now() - startTime;
          const processed = prog.sent + prog.skipped + prog.failed;
          const rate = processed > 0 ? processed / (elapsed / 60000) : 0;
          const eta  = rate > 0 ? Math.round((prog.total - processed) / rate) : 0;

          // gonderilenSms artır, sonKullanimTarihi güncelle
          if (prog.status === 'ok') {
            try { updateAfterSMS(prog.ref, prog.sonKullanimTarihi); } catch(e) { logger.warn('updateAfterSMS: ' + e.message); }
          }

          // SMS log kaydı
          try {
            logSMS({
              referansNo:       prog.ref,
              durum:            prog.status,
              gonderilenSms:    prog.gonderilenSms,
              manuelLimit:      prog.manuelLimit,
              sonKullanimTarihi: prog.sonKullanimTarihi,
              hata:             prog.error || null,
            });
          } catch(e) { logger.warn('logSMS DB hatası: ' + e.message); }

          const sentEvent = {
            ref: prog.ref,
            status: prog.status,
            processed,
            totalCount: prog.total,
            gonderilenSms: prog.gonderilenSms,
            manuelLimit: prog.manuelLimit,
            sonKullanimTarihi: prog.sonKullanimTarihi,
            error: prog.error,
          };
          // Buffer'a ekle (son 200 event — reconnect'te replay için)
          this._smsEventBuffer.push(sentEvent);
          if (this._smsEventBuffer.length > 200) this._smsEventBuffer.shift();
          this.bus.emit('sms:sent', sentEvent);
          const progressData = {
            processed,
            success: prog.sent,
            failed: prog.failed,
            skipped: prog.skipped,
            totalCount: prog.total,
            percent: prog.total > 0 ? Math.round((processed / prog.total) * 100) : 0,
            rate: Math.round(rate),
            eta,
          };
          this.lastSmsProgress = progressData;
          this.bus.emit('sms:progress', progressData);
        },
        // checkPauseStop
        () => this.checkPauseStop()
      );

      const duration = Date.now() - startTime;
      this._smsEventBuffer = [];
      this.bus.emit('sms:done', {
        processed: result.sent + result.skipped + result.failed,
        success: result.sent,
        failed: result.failed,
        skipped: result.skipped,
        duration,
      });
      this.bus.emit('status', { module: 'sms', state: 'done' });
      logger.info('SMS tamamlandı: gönderildi=' + result.sent + ' atlandı=' + result.skipped + ' hata=' + result.failed);

    } catch (e) {
      if (e.code === 'JOB_STOPPED') {
        this.bus.emit('sms:done', { stopped: true, duration: Date.now() - startTime });
        this.bus.emit('status', { module: 'sms', state: 'stopped' });
      } else {
        logIncident('sms_fatal', 'P1', { error: e.message, filters, elapsed: Date.now() - startTime });
        this.bus.emit('sms:error', { error: e.message });
        this.bus.emit('status', { module: 'sms', state: 'error' });
      }
    } finally {
      clearInterval(heartbeatInterval);
      this.currentJob = null;
    }
  }
}

module.exports = JobManager;
