/**
 * Patent Search Proxy Server
 * Uses puppeteer-core + @sparticuz/chromium for serverless/Render.com deployment
 */

const express = require('express');
const puppeteerCore = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(require('cors')());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'patent-search-proxy',
    version: '1.2.0',
    endpoints: [
      'GET /health',
      'GET /search/google?q=assignee:Michelin&num=50'
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
 *   q    - search query (e.g. "assignee:Michelin")
 *   num  - number of results (default 50, max 100)
 */
app.get('/search/google', async (req, res) => {
  const { q, num = 50 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  const searchUrl = `https://patents.google.com/?q=${encodeURIComponent(q)}&num=${Math.min(parseInt(num) || 50, 100)}`;
  console.log('Searching:', searchUrl);

  let browser;
  try {
    const executablePath = await chromium.executablePath();
    console.log('Chromium path:', executablePath);

    browser = await puppeteerCore.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const response = await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });
    console.log('Response status:', response.status(), 'URL:', page.url());

    const html = await page.content();
    const $ = cheerio.load(html);
    const patents = [];

    // Method 1: data-result attributes
    $('[data-result]').each((i, el) => {
      if (i >= 100) return;
      try {
        const raw = $(el).attr('data-result');
        const parsed = JSON.parse(decodeURIComponent(raw));
        patents.push({
          title: parsed.title || '',
          assignee: parsed.assignee || '',
          date: parsed.date || '',
          pubNumber: parsed.num || '',
          abstract: parsed.abstract || '',
          url: 'https://patents.google.com' + (parsed.link || '')
        });
      } catch (e) {}
    });

    // Method 2: JSON-LD structured data
    if (patents.length === 0) {
      $('script[type="application/ld+json"]').each((i, el) => {
        try {
          const data = JSON.parse($(el).html() || '{}');
          if (data['@type'] === 'ItemList' && data.itemListElement) {
            data.itemListElement.forEach(item => {
              const a = item.item || item;
              patents.push({
                title: a.name || a.headline || '',
                assignee: Array.isArray(a.author)
                  ? a.author.map(x => x.name).join('; ')
                  : (a.author?.name || ''),
                date: a.datePublished || '',
                pubNumber: a.publication?.documentNumber || '',
                abstract: a.abstract || '',
                url: a.url || ''
              });
            });
          }
        } catch (e) {}
      });
    }

    // Method 3: HTML structure fallback
    if (patents.length === 0) {
      $('search-result-item, article[data-result-id], tr[data-result-id]').each((i, el) => {
        if (i >= 50) return;
        const $el = $(el);
        const titleEl = $el.find('h3, h4, [class*="title"]').first();
        const title = titleEl.text().trim();
        if (!title) return;
        const link = $el.find('a').first().attr('href') || '';
        const assignee = $el.find('[class*="assignee"]').first().text().trim();
        const date = $el.find('[class*="date"], time').first().text().trim();
        const abstract = $el.find('[class*="abstract"]').first().text().trim();
        patents.push({
          title, assignee, date, pubNumber: '', abstract,
          url: link.startsWith('http') ? link : 'https://patents.google.com' + link
        });
      });
    }

    await browser.close();

    res.json({
      success: true,
      query: q,
      searchUrl,
      resultCount: patents.length,
      patents,
      note: patents.length === 0
        ? 'No structured results extracted. Google Patents may have changed its page structure.'
        : `Found ${patents.length} results`
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('Search error:', error.message);
    res.status(500).json({
      error: 'Search failed',
      message: error.message
    });
  }
});

/**
 * GET /search/patent
 * Friendly wrapper: ?assignee=Michelin&keyword=tire&from=2020&to=2024
 */
app.get('/search/patent', async (req, res) => {
  const { assignee, keyword, from, to } = req.query;
  if (!assignee && !keyword) {
    return res.status(400).json({ error: 'At least one of assignee or keyword is required' });
  }
  let q = '';
  if (assignee) q += `assignee:${assignee}`;
  if (keyword) q += (q ? ' AND ' : '') + keyword;
  if (from) q += ` AFTER:${from}/01/01`;
  if (to) q += ` BEFORE:${to}/12/31`;

  req.query.q = q;
  req.url = `/search/google?q=${encodeURIComponent(q)}&num=${req.query.num || 50}`;
  app._router.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`Patent search proxy listening on port ${PORT}`);
});
