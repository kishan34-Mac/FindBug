require('dotenv').config();
const { execSync } = require('child_process');

// Ensure Playwright browsers are installed before starting the server
// This fixes the 'Executable doesn't exist' error on Render
try {
  console.log('Installing Playwright Chromium browser...');
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log('Playwright Chromium installed successfully.');
} catch (error) {
  console.error('Failed to install Playwright browser:', error);
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const auditRoutes = require('./routes/audit');

const app = express();
const PORT = process.env.PORT || 5000;

const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/$/, '') : '*';
const corsOptions = {
  origin: frontendUrl,
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
