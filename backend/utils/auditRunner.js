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

    // Inject Web Vitals tracking observers
    await context.addInitScript(() => {
      window.collectedVitals = {
        fcp: 0,
        lcp: 0,
        cls: 0,
        tbt: 0
      };
      
      try {
        const paintObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') {
              window.collectedVitals.fcp = entry.startTime;
            }
          }
        });
        paintObserver.observe({ type: 'paint', buffered: true });
      } catch (e) {}

      try {
        const lcpObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.collectedVitals.lcp = Math.max(window.collectedVitals.lcp, entry.startTime);
          }
        });
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) {}

      try {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              window.collectedVitals.cls += entry.value;
            }
          }
        });
        clsObserver.observe({ type: 'layout-shift', buffered: true });
      } catch (e) {}

      try {
        const tbtObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 50) {
              window.collectedVitals.tbt += (entry.duration - 50);
            }
          }
        });
        tbtObserver.observe({ type: 'longtask', buffered: true });
      } catch (e) {}
    });

    const page = await context.newPage();

    const consoleErrors = [];
    const consoleWarnings = [];
    const jsExceptions = [];
    const failedResources = [];
    const apiRequests = {};
    const apiLogs = [];
    const mixedContentRequests = [];

    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') {
        consoleErrors.push(text);
      } else if (type === 'warning') {
        consoleWarnings.push(text);
      }
    });

    page.on('pageerror', (exception) => {
      jsExceptions.push(exception.stack || exception.message);
    });

    page.on('requestfailed', (req) => {
      failedResources.push({
        url: req.url(),
        method: req.method(),
        errorText: req.failure() ? req.failure().errorText : 'Unknown failure',
        resourceType: req.resourceType()
      });
    });

    page.on('request', (req) => {
      const reqUrl = req.url();
      if (url.startsWith('https://') && reqUrl.startsWith('http://')) {
        mixedContentRequests.push(reqUrl);
      }
      const type = req.resourceType();
      if (type === 'fetch' || type === 'xhr') {
        apiRequests[reqUrl] = {
          url: reqUrl,
          method: req.method(),
          startTime: Date.now(),
          headers: req.headers()
        };
      }
    });

    page.on('response', async (res) => {
      const reqUrl = res.url();
      const reqData = apiRequests[reqUrl];
      const type = res.request().resourceType();
      if (type === 'fetch' || type === 'xhr') {
        const duration = reqData ? (Date.now() - reqData.startTime) : 0;
        const status = res.status();
        let responseBody = '';
        if (status >= 400) {
          try {
            responseBody = await res.text();
          } catch (e) {
            responseBody = '[Payload not text or body unreadable]';
          }
        }
        apiLogs.push({
          url: reqUrl,
          method: res.request().method(),
          status,
          statusText: res.statusText(),
          duration,
          responseBody: responseBody.substring(0, 500)
        });
      }
    });

    // Navigation Step
    console.log(`Navigating to: ${url}`);
    const response = await withTimeout(
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
      35000
    );
    
    // Capped NetworkIdle Wait
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      console.log('Timeout waiting for networkidle, continuing with DOM content');
    });

    const mainResponseHeaders = response ? response.headers() : {};

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

    // --- STEP: Network / Crawling ---
    logger.info("STEP START: Network");
    const pageTitle = await withTimeout(page.title(), 5000, 'No Title');
    const bodyText = await withTimeout(
      page.locator('body').innerText().then(txt => txt.substring(0, 5000)),
      10000,
      ''
    );
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

    const vitals = await safeEvaluate(page, () => window.collectedVitals || { fcp: 0, lcp: 0, cls: 0, tbt: 0 });

    progressCallback(70);

    // --- STEP: Security Checks ---
    logger.info("STEP START: Security");
    const securityHeaders = {
      'Content-Security-Policy': mainResponseHeaders['content-security-policy'] || null,
      'Strict-Transport-Security': mainResponseHeaders['strict-transport-security'] || null,
      'X-Frame-Options': mainResponseHeaders['x-frame-options'] || null,
      'X-Content-Type-Options': mainResponseHeaders['x-content-type-options'] || null,
      'Referrer-Policy': mainResponseHeaders['referrer-policy'] || null
    };

    let insecureCookies = [];
    try {
      const cookies = await context.cookies(url);
      insecureCookies = cookies.filter(c => !c.secure || !c.httpOnly).map(c => ({
        name: c.name,
        domain: c.domain,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite
      }));
    } catch (e) {
      logger.error("STEP FAILED: Cookie collection", e);
    }
    logger.info("STEP COMPLETE: Security");

    // --- STEP: Accessibility DOM Scan ---
    logger.info("STEP START: Accessibility");
    let accessibilityReport = [];
    try {
      accessibilityReport = await safeEvaluate(page, () => {
        const issues = [];
        
        // 1. Missing alt attributes
        const imagesWithoutAlt = document.querySelectorAll('img:not([alt])');
        imagesWithoutAlt.forEach(img => {
          issues.push({
            type: 'Missing Alt Attribute',
            evidence: img.outerHTML.substring(0, 200),
            element: 'img'
          });
        });

        // 2. Missing labels for inputs
        const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"])');
        inputs.forEach(input => {
          let hasLabel = false;
          if (input.getAttribute('aria-label') || input.getAttribute('aria-labelledby') || input.getAttribute('title')) {
            hasLabel = true;
          } else {
            const id = input.getAttribute('id');
            if (id) {
              const label = document.querySelector(`label[for="${id}"]`);
              if (label) hasLabel = true;
            }
            if (!hasLabel) {
              let parent = input.parentElement;
              while (parent) {
                if (parent.tagName === 'LABEL') {
                  hasLabel = true;
                  break;
                }
                parent = parent.parentElement;
              }
            }
          }
          if (!hasLabel) {
            issues.push({
              type: 'Missing Label for Input',
              evidence: input.outerHTML.substring(0, 200),
              element: input.tagName.toLowerCase()
            });
          }
        });

        // 3. Contrast Failures
        function getContrastRatio(el) {
          const style = window.getComputedStyle(el);
          const fg = style.color;
          const bg = style.backgroundColor;
          function parseRGB(colorStr) {
            const match = colorStr.match(/\d+/g);
            if (!match) return [0, 0, 0];
            return match.slice(0, 3).map(Number);
          }
          function getLuminance(rgb) {
            const a = rgb.map(v => {
              v /= 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
            return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
          }
          let computedBg = bg;
          let parent = el;
          while ((computedBg.includes('rgba') && computedBg.includes(', 0)')) || computedBg === 'transparent') {
            if (!parent.parentElement) break;
            parent = parent.parentElement;
            computedBg = window.getComputedStyle(parent).backgroundColor;
          }
          const lum1 = getLuminance(parseRGB(fg));
          const lum2 = getLuminance(parseRGB(computedBg));
          const brightest = Math.max(lum1, lum2);
          const darkest = Math.min(lum1, lum2);
          return (brightest + 0.05) / (darkest + 0.05);
        }

        const textNodes = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
        let n;
        while (n = walk.nextNode()) {
          const text = n.innerText ? n.innerText.trim() : '';
          if (text.length > 0 && n.children.length === 0) {
            textNodes.push(n);
          }
        }

        textNodes.slice(0, 50).forEach(el => {
          try {
            const ratio = getContrastRatio(el);
            if (ratio < 4.5) {
              issues.push({
                type: 'Contrast Failure',
                evidence: `${el.outerHTML.substring(0, 100)} (Contrast: ${ratio.toFixed(2)}:1)`,
                element: el.tagName.toLowerCase()
              });
            }
          } catch (e) {}
        });

        // 4. Keyboard focus indicators / navigation
        const interactive = document.querySelectorAll('[onclick], [style*="cursor: pointer"], [style*="cursor:pointer"]');
        interactive.forEach(el => {
          const tag = el.tagName.toLowerCase();
          const focusable = ['a', 'button', 'input', 'select', 'textarea'];
          if (!focusable.includes(tag) && !el.getAttribute('tabindex')) {
            issues.push({
              type: 'Keyboard Navigation Issue',
              evidence: el.outerHTML.substring(0, 200),
              element: tag
            });
          }
        });

        return issues;
      });
      logger.info("STEP COMPLETE: Accessibility");
    } catch (e) {
      logger.error("STEP FAILED: Accessibility DOM scan", e);
    }

    progressCallback(75);

    // --- STEP: SEO & Sitemap/Robots check ---
    logger.info("STEP START: SEO");
    let seoIssuesList = [];
    let robotsTxtContent = 'Unable to verify';
    let sitemapContent = 'Unable to verify';
    let metaDescCount = 0;
    let canonical = null;
    let structuredDataCount = 0;

    try {
      metaDescCount = await safeEvaluate(page, () => document.querySelectorAll('meta[name="description"]').length);
      if (metaDescCount === 0) {
        seoIssuesList.push({
          issue: 'Missing Meta Description',
          description: 'The page lacks a meta description tag, reducing click rates in search engine previews.',
          severity: 'High'
        });
      }

      canonical = await safeEvaluate(page, () => {
        const link = document.querySelector('link[rel="canonical"]');
        return link ? link.getAttribute('href') : null;
      });
      if (!canonical) {
        seoIssuesList.push({
          issue: 'Missing Canonical Link',
          description: 'No canonical link tag found. Duplicate content indexing risk.',
          severity: 'Medium'
        });
      }

      structuredDataCount = await safeEvaluate(page, () => document.querySelectorAll('script[type="application/ld+json"]').length);

      const h1Count = await safeEvaluate(page, () => document.querySelectorAll('h1').length);
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

      // Fetch robots.txt and sitemap.xml
      try {
        const robotsRes = await context.request.get(new URL('/robots.txt', url).href).catch(() => null);
        if (robotsRes && robotsRes.ok()) {
          robotsTxtContent = await robotsRes.text();
        } else {
          robotsTxtContent = `Not Found (Status: ${robotsRes ? robotsRes.status() : 'Error'})`;
          seoIssuesList.push({
            issue: 'Missing Robots.txt',
            description: 'No robots.txt was found. Search engines cannot easily optimize domain crawling limits.',
            severity: 'Medium'
          });
        }
      } catch (e) {
        robotsTxtContent = `Error fetching: ${e.message}`;
      }

      try {
        const sitemapRes = await context.request.get(new URL('/sitemap.xml', url).href).catch(() => null);
        if (sitemapRes && sitemapRes.ok()) {
          sitemapContent = 'Found (Status 200)';
        } else {
          sitemapContent = `Not Found (Status: ${sitemapRes ? sitemapRes.status() : 'Error'})`;
          seoIssuesList.push({
            issue: 'Missing Sitemap.xml',
            description: 'No sitemap.xml was detected at the root. Crawlers might miss deeper nested pages.',
            severity: 'Medium'
          });
        }
      } catch (e) {
        sitemapContent = `Error fetching: ${e.message}`;
      }

      logger.info("STEP COMPLETE: SEO");
    } catch (e) {
      logger.error("STEP FAILED: SEO", e);
    }

    // --- STEP: Layout shifts / Overflow check ---
    let overflowElements = [];
    try {
      overflowElements = await safeEvaluate(page, () => {
        const list = [];
        const elements = document.querySelectorAll('*');
        const width = window.innerWidth;
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          if (rect.right > width) {
            list.push({
              tagName: el.tagName,
              id: el.id,
              className: el.className,
              right: rect.right,
              width
            });
          }
        }
        return list;
      });
    } catch (e) {
      logger.error("STEP FAILED: Overflow check", e);
    }

    // Broken images check
    let brokenImages = [];
    try {
      brokenImages = await safeEvaluate(page, () => {
        const list = [];
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          if (img.naturalWidth === 0 || img.naturalHeight === 0) {
            list.push({
              src: img.src,
              outerHTML: img.outerHTML.substring(0, 200)
            });
          }
        }
        return list;
      });
    } catch (e) {}

    // Broken links check
    let brokenLinks = [];
    try {
      brokenLinks = await safeEvaluate(page, () => {
        const list = [];
        const anchors = document.querySelectorAll('a');
        for (const a of anchors) {
          const href = a.getAttribute('href');
          if (!href || href === '#' || href.startsWith('javascript:')) {
            list.push({
              text: a.innerText.trim(),
              href: href || '',
              outerHTML: a.outerHTML.substring(0, 200)
            });
          }
        }
        return list;
      });
    } catch (e) {}

    const scrapedFacts = {
      url,
      title: pageTitle,
      bodyText,
      consoleErrors,
      consoleWarnings,
      jsExceptions,
      failedResources,
      apiLogs,
      mixedContentRequests,
      performanceMetrics,
      vitals,
      securityHeaders,
      insecureCookies,
      accessibilityReport,
      seoIssuesList,
      robotsTxtContent,
      sitemapContent,
      metaDescCount,
      canonical,
      structuredDataCount,
      overflowElements,
      brokenImages,
      brokenLinks
    };

    await browser.close();
    browser = null;

    progressCallback(85);

    // --- STEP: AI Synthesis ---
    logger.info("STEP START: AI Synthesis");
    const prompt = `
      Act as an elite QA task force consisting of a Principal QA Engineer, Security Auditor, Performance Engineer, and Software Architect.
      I have performed a real-time audit on the URL: ${url}.
      Here is the raw verified evidence collected directly from the page:
      ${JSON.stringify(scrapedFacts, null, 2)}

      Analyze the raw evidence and return a strictly formatted JSON object containing ONLY verified findings.
      
      CRITICAL RULES:
      1. NEVER generate hallucinated findings, sample issues, mock bugs, generic template reports, or assumptions.
      2. Every single issue MUST be directly linked to a specific item in the Console Errors, JS Exceptions, Failed Network Requests, Performance timing metrics, Security issues, Accessibility issues, or SEO issues listed above. If none of these show a bug, return an empty array for that category. It is better to return an empty array than a single unverified issue.
      3. For every issue, populate all fields:
         - "issue": The specific title of the finding (e.g., "Script ReferenceError", "Broken Resource GET", "High TTFB Latency")
         - "description": A concise explanation of the bug.
         - "severity": "Critical", "High", "Medium", or "Low"
         - "exactPageUrl": The exact URL where the issue was detected.
         - "evidence": The exact error trace, failed URL, or measured timing metric.
         - "screenshot": "N/A" or optional description if applicable.
         - "networkLog": Raw network log/line or status text if applicable.
         - "domSelector": CSS selector of the failing element if applicable.
         - "consoleError": Console stack trace or message if applicable.
         - "apiResponse": API payload response if applicable.
         - "reproducible": "Yes" or "No"
         - "confidence": 100 (Only include issues verified with 100% confidence. If any issue is not 100% verified, set confidence below 100 and set "observationOnly": true)
         - "reproductionSteps": Step-by-step instructions to reproduce this issue.
         - "recommendedFix": Actionable engineering steps to resolve the issue.
         - "observationOnly": true or false (Set to true if confidence is less than 100% or requires manual check).
         - "rootCause": Root cause analysis detailing why this issue occurred based on the logs/framework indicators.
         - "businessImpact": The operational or revenue impact this issue has on the business.
         - "technicalImpact": The technical severity, performance impact, or code stability degradation.
         - "estimatedEffort": Estimated engineering effort to resolve (e.g., "1 hour", "1-2 days", "30 minutes").

      Required JSON format:
      {
        "frontendIssues": [],
        "backendIssues": [],
        "functionalBugs": [],
        "responsivenessIssues": [],
        "performanceIssues": [],
        "seoIssues": [],
        "accessibilityIssues": []
      }

      Return ONLY valid JSON. Do not include markdown formatting like \`\`\`json.
    `;

    let reportData = {
      frontendIssues: [],
      backendIssues: [],
      functionalBugs: [],
      responsivenessIssues: [],
      performanceIssues: [],
      seoIssues: [],
      accessibilityIssues: []
    };

    let scores = {
      overallScore: 100,
      securityScore: 100,
      accessibilityScore: 100,
      performanceScore: 100,
      seoScore: 100,
      reliabilityScore: 100,
      mobileScore: 100
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
        
        // Quality Gate: Process, sanitize, and verify all issues
        const verifiedData = runQualityGate(parsed, scrapedFacts);
        Object.keys(reportData).forEach(key => {
          reportData[key] = verifiedData[key];
        });
      }
      logger.info("STEP COMPLETE: AI Synthesis");
    } catch (aiError) {
      logger.error("STEP FAILED: AI Synthesis - using partial report fallbacks", aiError);
      reportData = generateFallbackReport(scrapedFacts);
    }

    // Programmatic Score Calculation (100% evidence-backed Phase 15)
    scores = calculateScores(reportData, scrapedFacts);

    progressCallback(90);

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
      seoIssues: reportData.seoIssues,
      accessibilityIssues: reportData.accessibilityIssues,
      screenshot: screenshotBase64,
      performanceMetrics,
      overallScore: scores.overallScore,
      securityScore: scores.securityScore,
      accessibilityScore: scores.accessibilityScore,
      performanceScore: scores.performanceScore,
      seoScore: scores.seoScore,
      reliabilityScore: scores.reliabilityScore,
      mobileScore: scores.mobileScore
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

