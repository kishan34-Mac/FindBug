const mongoose = require('mongoose');

const IssueSchema = new mongoose.Schema({
  issue: { type: String, required: true },
  description: { type: String, required: true },
  severity: { 
    type: String, 
    required: true,
    enum: ['Critical', 'High', 'Medium', 'Low']
  }
}, { _id: false });

const AuditReportSchema = new mongoose.Schema({
  targetUrl: { type: String, required: true },
  projectName: { type: String, default: 'Automated Audit' },
  reviewDate: { type: Date, default: Date.now },
  frontendIssues: [IssueSchema],
  backendIssues: [IssueSchema],
  functionalBugs: [IssueSchema],
  responsivenessIssues: [IssueSchema],
  performanceIssues: [IssueSchema]
});

module.exports = mongoose.model('AuditReport', AuditReportSchema);
