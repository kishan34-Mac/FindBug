const crypto = require('crypto');

const requestTracing = (req, res, next) => {
  const reqId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
  req.id = reqId;
  res.setHeader('X-Request-ID', reqId);

  const startTime = process.hrtime();

  console.log(`[${new Date().toISOString()}] [INFO] [Req:${reqId}] ${req.method} ${req.originalUrl}`);

  res.on('finish', () => {
    const duration = process.hrtime(startTime);
    const durationMs = (duration[0] * 1e3 + duration[1] * 1e-6).toFixed(2);
    console.log(`[${new Date().toISOString()}] [INFO] [Req:${reqId}] Finished - Status: ${res.statusCode} - Duration: ${durationMs}ms`);
  });

  next();
};

module.exports = requestTracing;