// Calculate 100% Evidence-Backed Report Scores
function calculateScores(reportData, scraped) {
  const scores = {
    securityScore: 100,
    accessibilityScore: 100,
    performanceScore: 100,
    seoScore: 100,
    reliabilityScore: 100,
    mobileScore: 100,
    overallScore: 100
  };

  const severityDeductions = { Critical: 20, High: 15, Medium: 8, Low: 3 };

  // 1. Security Score
  // Base deductions on backend/frontend issues matching security headers, cookies, mixed content
  let securityIssuesCount = 0;
  reportData.backendIssues.forEach(issue => {
    const isSec = issue.issue.toLowerCase().includes('csp') || issue.issue.toLowerCase().includes('security') || issue.issue.toLowerCase().includes('cookie') || issue.issue.toLowerCase().includes('mixed');
    if (isSec) {
      scores.securityScore -= (severityDeductions[issue.severity] || 5);
      securityIssuesCount++;
    }
  });
  scores.securityScore = Math.max(0, scores.securityScore);

  // 2. Accessibility Score
  reportData.accessibilityIssues.forEach(issue => {
    scores.accessibilityScore -= (severityDeductions[issue.severity] || 5);
  });
  scores.accessibilityScore = Math.max(0, scores.accessibilityScore);

  // 3. Performance Score
  // Deduct based on performance issues + raw vitals
  reportData.performanceIssues.forEach(issue => {
    scores.performanceScore -= (severityDeductions[issue.severity] || 5);
  });
  const v = scraped.vitals;
  if (v.fcp > 3000) scores.performanceScore -= 10;
  if (v.lcp > 4000) scores.performanceScore -= 15;
  if (v.cls > 0.25) scores.performanceScore -= 10;
  if (v.tbt > 300) scores.performanceScore -= 10;
  scores.performanceScore = Math.max(0, scores.performanceScore);

  // 4. SEO Score
  reportData.seoIssues.forEach(issue => {
    scores.seoScore -= (severityDeductions[issue.severity] || 5);
  });
  scores.seoScore = Math.max(0, scores.seoScore);

  // 5. Reliability Score
  // Deduct for JS exceptions & Console errors
  reportData.functionalBugs.forEach(issue => {
    scores.reliabilityScore -= (severityDeductions[issue.severity] || 5);
  });
  reportData.frontendIssues.forEach(issue => {
    if (issue.issue.toLowerCase().includes('error') || issue.issue.toLowerCase().includes('crash')) {
      scores.reliabilityScore -= (severityDeductions[issue.severity] || 5);
    }
  });
  scores.reliabilityScore = Math.max(0, scores.reliabilityScore);

  // 6. Mobile Score
  reportData.responsivenessIssues.forEach(issue => {
    scores.mobileScore -= (severityDeductions[issue.severity] || 5);
  });
  scores.mobileScore = Math.max(0, scores.mobileScore);

  // 7. Overall Score: Average of all scores
  scores.overallScore = Math.round(
    (scores.securityScore +
      scores.accessibilityScore +
      scores.performanceScore +
      scores.seoScore +
      scores.reliabilityScore +
      scores.mobileScore) /
      6
  );

  return scores;
}

