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
const auditRoutes = require('./routes/audit');

const app = express();
const PORT = process.env.PORT || 5000;

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

app.use('/api/audit', auditRoutes);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Error connecting to MongoDB:', err);
  });

module.exports = app;
