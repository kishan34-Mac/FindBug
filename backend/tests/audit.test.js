import { describe, it, expect, vi } from 'vitest';
const { validateAuditRequest } = require('../middleware/validation');

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

describe('Zod Validation Middleware', () => {
  it('should pass validation for a valid URL with https', () => {
    const req = { body: { url: 'https://example.com' } };
    const res = mockRes();
    const next = vi.fn();

    validateAuditRequest(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body.url).toBe('https://example.com');
  });

  it('should automatically prepend https protocol if missing and pass', () => {
    const req = { body: { url: 'example.com' } };
    const res = mockRes();
    const next = vi.fn();

    validateAuditRequest(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body.url).toBe('https://example.com');
  });

  it('should return 400 if URL is invalid', () => {
    const req = { body: { url: 'not-a-url' } };
    const res = mockRes();
    const next = vi.fn();

    validateAuditRequest(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Validation failed'
    }));
  });

  it('should return 400 if URL is missing', () => {
    const req = { body: {} };
    const res = mockRes();
    const next = vi.fn();

    validateAuditRequest(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('Fallback Report Generation Logic', () => {
  it('should generate issue lists from console errors and failed requests', () => {
    const consoleErrors = ['Uncaught TypeError: Cannot read property of null'];
    const failedRequests = ['404 https://example.com/api/nonexistent'];
    
    const reportData = {
      frontendIssues: [],
      backendIssues: [],
      functionalBugs: [],
      responsivenessIssues: [],
      performanceIssues: []
    };

    if (consoleErrors.length > 0) {
      consoleErrors.forEach((err) => {
        reportData.functionalBugs.push({
          issue: 'Console Error Detected',
          description: `A console error occurred in the browser: "${err}"`,
          severity: 'Medium'
        });
      });
    }

    if (failedRequests.length > 0) {
      failedRequests.forEach((req) => {
        reportData.backendIssues.push({
          issue: 'Failed Network Request',
          description: `Network request returned error status: "${req}"`,
          severity: 'High'
        });
      });
    }

    expect(reportData.functionalBugs).toHaveLength(1);
    expect(reportData.functionalBugs[0].issue).toBe('Console Error Detected');
    expect(reportData.backendIssues).toHaveLength(1);
    expect(reportData.backendIssues[0].severity).toBe('High');
  });
});

describe('Performance Timings Calculation', () => {
  it('should calculate timing metrics correctly from performance.timing', () => {
    const timing = {
      navigationStart: 1000,
      domainLookupStart: 1010,
      domainLookupEnd: 1020,
      connectStart: 1025,
      connectEnd: 1035,
      requestStart: 1040,
      responseStart: 1080,
      responseEnd: 1100,
      domLoading: 1120,
      domInteractive: 1200,
      domContentLoadedEventStart: 1220,
      domContentLoadedEventEnd: 1230,
      domComplete: 1300,
      loadEventStart: 1310,
      loadEventEnd: 1320
    };

    const performanceMetrics = {
      dnsLookupTime: Math.max(0, timing.domainLookupEnd - timing.domainLookupStart),
      tcpConnectTime: Math.max(0, timing.connectEnd - timing.connectStart),
      ttfb: Math.max(0, timing.responseStart - timing.requestStart),
      domContentLoaded: Math.max(0, timing.domContentLoadedEventEnd - timing.navigationStart),
      pageLoadTime: Math.max(0, timing.loadEventEnd - timing.navigationStart)
    };

    expect(performanceMetrics.dnsLookupTime).toBe(10);
    expect(performanceMetrics.tcpConnectTime).toBe(10);
    expect(performanceMetrics.ttfb).toBe(40);
    expect(performanceMetrics.domContentLoaded).toBe(230);
    expect(performanceMetrics.pageLoadTime).toBe(320);
  });
});
