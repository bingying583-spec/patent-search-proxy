/**
 * Patent Search Proxy Server
 * Uses @sparticuz/chromium for serverless deployment (Render.com compatible)
 *
 * Deploy to Render.com (free tier):
 * 1. Fork this repo to your GitHub
 * 2. Go to render.com → New → Web Service
 * 3. Connect your GitHub repo
 * 4. Set: Build Command: npm install
 *            Start Command: node server.js
 * 5. Deploy!
 */

const express = require('express');
const puppeteer = require('@sparticuz/chromium');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(require('cors')());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'patent-search-proxy',
    version: '1.1.0',
    endpoints: [
      'GET /health',
      'GET /search/google?q=assignee:Michelin&num=50',
      'GET /search/patent?assignee=Michelin&from=2020&to=2026',
      'GET /render?url=URL'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

/**
 * GET /search/google
 * Search Google Patents using headless Chrome
 * Query params:
 *   q       - search query (e.g. "assignee:Michelin")
 *   num     - number of results (default 50, max 100)
 */
app.get('/search/google', async (req, res) => {
  const { q, num = 50 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  const searchUrl = `https://patents.google.com/?q=${encodeURIComponent(q)}&num=${Math.min(parseInt(num) || 50, 100)}`;

  let browser;
  try {
    // Use @sparticuz/chromium for serverless compatibility
    browser = await puppeteer.launch({
      args: puppeteer.args,
      defaultViewport: puppeteer.defaultViewport,
      executablePath: await puppeteer.executablePath(),
      headless: true
    });

    const page = await browser.newPage();

    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });

    // Set a proper user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('Navigating to:', searchUrl);

    // Navigate to Google Patents search
    const response = await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    console.log('Google Patents response status:', response.status());
    console.log('Final URL:', page.url());

    // Get the rendered HTML
    const html = await page.content();

    // Parse results with Cheerio
    const $ = cheerio.load(html);
    const patents = [];

    // Extract results using Google Patents specific selectors
    // Google Patents uses data attributes for results
    $('[data-result]').each((i, el) => {
      if (i >= 100) return;
      const dataStr = $(el).attr('data-result');
      if (dataStr) {
        try {
          const parsed = JSON.parse(decodeURIComponent(dataStr));
          patents.push({
            title: parsed.title || '',
            assignee: parsed.assignee || '',
            date: parsed.date || '',
            pubNumber: parsed.num || '',
            abstract: parsed.abstract || '',
            url: 'https://patents.google.com' + (parsed.link || '')
          });
        } catch (e) {
          // Try direct parsing
          try {
            const parsed = JSON.parse(dataStr);
            patents.push({
              title: parsed.title || '',
              assignee: parsed.assignee || '',
              date: parsed.date || '',
              pubNumber: parsed.num || '',
              abstract: parsed.abstract || '',
              url: 'https://patents.google.com' + (parsed.link || '')
            });
          } catch(e2) {}
        }
      }
    });

    // Alternative: extract from structured data in page
    if (patents.length === 0) {
      $('script[type="application/ld+json"]').each((i, el) => {
        try {
          const data = JSON.parse($(el).html() || '{}');
          if (data['@type'] === 'ItemList' && data.itemListElement) {
            data.itemListElement.forEach(item => {
              if (item.item) {
                const article = item.item;
                patents.push({
                  title: article.name || article.headline || '',
                  assignee: Array.isArray(article.author) ? article.author.map(a => a.name).join('; ') : (article.author?.name || ''),
                  date: article.datePublished || '',
                  pubNumber: article.publication?.documentNumber || '',
                  abstract: article.abstract || '',
                  url: article.url || ''
                });
              }
            });
          }
        } catch (e) {}
      });
    }

    // Fallback: extract from HTML structure
    if (patents.length === 0) {
      // Try to find result rows
      $('tr.result-item, .result-item, article[datapatent]').each((i, el) => {
        if (i >= 50) return;
        const $el = $(el);
        const titleEl = $el.find('a[class*="title"], h3 a, .title').first();
        const title = titleEl.text().trim();
        const link = titleEl.attr('href') || '';
        const assignee = $el.find('[class*="assignee"], [class*="party"]').first().text().trim();
        const date = $el.find('[class*="date"], time').first().text().trim();
        const abstract = $el.find('[class*="abstract"], [class*="snippet"]').first().text().trim();

        if (title) {
          patents.push({
            title,
            assignee,
            date,
            pubNumber: '',
            abstract,
            url: link.startsWith('http') ? link : 'https://patents.google.com' + link
          });
        }
      });
    }

    // Get total results count
    let totalResults = 'unknown';
    const resultCountText = $('[class*="count"], .total-results, #result-count, [data-count]').first().text().trim();
    const countMatch = resultCountText.match(/[\d,]+/);
    if (countMatch) totalResults = countMatch[0];

    await browser.close();

    res.json({
      success: true,
      query: q,
      searchUrl: searchUrl,
      totalResults,
      resultCount: patents.length,
      patents,
      note: patents.length === 0
        ? 'No results found or page structure changed. Google Patents may block automated access.'
        : `Found ${patents.length} results`
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});

    console.error('Error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch Google Patents',
      message: error.message,
      suggestion: 'Google Patents may be temporarily unavailable or rate-limited. Try again later.'
    });
  }
});

/**
 * GET /render
 * Generic page renderer using headless Chrome
 * Query params:
 *   url  - the URL to render (required)
 */
app.get('/render', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing required query parameter: url' });
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: puppeteer.args,
      defaultViewport: puppeteer.defaultViewport,
      executablePath: await puppeteer.executablePath(),
      headless: true
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    const html = await page.content();
    await browser.close();

    res.json({
      success: true,
      originalUrl: url,
      statusCode: response.status(),
      htmlLength: html.length,
      html: html.substring(0, 50000)
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: 'Render failed', message: error.message });
  }
});

/**
 * GET /search/patent
 * Unified patent search
 */
app.get('/search/patent', async (req, res) => {
  const { assignee, keyword, from, to } = req.query;

  if (!assignee && !keyword) {
    return res.status(400).json({ error: 'At least one of assignee or keyword is required' });
  }

  // Build query
  let q = '';
  if (assignee) q += `assignee:${assignee}`;
  if (keyword) {
    if (q) q += ` AND (${keyword})`;
    else q += keyword;
  }
  if (from || to) {
    if (from) q += ` AFTER:${from}/01/01`;
    if (to) q += ` BEFORE:${to}/12/31`;
  }

  // Redirect to /search/google
  req.url = `/search/google?q=${encodeURIComponent(q)}`;
  return app._router.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`Patent search proxy listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