// Strict Server-Side Quality Gate Filter
function runQualityGate(parsed, scraped) {
  const verified = {
    frontendIssues: [],
    backendIssues: [],
    functionalBugs: [],
    responsivenessIssues: [],
    performanceIssues: [],
    seoIssues: [],
    accessibilityIssues: []
  };

  const categories = Object.keys(verified);

  categories.forEach(cat => {
    if (!Array.isArray(parsed[cat])) return;

    parsed[cat].forEach(issue => {
      // 1. Must have basic fields
      if (!issue.issue || !issue.description || !issue.evidence) {
        return; // reject immediately
      }

      // 2. Validate against scraped evidence
      let isVerified = false;
      const lowerEvidence = (issue.evidence || '').toLowerCase();
      const lowerIssue = (issue.issue || '').toLowerCase();
      const lowerDescription = (issue.description || '').toLowerCase();

      if (cat === 'functionalBugs' || cat === 'frontendIssues') {
        const hasConsoleErr = scraped.consoleErrors.some(e => e.toLowerCase().includes(lowerEvidence) || lowerEvidence.includes(e.toLowerCase()));
        const hasWarning = scraped.consoleWarnings.some(w => w.toLowerCase().includes(lowerEvidence) || lowerEvidence.includes(w.toLowerCase()));
        const hasException = scraped.jsExceptions.some(ex => ex.toLowerCase().includes(lowerEvidence) || lowerEvidence.includes(ex.toLowerCase()));
        const hasBrokenImage = scraped.brokenImages.some(img => img.src.toLowerCase().includes(lowerEvidence) || img.outerHTML.toLowerCase().includes(lowerEvidence));
        const hasBrokenLink = scraped.brokenLinks.some(lnk => lnk.href.toLowerCase().includes(lowerEvidence) || lnk.outerHTML.toLowerCase().includes(lowerEvidence));

        if (hasConsoleErr || hasWarning || hasException || hasBrokenImage || hasBrokenLink) {
          isVerified = true;
        }
      } else if (cat === 'backendIssues') {
        const hasFailedResource = scraped.failedResources.some(r => r.url.toLowerCase().includes(lowerEvidence) || lowerEvidence.includes(r.url.toLowerCase()));
        const hasFailedApi = scraped.apiLogs.some(api => (api.status >= 400 && (api.url.toLowerCase().includes(lowerEvidence) || lowerEvidence.includes(api.url.toLowerCase()))));
        const hasCors = lowerEvidence.includes('cors') || lowerIssue.includes('cors') || lowerDescription.includes('cors');
        const hasMissingHeader = Object.entries(scraped.securityHeaders).some(([key, val]) => val === null && (lowerIssue.includes(key.toLowerCase()) || lowerDescription.includes(key.toLowerCase())));
        const hasCookieIssue = scraped.insecureCookies.length > 0 && (lowerIssue.includes('cookie') || lowerDescription.includes('cookie'));
        const hasMixedContent = scraped.mixedContentRequests.length > 0 && (lowerIssue.includes('mixed content') || lowerDescription.includes('mixed content'));

        if (hasFailedResource || hasFailedApi || hasCors || hasMissingHeader || hasCookieIssue || hasMixedContent) {
          isVerified = true;
        }
      } else if (cat === 'responsivenessIssues') {
        const hasOverflow = scraped.overflowElements.length > 0;
        if (hasOverflow) {
          isVerified = true;
        }
      } else if (cat === 'performanceIssues') {
        const m = scraped.performanceMetrics;
        const v = scraped.vitals;
        const isSlow = m.ttfb > 600 || m.pageLoadTime > 4000 || v.fcp > 3000 || v.lcp > 4000 || v.cls > 0.25 || v.tbt > 300;
        if (isSlow) {
          isVerified = true;
        }
      } else if (cat === 'seoIssues') {
        const isSeoMissing = (scraped.seoIssuesList.length > 0) || 
                            (scraped.robotsTxtContent.includes('Not Found') && lowerIssue.includes('robots')) ||
                            (scraped.sitemapContent.includes('Not Found') && lowerIssue.includes('sitemap')) ||
                            (scraped.canonical === null && lowerIssue.includes('canonical')) ||
                            (scraped.metaDescCount === 0 && lowerIssue.includes('description')) ||
                            (scraped.title === 'No Title' && lowerIssue.includes('title')) ||
                            (scraped.structuredDataCount === 0 && lowerIssue.includes('structured'));
        if (isSeoMissing) {
          isVerified = true;
        }
      } else if (cat === 'accessibilityIssues') {
        const hasA11y = scraped.accessibilityReport.some(a => a.type.toLowerCase().includes(lowerIssue) || lowerIssue.includes(a.type.toLowerCase()) || lowerEvidence.includes(a.evidence.toLowerCase()));
        if (hasA11y) {
          isVerified = true;
        }
      }

      if (isVerified) {
        if (typeof issue.confidence !== 'number') {
          issue.confidence = 100;
        }
        if (issue.confidence < 100) {
          issue.observationOnly = true;
        } else {
          issue.observationOnly = !!issue.observationOnly;
        }
        
        issue.exactPageUrl = issue.exactPageUrl || scraped.url;
        issue.screenshot = issue.screenshot || "";
        issue.networkLog = issue.networkLog || "";
        issue.domSelector = issue.domSelector || "";
        issue.consoleError = issue.consoleError || "";
        issue.apiResponse = issue.apiResponse || "";
        issue.reproducible = issue.reproducible || "Yes";
        issue.reproductionSteps = issue.reproductionSteps || "N/A";
        issue.recommendedFix = issue.recommendedFix || "N/A";

        // Phase 14 Root Cause Fields
        issue.rootCause = issue.rootCause || "System configuration or runtime execution error detected in frontend telemetry.";
        issue.businessImpact = issue.businessImpact || "Degraded user confidence and minor layout instability in specific viewport frames.";
        issue.technicalImpact = issue.technicalImpact || "Throws warnings and raises potential script rendering execution latency.";
        issue.estimatedEffort = issue.estimatedEffort || "30 minutes";

        verified[cat].push(issue);
      }
    });
  });

  return verified;
}

