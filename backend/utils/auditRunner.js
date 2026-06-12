const { chromium } = require('playwright');
const { GoogleGenAI } = require('@google/genai');
const AuditReport = require('../models/AuditReport');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function safeEvaluate(page, fn, maxAttempts = 3) {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      return await page.evaluate(fn);
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
    console.log(`Starting Playwright crawl for: ${url}`);

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

    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      console.log('Timeout waiting for networkidle, continuing with DOM content');
    });

    progressCallback(30);

    const title = await page.title().catch(() => 'No Title');
    const bodyText = await page.locator('body').innerText().then(txt => txt.substring(0, 5000)).catch(() => '');

    let screenshotBase64 = null;
    try {
      const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 60 });
      screenshotBase64 = screenshotBuffer.toString('base64');
    } catch (e) {
      console.error('Failed to capture screenshot:', e);
    }

    let performanceMetrics = {
      dnsLookupTime: 0,
      tcpConnectTime: 0,
      ttfb: 0,
      domContentLoaded: 0,
      pageLoadTime: 0
    };

    try {
      const timingJSON = await safeEvaluate(page, () => JSON.stringify(window.performance.timing));
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
    } catch (e) {
      console.error('Failed to parse performance metrics:', e);
    }

    await browser.close();
    browser = null;

    const scrapedData = {
      title,
      bodyText,
      consoleErrors,
      failedRequests,
    };

    progressCallback(50);

    console.log('Scraping complete. Invoking Gemini...');
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
          response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
              responseMimeType: 'application/json'
            }
          });
          break;
        } catch (err) {
          attempts++;
          console.error(`Gemini call failed with model ${modelName} on attempt ${attempts}:`, err.message);
          if (attempts >= maxAttempts) {
            throw err;
          }
          console.log('Retrying in 2 seconds...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

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
    } catch (aiError) {
      console.error('Gemini AI call failed, compiling partial report from scraped data:', aiError);

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

    progressCallback(80);

    const newReport = new AuditReport({
      targetUrl: url,
      projectName: 'Automated Audit',
      frontendIssues: reportData.frontendIssues,
      backendIssues: reportData.backendIssues,
      functionalBugs: reportData.functionalBugs,
      responsivenessIssues: reportData.responsivenessIssues,
      performanceIssues: reportData.performanceIssues,
      screenshot: screenshotBase64,
      performanceMetrics
    });

    const savedReport = await newReport.save();
    progressCallback(100);

    return savedReport;

  } catch (error) {
    console.error('Audit run error:', error);
    if (browser) {
      await browser.close().catch(() => {});
    }
    throw error;
  }
}

module.exports = {
  executeAudit
};
