const mongoose = require('mongoose');

const AuditJobSchema = new mongoose.Schema({
  targetUrl: { type: String, required: true },
  status: {
    type: String,
    enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT'],
    default: 'PENDING'
  },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  progress: { type: Number, default: 0 },
  error: { type: String },
  reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'AuditReport' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AuditJob', AuditJobSchema);
