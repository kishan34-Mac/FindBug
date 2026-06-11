const { chromium } = require('playwright');
const { GoogleGenAI } = require('@google/genai');
const AuditReport = require('../models/AuditReport');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

exports.runAudit = async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let browser;
  try {
    // --- Step A: Crawling with Playwright ---
    console.log(`Starting Playwright crawl for: ${url}`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const consoleErrors = [];
    const failedRequests = [];

    // Capture console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Capture failed network requests
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedRequests.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait an extra 2 seconds to allow scripts to execute and errors to log
    await page.waitForTimeout(2000).catch(() => {});

    const title = await page.title();
    // Extract a text snippet to not overwhelm the LLM (first 5000 chars)
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 5000));
    const performanceTiming = await page.evaluate(() => JSON.stringify(window.performance.timing));

    await browser.close();

    const scrapedData = {
      title,
      bodyText,
      consoleErrors,
      failedRequests,
      performanceTiming
    };

    console.log('Playwright crawl complete. Analyzing with Gemini...');

    // --- Step B: AI Analysis with Gemini ---
    const prompt = `
      Act as an Expert QA Reviewer. I have scraped data from the following URL: ${url}.
      Here is the scraped data:
      Title: ${scrapedData.title}
      Body Text Snippet: ${scrapedData.bodyText}
      Console Errors: ${JSON.stringify(scrapedData.consoleErrors)}
      Failed Network Requests: ${JSON.stringify(scrapedData.failedRequests)}
      Performance Timing Info: ${scrapedData.performanceTiming}

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

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const aiText = response.text;
    const reportData = JSON.parse(aiText);

    console.log('Gemini analysis complete. Saving to database...');

    // --- Step C: Storage ---
    const newReport = new AuditReport({
      targetUrl: url,
      projectName: 'Automated Audit',
      frontendIssues: reportData.frontendIssues || [],
      backendIssues: reportData.backendIssues || [],
      functionalBugs: reportData.functionalBugs || [],
      responsivenessIssues: reportData.responsivenessIssues || [],
      performanceIssues: reportData.performanceIssues || []
    });

    const savedReport = await newReport.save();

    console.log('Audit saved successfully.');

    // --- Step D: Response ---
    res.status(200).json(savedReport);

  } catch (error) {
    console.error('Error during audit:', error);
    if (browser) {
      await browser.close().catch(() => {});
    }
    res.status(500).json({ error: 'An error occurred during the audit process.', details: error.message });
  }
};
