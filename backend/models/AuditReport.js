const mongoose = require('mongoose');

const IssueSchema = new mongoose.Schema({
  issue: { type: String, required: true },
  description: { type: String, required: true },
  severity: { 
    type: String, 
    required: true,
    enum: ['Critical', 'High', 'Medium', 'Low']
  },
  exactPageUrl: { type: String, required: true },
  evidence: { type: String, required: true },
  screenshot: { type: String, default: "" },
  networkLog: { type: String, default: "" },
  domSelector: { type: String, default: "" },
  consoleError: { type: String, default: "" },
  apiResponse: { type: String, default: "" },
  detectedAt: { type: Date, default: Date.now },
  reproducible: { type: String, required: true },
  confidence: { type: Number, required: true },
  reproductionSteps: { type: String, required: true },
  recommendedFix: { type: String, required: true },
  observationOnly: { type: Boolean, default: false }
}, { _id: false });

const AuditReportSchema = new mongoose.Schema({
  targetUrl: { type: String, required: true },
  projectName: { type: String, default: 'Automated Audit' },
  reviewDate: { type: Date, default: Date.now },
  frontendIssues: [IssueSchema],
  backendIssues: [IssueSchema],
  functionalBugs: [IssueSchema],
  responsivenessIssues: [IssueSchema],
  performanceIssues: [IssueSchema],
  seoIssues: [IssueSchema],
  accessibilityIssues: [IssueSchema],
  screenshot: { type: String },
  performanceMetrics: {
    dnsLookupTime: { type: Number, default: 0 },
    tcpConnectTime: { type: Number, default: 0 },
    ttfb: { type: Number, default: 0 },
    domContentLoaded: { type: Number, default: 0 },
    pageLoadTime: { type: Number, default: 0 }
  }
});

module.exports = mongoose.model('AuditReport', AuditReportSchema);
