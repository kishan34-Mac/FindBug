const logger = {
  info: (msg) => {
    console.log(`[${new Date().toISOString()}] [INFO] ${msg}`);
  },
  error: (msg, err) => {
    console.error(`[${new Date().toISOString()}] [ERROR] ${msg}`, err || '');
  },
  warn: (msg) => {
    console.warn(`[${new Date().toISOString()}] [WARN] ${msg}`);
  }
};

module.exports = logger;
