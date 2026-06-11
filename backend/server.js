require('dotenv').config();
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
