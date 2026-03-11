const https = require('https');
const http = require('http');
const logger = require('./logger');

// SMS API config (.env'den)
// SMS_PROVIDER=netgsm veya custom
// NETGSM_USERCODE=...
// NETGSM_PASSWORD=...
// NETGSM_MSGHEADER=...
// SMS_API_URL=... (custom provider için)

async function sendSMS(gsm, message) {
  const provider = process.env.SMS_PROVIDER || '';

  if (!provider) {
    // Simülasyon modu — gerçek gönderim yok
    await new Promise(r => setTimeout(r, 50));
    logger.info('SMS [SIM] → ' + gsm + ': ' + message.substring(0, 30) + '...');
    return { success: true, simulated: true };
  }

  if (provider === 'netgsm') {
    return sendNetGSM(gsm, message);
  }

  throw new Error('Bilinmeyen SMS_PROVIDER: ' + provider);
}

async function sendNetGSM(gsm, message) {
  const usercode = process.env.NETGSM_USERCODE;
  const password = process.env.NETGSM_PASSWORD;
  const msgheader = process.env.NETGSM_MSGHEADER || 'TAXIM';

  if (!usercode || !password) throw new Error('NETGSM_USERCODE / NETGSM_PASSWORD .env eksik');

  const clean = gsm.replace(/\D/g, '').replace(/^0/, '90');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mainbody>
  <header><usercode>${usercode}</usercode><password>${password}</password>
  <msgheader>${msgheader}</msgheader></header>
  <body><msg><no>1</no><tel>${clean}</tel><message>${escapeXml(message)}</message></msg></body>
</mainbody>`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.netgsm.com.tr', port: 443,
      path: '/sms/send/xml', method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const ok = data.startsWith('00') || data.startsWith('01') || data.startsWith('02');
        resolve({ success: ok, response: data });
      });
    });
    req.on('error', reject);
    req.write(xml);
    req.end();
  });
}

function escapeXml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { sendSMS };
