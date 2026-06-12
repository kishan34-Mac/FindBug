require('dotenv').config();

// Force Playwright to use the local node_modules directory for browsers.
// This ensures it finds the browser installed during the build phase,
// even if the Render start command doesn't explicitly set the environment variable.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const { execSync } = require('child_process');

// Ensure Playwright browsers are installed before starting the server in production
// This fixes the 'Executable doesn't exist' error on Render
if (process.env.RENDER === 'true' || process.env.NODE_ENV === 'production') {
  try {
    console.log('Installing Playwright Chromium browser...');
    execSync('npx playwright install chromium', { stdio: 'inherit' });
    console.log('Playwright Chromium installed successfully.');
  } catch (error) {
    console.error('Failed to install Playwright browser:', error);
  }
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const requestTracing = require('./middleware/tracing');
const { resumeJobs, cleanupStuckJobs } = require('./utils/queue');
const auditRoutes = require('./routes/audit');

const app = express();
const PORT = process.env.PORT || 5000;

// Request tracing middleware (registers unique IDs and logs requests)
app.use(requestTracing);

// CORS configuration supporting production and local development
const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/$/, '') : '*';
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || frontendUrl === '*' || frontendUrl === origin || origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:3000') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
};
app.use(cors(corsOptions));
app.use(express.json());

// Rate limiting middleware
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' }
});

// Health check endpoint
app.get('/api/audit/health', (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  res.status(isDbConnected ? 200 : 503).json({
    status: isDbConnected ? 'UP' : 'DOWN',
    database: isDbConnected ? 'CONNECTED' : 'DISCONNECTED',
    timestamp: new Date()
  });
});

// Register routes
app.use('/api/audit', apiLimiter, auditRoutes);

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  const reqId = req.id || 'N/A';
  console.error(`[${new Date().toISOString()}] [ERROR] [Req:${reqId}] Global error:`, err);
  
  res.status(err.status || 500).json({
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred on the server.',
    requestId: reqId
  });
});

// Connect to Database and start server
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    
    // Resume any interrupted queue jobs
    resumeJobs().then(() => {
      console.log('Queue jobs initialization complete.');
    }).catch(err => {
      console.error('Failed to initialize queue resumption:', err);
    });

    // Start background cleaner task checking every 2 minutes
    setInterval(() => {
      cleanupStuckJobs().catch(err => console.error('Background stuck jobs cleanup failed:', err));
    }, 2 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Error connecting to MongoDB:', err);
  });

module.exports = app;
