const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { getState, getCount, queryRecords } = require('../db');
const ExcelJS = require('exceljs');

function startDashboard(jobManager, eventBus, port) {
  port = port || parseInt(process.env.DASHBOARD_PORT) || 3333;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());

  // Event bus → Socket.io
  const fwd = (event) => eventBus.on(event, (data) => io.emit(event, data));
  ['scraper:page','scraper:done','scraper:error','sms:start','sms:progress','sms:sent','sms:done','sms:error','status'].forEach(fwd);

  // REST: state
  app.get('/api/state', (req, res) => {
    const s = getState();
    res.json({ ...s, dbCount: getCount(), currentJob: jobManager.currentJob, paused: jobManager._paused });
  });

  // REST: SMS count
  app.post('/api/sms/count', (req, res) => {
    try {
      const count = jobManager._queryForSMS(req.body).length;
      res.json({ count });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // REST: Excel indir
  app.get('/api/excel', async (req, res) => {
    try {
      const { from, to, field } = req.query;
      const records = queryRecords({ dateFrom: from, dateTo: to, field });
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet('Kayıtlar');
      sheet.columns = [
        {header:'Referans No',key:'referansNo',width:15},
        {header:'İsim',key:'isim',width:15},{header:'Soyisim',key:'soyisim',width:15},
        {header:'Kart No',key:'kartNo',width:22},{header:'GSM',key:'gsm',width:15},
        {header:'Plaka',key:'plaka',width:12},{header:'Gönderilen SMS',key:'gonderilenSms',width:15},
        {header:'Manuel Limit',key:'manuelSmsLimiti',width:15},
        {header:'Kayıt Tarihi',key:'kayitTarihi',width:20},
        {header:'Son Kullanım',key:'sonKullanimTarihi',width:20},
      ];
      const hdr = sheet.getRow(1);
      hdr.font = {bold:true};
      hdr.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFCC00'}};
      records.forEach((r,i) => {
        const row = sheet.addRow(r);
        if (i%2===1) row.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFF5F5F5'}};
      });
      sheet.autoFilter = {from:'A1',to:`J${records.length+1}`};
      sheet.views = [{state:'frozen',ySplit:1}];
      const ts = new Date().toISOString().slice(0,10);
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="extracard_${ts}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch(e) { res.status(500).send(e.message); }
  });

  // Socket.io commands
  io.on('connection', (socket) => {
    // İlk bağlantıda state gönder
    const s = getState();
    socket.emit('init', { ...s, dbCount: getCount(), currentJob: jobManager.currentJob, paused: jobManager._paused });

    socket.on('scraper:start', (opts) => {
      jobManager.startScraper(opts && opts.fresh).catch(e => socket.emit('error', e.message));
    });
    socket.on('scraper:pause',  () => jobManager.pause());
    socket.on('scraper:resume', () => jobManager.resume());
    socket.on('scraper:stop',   () => jobManager.stop());

    socket.on('sms:count', (filters, cb) => {
      try { cb({ count: jobManager._queryForSMS(filters).length }); } catch(e) { cb({ error: e.message }); }
    });
    socket.on('sms:start', (filters) => {
      jobManager.startSMS(filters).catch(e => socket.emit('error', e.message));
    });
    socket.on('sms:pause',  () => jobManager.pause());
    socket.on('sms:resume', () => jobManager.resume());
    socket.on('sms:stop',   () => jobManager.stop());
  });

  server.listen(port, () => {
    console.log('Dashboard: http://localhost:' + port);
  });

  return server;
}

module.exports = { startDashboard };