function generateFallbackReport(scraped) {
  const reportData = {
    frontendIssues: [],
    backendIssues: [],
    functionalBugs: [],
    responsivenessIssues: [],
    performanceIssues: [],
    seoIssues: [],
    accessibilityIssues: []
  };

  // Map JS Exceptions & Console Errors
  if (scraped.jsExceptions.length > 0) {
    scraped.jsExceptions.forEach((err) => {
      reportData.functionalBugs.push({
        issue: 'JavaScript Exception Detected',
        description: `An uncaught script error was thrown: "${err.split('\n')[0]}"`,
        severity: 'Critical',
        exactPageUrl: scraped.url,
        evidence: `Stack trace: ${err}`,
        screenshot: '',
        networkLog: '',
        domSelector: '',
        consoleError: err,
        apiResponse: '',
        reproducible: 'Yes',
        confidence: 100,
        reproductionSteps: '1. Open the page in a browser.\n2. Open developer console.\n3. The script exception is printed immediately on load.',
        recommendedFix: 'Examine the stack trace, check for undefined object dereferencing, and load scripts safely.',
        observationOnly: false,
        rootCause: 'Uncaught runtime script exception due to null variable reference or module resolving failure.',
        businessImpact: 'Complete failure of execution block, potentially blocking user sign-ups or payments.',
        technicalImpact: 'Halts script execution and crashes the page runtime thread.',
        estimatedEffort: '1-2 hours'
      });
    });
  }

  if (scraped.consoleErrors.length > 0) {
    scraped.consoleErrors.forEach((err) => {
      reportData.functionalBugs.push({
        issue: 'Console Error Detected',
        description: `A console error occurred in the browser: "${err}"`,
        severity: 'Medium',
        exactPageUrl: scraped.url,
        evidence: `Console Log: ${err}`,
        screenshot: '',
        networkLog: '',
        domSelector: '',
        consoleError: err,
        apiResponse: '',
        reproducible: 'Yes',
        confidence: 100,
        reproductionSteps: '1. Open the page.\n2. Review developer console errors.',
        recommendedFix: 'Review error cause in console statement and ensure proper execution pathways.',
        observationOnly: false,
        rootCause: 'Browser log capture. Unhandled function output warnings or external SDK warnings.',
        businessImpact: 'Minor friction in performance telemetry and tracking systems.',
        technicalImpact: 'Increases console error noise, reducing debugging visibility.',
        estimatedEffort: '30 minutes'
      });
    });
  }

  // Map network failures
  if (scraped.failedResources.length > 0) {
    scraped.failedResources.forEach((req) => {
      reportData.backendIssues.push({
        issue: 'Failed Network Request',
        description: `Resource failed to load with status: "${req.errorText}"`,
        severity: 'High',
        exactPageUrl: scraped.url,
        evidence: `Failed Request: ${req.method} ${req.url} - ${req.errorText}`,
        screenshot: '',
        networkLog: `${req.method} ${req.url} failed with ${req.errorText}`,
        domSelector: '',
        consoleError: '',
        apiResponse: '',
        reproducible: 'Yes',
        confidence: 100,
        reproductionSteps: '1. Inspect network requests on load.\n2. Search for the failed URL.',
        recommendedFix: 'Ensure target resource is online and origin CORS policies allow access.',
        observationOnly: false,
        rootCause: 'Network request failure. Endpoint timed out or CORS check rejected request headers.',
        businessImpact: 'Causes broken UI elements or missing API responses, causing user drop-offs.',
        technicalImpact: 'Reduces server-side availability metrics and network stability.',
        estimatedEffort: '1 hour'
      });
    });
  }

  // Map accessibility issues
  if (scraped.accessibilityReport.length > 0) {
    scraped.accessibilityReport.forEach(issue => {
      reportData.accessibilityIssues.push({
        issue: issue.type,
        description: `Accessibility check failed for: ${issue.type}`,
        severity: 'Medium',
        exactPageUrl: scraped.url,
        evidence: `Element evidence: ${issue.evidence}`,
        screenshot: '',
        networkLog: '',
        domSelector: issue.evidence,
        consoleError: '',
        apiResponse: '',
        reproducible: 'Yes',
        confidence: 100,
        reproductionSteps: `1. View page source.\n2. Locate DOM element: ${issue.evidence}`,
        recommendedFix: 'Update element tags to meet WCAG standards.',
        observationOnly: false,
        rootCause: 'DOM element markup structure missing mandatory screen-reader labels or description flags.',
        businessImpact: 'Fails accessibility law compliance and blocks visually impaired users.',
        technicalImpact: 'Reduces DOM semantic tree layout quality.',
        estimatedEffort: '45 minutes'
      });
    });
  }

  // Map SEO issues
  if (scraped.seoIssuesList.length > 0) {
    scraped.seoIssuesList.forEach(issue => {
      reportData.seoIssues.push({
        issue: issue.issue,
        description: issue.description,
        severity: issue.severity,
        exactPageUrl: scraped.url,
        evidence: `SEO Meta audit failed: ${issue.issue}`,
        screenshot: '',
        networkLog: '',
        domSelector: '',
        consoleError: '',
        apiResponse: '',
        reproducible: 'Yes',
        confidence: 100,
        reproductionSteps: '1. Inspect page head tag settings.',
        recommendedFix: 'Add correct tags to page headers.',
        observationOnly: false,
        rootCause: 'Missing index headers, meta tag definition variables, canonical bindings, or robots configurations.',
        businessImpact: 'Reduces search placement visibility and domain rankings in search pages.',
        technicalImpact: 'Prevents crawlers from properly parsing content mappings.',
        estimatedEffort: '30 minutes'
      });
    });
  }

  return reportData;
}

module.exports = {
  executeAudit,
  withTimeout,
  runQualityGate,
  generateFallbackReport,
  calculateScores
};
