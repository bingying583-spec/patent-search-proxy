/**
 * Patent Search Proxy Server
 * 
 * Deploy to Render.com (free tier):
 * 1. Fork this repo to your GitHub
 * 2. Go to render.com → New → Web Service
 * 3. Connect your GitHub repo
 * 4. Set: Build Command: npm install
 *            Start Command: node server.js
 * 5. Deploy!
 * 
 * The deployed URL (e.g. https://patent-search-xxx.onrender.com)
 * can then be used in the patent_search.html tool.
 */

const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');

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
    version: '1.0.0',
    endpoints: [
      'GET /health',
      'GET /search/google?q=assignee:Michelin&num=50',
      'GET /search/patent?assignee=Michelin&from=2020&to=2026',
      'GET /render?url=https://patents.google.com/search?q=...'
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
 *   from    - from year (optional)
 *   to      - to year (optional)
 */
app.get('/search/google', async (req, res) => {
  const { q, num = 50, from, to } = req.query;
  
  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  let searchUrl = `https://patents.google.com/?q=${encodeURIComponent(q)}`;
  if (from) searchUrl += `&asdrq=${from}`;
  if (to) searchUrl += `&asded=${to}`;
  searchUrl += `&num=${Math.min(parseInt(num) || 50, 100)}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });

    const page = await browser.newPage();
    
    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });
    
    // Set a proper user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to Google Patents search
    const response = await page.goto(searchUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });

    console.log('Google Patents response status:', response.status());
    console.log('Final URL:', page.url());

    // Get the rendered HTML
    const html = await page.content();
    
    // Parse results with Cheerio
    const $ = cheerio.load(html);
    const patents = [];

    // Method 1: Try to extract from JSON-LD structured data
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const data = JSON.parse($(el).html() || '{}');
        if (data['@type'] === 'ItemList' && data.itemListElement) {
          data.itemListElement.forEach(item => {
            if (item.item && item.item['@type'] === 'ScholarlyArticle') {
              const article = item.item;
              patents.push({
                title: article.name || article.headline,
                assignee: article.author?.map(a => a.name).join('; ') || '',
                date: article.datePublished || '',
                abstract: article.abstract || '',
                url: article.url || '',
                pubNumber: article.publication?.documentNumber || ''
              });
            }
          });
        }
      } catch (e) {}
    });

    // Method 2: Extract from page HTML structure
    if (patents.length === 0) {
      // Google Patents result items are typically in elements with class "result-item"
      // or with data attributes
      $('[class*="result"]').each((i, el) => {
        if (i >= 100) return;
        const titleEl = $(el).find('a[class*="title"], h3 a, [class*="title"] a').first();
        const title = titleEl.text().trim();
        const url = titleEl.attr('href') || '';
        const assigneeEl = $(el).find('[class*="assignee"], [class*="party"]').first();
        const assignee = assigneeEl.text().trim();
        const dateEl = $(el).find('[class*="date"], .date').first();
        const date = dateEl.text().trim();
        const abstractEl = $(el).find('[class*="abstract"], [class*="snippet"]').first();
        const abstract = abstractEl.text().trim();
        
        if (title) {
          patents.push({ title, assignee, date, abstract, url: url ? 'https://patents.google.com' + url : '' });
        }
      });
    }

    // Method 3: Look for Angular/React rendered content
    if (patents.length === 0) {
      // Try extracting from page's own data attributes
      $('[data-result]').each((i, el) => {
        const data = $(el).attr('data-result');
        if (data) {
          try {
            const parsed = JSON.parse(data);
            patents.push({
              title: parsed.title || '',
              assignee: parsed.assignee || '',
              date: parsed.date || '',
              abstract: parsed.abstract || '',
              url: parsed.url || ''
            });
          } catch(e) {}
        }
      });
    }

    // Method 4: Try Google Patents specific selectors
    if (patents.length === 0) {
      // Look for the table of results
      $('table.result-table tr, .search-result tr, table.list').each((i, el) => {
        const row = $(el);
        const cells = row.find('td');
        if (cells.length >= 3) {
          const title = $(cells[0]).find('a').first().text().trim();
          const assignee = $(cells[1]).text().trim();
          const date = $(cells[2]).text().trim();
          const link = $(cells[0]).find('a').first().attr('href') || '';
          if (title) {
            patents.push({ title, assignee, date, abstract: '', url: link });
          }
        }
      });
    }

    // Get total results count
    let totalResults = 'unknown';
    const resultCountText = $('[class*="count"], .total-results, #result-count').first().text().trim();
    const countMatch = resultCountText.match(/[\d,]+/);
    if (countMatch) totalResults = countMatch[0];

    // Get page metadata
    const pageTitle = $('title').text();

    await browser.close();

    res.json({
      success: true,
      query: q,
      searchUrl: searchUrl,
      totalResults,
      resultCount: patents.length,
      patents,
      note: patents.length === 0 
        ? 'Google Patents uses heavy JavaScript rendering. Results may require additional processing.'
        : 'Results extracted successfully'
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
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const html = await page.content();
    await browser.close();
    
    res.json({
      success: true,
      originalUrl: url,
      statusCode: response.status(),
      htmlLength: html.length,
      html: html.substring(0, 50000) // Limit response size
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: 'Render failed', message: error.message });
  }
});

/**
 * GET /search/patent
 * Unified patent search across multiple sources
 * Falls back to Google Patents via headless Chrome
 */
app.get('/search/patent', async (req, res) => {
  const { assignee, keyword, from, to, source = 'google' } = req.query;
  
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
    const fromStr = from ? `${from}/01/01` : '';
    const toStr = to ? `${to}/12/31` : '';
    if (fromStr && toStr) q += ` BEFORE:${toStr} AFTER:${fromStr}`;
    else if (fromStr) q += ` AFTER:${fromStr}`;
    else if (toStr) q += ` BEFORE:${toStr}`;
  }

  // Redirect to Google Patents search
  req.query.q = q;
  return app._router.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`Patent search proxy listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
