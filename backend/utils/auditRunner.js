const { chromium } = require('playwright');
const { GoogleGenAI } = require('@google/genai');
const AuditReport = require('../models/AuditReport');
const logger = require('./logger');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function withTimeout(promise, ms, defaultValue = null) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Timeout"));
    }, ms);
  });
  return Promise.race([
    promise.then((res) => {
      clearTimeout(timeoutId);
      return res;
    }),
    timeoutPromise
  ]).catch((err) => {
    if (err.message === "Timeout") {
      if (defaultValue !== null) {
        console.warn(`Promise timed out after ${ms}ms. Returning fallback.`);
        return defaultValue;
      }
      throw err;
    }
    throw err;
  });
}

async function safeEvaluate(page, fn, maxAttempts = 3) {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      return await withTimeout(page.evaluate(fn), 5000);
    } catch (error) {
      attempts++;
      if (error.message.includes('Execution context was destroyed') && attempts < maxAttempts) {
        console.log(`Execution context destroyed, retrying evaluation (attempt ${attempts})...`);
        await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000).catch(() => {});
        continue;
      }
      throw error;
    }
  }
}

async function executeAudit(url, progressCallback) {
  let browser;
  try {
    progressCallback(10);
    
    process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const failedRequests = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) {
        failedRequests.push(`${status} ${response.url()}`);
      }
    });

    // Navigation Step
    console.log(`Navigating to: ${url}`);
    await withTimeout(
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
      35000
    );
    
    // Capped NetworkIdle Wait
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      console.log('Timeout waiting for networkidle, continuing with DOM content');
    });

    progressCallback(20);

    // --- STEP: Screenshot ---
    logger.info("STEP START: Screenshot");
    let screenshotBase64 = null;
    try {
      const screenshotBuffer = await withTimeout(
        page.screenshot({ type: 'jpeg', quality: 60 }),
        15000,
        null
      );
      if (screenshotBuffer) {
        screenshotBase64 = screenshotBuffer.toString('base64');
      }
      logger.info("STEP COMPLETE: Screenshot");
    } catch (e) {
      logger.error("STEP FAILED: Screenshot", e);
    }

    progressCallback(40);

    // --- STEP: Network ---
    logger.info("STEP START: Network");
    const title = await withTimeout(page.title(), 5000, 'No Title');
    const bodyText = await withTimeout(
      page.locator('body').innerText().then(txt => txt.substring(0, 5000)),
      10000,
      ''
    );
    const scrapedData = {
      title,
      bodyText,
      consoleErrors,
      failedRequests,
    };
    logger.info("STEP COMPLETE: Network");

    progressCallback(60);

    // --- STEP: Performance ---
    logger.info("STEP START: Performance");
    let performanceMetrics = {
      dnsLookupTime: 0,
      tcpConnectTime: 0,
      ttfb: 0,
      domContentLoaded: 0,
      pageLoadTime: 0
    };

    try {
      const timingJSON = await withTimeout(
        safeEvaluate(page, () => JSON.stringify(window.performance.timing)),
        8000,
        "{}"
      );
      const timing = JSON.parse(timingJSON);
      if (timing && timing.navigationStart) {
        performanceMetrics = {
          dnsLookupTime: Math.max(0, timing.domainLookupEnd - timing.domainLookupStart),
          tcpConnectTime: Math.max(0, timing.connectEnd - timing.connectStart),
          ttfb: Math.max(0, timing.responseStart - timing.requestStart),
          domContentLoaded: Math.max(0, timing.domContentLoadedEventEnd - timing.navigationStart),
          pageLoadTime: Math.max(0, timing.loadEventEnd - timing.navigationStart)
        };
      }
      logger.info("STEP COMPLETE: Performance");
    } catch (e) {
      logger.error("STEP FAILED: Performance Timing", e);
    }

    progressCallback(75);

    // --- STEP: Accessibility ---
    logger.info("STEP START: Accessibility");
    let accessibilityIssuesList = [];
    try {
      const missingAltCount = await withTimeout(
        safeEvaluate(page, () => document.querySelectorAll('img:not([alt])').length),
        5000,
        0
      );
      if (missingAltCount > 0) {
        accessibilityIssuesList.push({
          issue: 'Missing Alt Attributes',
          description: `Found ${missingAltCount} image(s) lacking description 'alt' attributes, impacting screen readers.`,
          severity: 'Medium'
        });
      }

      const hasLang = await withTimeout(
        safeEvaluate(page, () => !!document.documentElement.getAttribute('lang')),
        5000,
        true
      );
      if (!hasLang) {
        accessibilityIssuesList.push({
          issue: 'Missing Language Attribute',
          description: "The HTML tag lacks a lang attribute, causing screen readers to use default voice systems.",
          severity: 'Low'
        });
      }
      logger.info("STEP COMPLETE: Accessibility");
    } catch (e) {
      logger.error("STEP FAILED: Accessibility", e);
    }

    progressCallback(80);

    // --- STEP: SEO ---
    logger.info("STEP START: SEO");
    let seoIssuesList = [];
    try {
      const metaDescCount = await withTimeout(
        safeEvaluate(page, () => document.querySelectorAll('meta[name="description"]').length),
        5000,
        0
      );
      if (metaDescCount === 0) {
        seoIssuesList.push({
          issue: 'Missing Meta Description',
          description: 'The page lacks a meta description tag, reducing click rates in search engine previews.',
          severity: 'High'
        });
      }

      const h1Count = await withTimeout(
        safeEvaluate(page, () => document.querySelectorAll('h1').length),
        5000,
        0
      );
      if (h1Count === 0) {
        seoIssuesList.push({
          issue: 'Missing Heading Structure',
          description: 'No H1 tags found. A primary heading tag is needed for proper SEO classification.',
          severity: 'Medium'
        });
      } else if (h1Count > 1) {
        seoIssuesList.push({
          issue: 'Multiple H1 Headings',
          description: `Found ${h1Count} H1 headings. Pages should limit H1 tags to exactly one for optimal layout.`,
          severity: 'Low'
        });
      }
      logger.info("STEP COMPLETE: SEO");
    } catch (e) {
      logger.error("STEP FAILED: SEO", e);
    }

    await browser.close();
    browser = null;

    progressCallback(90);

    // --- STEP: AI Synthesis ---
    logger.info("STEP START: AI Synthesis");
    const prompt = `
      Act as an Expert QA Reviewer. I have scraped data from the following URL: ${url}.
      Here is the scraped data:
      Title: ${scrapedData.title}
      Body Text Snippet: ${scrapedData.bodyText}
      Console Errors: ${JSON.stringify(scrapedData.consoleErrors)}
      Failed Network Requests: ${JSON.stringify(scrapedData.failedRequests)}

      Based on this data, return a strictly formatted JSON object categorizing ONLY the REAL issues found in the scraped data. DO NOT simulate or hallucinate typical issues. If a category has no issues based on the provided data, return an empty array for that category. Provide a specific "description" explaining the exact error or issue found. Ensure severities are strictly labeled as Critical, High, Medium, or Low.
      
      Required JSON format:
      {
        "frontendIssues": [{ "issue": "Short Title", "description": "Detailed explanation of the issue found in the text or DOM", "severity": "High" }],
        "backendIssues": [{ "issue": "Short Title", "description": "Explanation of failed requests or API errors", "severity": "Critical" }],
        "functionalBugs": [{ "issue": "Short Title", "description": "Explanation of console errors or broken logic", "severity": "Medium" }],
        "responsivenessIssues": [{ "issue": "Short Title", "description": "Explanation of responsiveness issues if any", "severity": "Low" }],
        "performanceIssues": [{ "issue": "Short Title", "description": "Explanation of performance bottlenecks from timing info", "severity": "High" }]
      }
      
      Return ONLY valid JSON. Do not include markdown formatting like \`\`\`json.
    `;

    let reportData = {
      frontendIssues: [],
      backendIssues: [],
      functionalBugs: [],
      responsivenessIssues: [],
      performanceIssues: []
    };

    try {
      let response;
      let attempts = 0;
      const maxAttempts = 3;
      const modelsToTry = ['gemini-2.5-flash'];

      while (attempts < maxAttempts) {
        const modelName = modelsToTry[attempts % modelsToTry.length];
        try {
          console.log(`Calling Gemini with model ${modelName} (attempt ${attempts + 1})...`);
          response = await withTimeout(
            ai.models.generateContent({
              model: modelName,
              contents: prompt,
              config: {
                responseMimeType: 'application/json'
              }
            }),
            30000
          );
          break;
        } catch (err) {
          attempts++;
          console.error(`Gemini call failed on attempt ${attempts}:`, err.message);
          if (attempts >= maxAttempts) {
            throw err;
          }
          console.log('Retrying in 2 seconds...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (response && response.text) {
        let aiText = response.text;
        if (aiText.includes('```')) {
          aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
        }
        const parsed = JSON.parse(aiText);
        reportData = {
          frontendIssues: parsed.frontendIssues || [],
          backendIssues: parsed.backendIssues || [],
          functionalBugs: parsed.functionalBugs || [],
          responsivenessIssues: parsed.responsivenessIssues || [],
          performanceIssues: parsed.performanceIssues || []
        };
      }
      logger.info("STEP COMPLETE: AI Synthesis");
    } catch (aiError) {
      logger.error("STEP FAILED: AI Synthesis - using partial report fallbacks", aiError);

      if (scrapedData.consoleErrors.length > 0) {
        scrapedData.consoleErrors.forEach((err) => {
          reportData.functionalBugs.push({
            issue: 'Console Error Detected',
            description: `A console error occurred in the browser: "${err}"`,
            severity: 'Medium'
          });
        });
      }
      if (scrapedData.failedRequests.length > 0) {
        scrapedData.failedRequests.forEach((req) => {
          reportData.backendIssues.push({
            issue: 'Failed Network Request',
            description: `Network request returned error status: "${req}"`,
            severity: 'High'
          });
        });
      }
      reportData.frontendIssues.push({
        issue: 'AI Analysis Unavailable',
        description: `The automated AI model was unavailable to perform deep structure checks (${aiError.message || '503 overload'}). Crawled browser errors are shown below.`,
        severity: 'Low'
      });
    }

    // --- STEP: Report Persistence ---
    logger.info("STEP START: Report Persistence");
    const newReport = new AuditReport({
      targetUrl: url,
      projectName: 'Automated Audit',
      frontendIssues: reportData.frontendIssues,
      backendIssues: reportData.backendIssues,
      functionalBugs: reportData.functionalBugs,
      responsivenessIssues: reportData.responsivenessIssues,
      performanceIssues: reportData.performanceIssues,
      seoIssues: seoIssuesList,
      accessibilityIssues: accessibilityIssuesList,
      screenshot: screenshotBase64,
      performanceMetrics
    });

    const savedReport = await withTimeout(newReport.save(), 15000);
    logger.info("STEP COMPLETE: Report Persistence");

    progressCallback(100);
    return savedReport;

  } catch (error) {
    logger.error("STEP FAILED: Crawl/Audit Pipeline execution", error);
    if (browser) {
      await browser.close().catch(() => {});
    }
    throw error;
  }
}

module.exports = {
  executeAudit,
  withTimeout
};
