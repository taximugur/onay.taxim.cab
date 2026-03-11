const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = path.join(logsDir, `scrape-${timestamp}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function formatMsg(level, ...args) {
  const time = new Date().toLocaleTimeString('tr-TR');
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  return `[${time}] [${level}] ${msg}`;
}

const logger = {
  info(...args) {
    const msg = formatMsg('INFO', ...args);
    console.log(chalk.cyan(msg));
    logStream.write(msg + '\n');
  },
  warn(...args) {
    const msg = formatMsg('WARN', ...args);
    console.log(chalk.yellow(msg));
    logStream.write(msg + '\n');
  },
  error(...args) {
    const msg = formatMsg('ERROR', ...args);
    console.log(chalk.red(msg));
    logStream.write(msg + '\n');
  },
  success(...args) {
    const msg = formatMsg('OK', ...args);
    console.log(chalk.green(msg));
    logStream.write(msg + '\n');
  },
};

module.exports = logger;
