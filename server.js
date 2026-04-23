/**
 * Patent Search Proxy Server
 * Direct HTTP scraping - no Puppeteer needed, works on any server
 *
 * Deploy to Render.com:
 * 1. Upload files to GitHub
 * 2. render.com → New → Web Service → connect repo
 * 3. Build: npm install | Start: node server.js
 */

const express = require('express');
const axios = require('axios');
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
    version: '2.0.0',
    note: 'Direct HTTP scraping (no headless browser)',
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
 * Query params:
 *   q    - search query (e.g. "assignee:Michelin" or "silica tire")
 *   num  - number of results (default 50, max 100)
 */
app.get('/search/google', async (req, res) => {
  const { q, num = 50 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  const n = Math.min(parseInt(num) || 50, 100);
  const searchUrl = `https://patents.google.com/?q=${encodeURIComponent(q)}&num=${n}`;

  console.log('Fetching:', searchUrl);

  try {
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 30000,
      // Follow redirects manually
      maxRedirects: 5,
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const patents = [];

    // Extract from data-result attributes
    $('[data-result]').each((i, el) => {
      if (i >= n) return;
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

    // Extract from JSON-LD structured data
    if (patents.length === 0) {
      $('script[type="application/ld+json"]').each((i, el) => {
        try {
          const data = JSON.parse($(el).html() || '{}');
          const items = data.itemListElement || [];
          items.forEach(item => {
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
        } catch (e) {}
      });
    }

    // Extract from Angular/JS rendered page via text matching
    if (patents.length === 0) {
      // Try to find patent numbers and titles from page metadata
      const pageText = html;

      // Look for structured data in page
      const dataMatch = pageText.match(/\"results\"\:\[([^\]]+)\]/);
      if (dataMatch) {
        try {
          const resultsJson = JSON.parse('[' + dataMatch[1] + ']');
          resultsJson.forEach(item => {
            patents.push({
              title: item.title || '',
              assignee: item.assignee || '',
              date: item.date || '',
              pubNumber: item.publicationNumber || '',
              abstract: item.abstract || '',
              url: 'https://patents.google.com' + (item.link || '')
            });
          });
        } catch(e) {}
      }
    }

    // Extract from HTML fallback
    if (patents.length === 0) {
      // Try finding titles and links
      $('a[href*="/patent/"]').each((i, el) => {
        if (i >= n) return;
        const $el = $(el);
        const href = $el.attr('href') || '';
        // Only patent detail links
        if (!href.match(/\/patent\//) || href.includes('/download')) return;

        let title = $el.text().trim();
        // Get parent context for more info
        const parent = $el.parent();
        const grandparent = parent.parent();

        let assignee = grandparent.find('[class*="assignee"], [class*="party"]').first().text().trim();
        let date = grandparent.find('[class*="date"]').first().text().trim();

        if (title.length > 10) {
          patents.push({
            title,
            assignee,
            date,
            pubNumber: '',
            abstract: '',
            url: 'https://patents.google.com' + href.split('?')[0]
          });
        }
      });
    }

    // Total results count
    let totalResults = 'unknown';
    const countEl = $('[class*="result-count"], .total-count, [data-count]').first().text();
    const countMatch = countEl.match(/[\d,]+/);
    if (countMatch) totalResults = countMatch[0];

    // Fallback: count from total results text
    if (totalResults === 'unknown') {
      const bodyText = $('body').text();
      const match = bodyText.match(/about\s+([\d,]+)\s+results/i) || bodyText.match(/([\d,]+)\s+results?\s+found/i);
      if (match) totalResults = match[1];
    }

    console.log(`Found ${patents.length} patents`);

    res.json({
      success: true,
      query: q,
      searchUrl,
      totalResults,
      resultCount: patents.length,
      patents: patents.slice(0, n),
      note: patents.length === 0
        ? 'No structured results found. Google Patents may require JS rendering for this query.'
        : `Found ${patents.length} results`
    });

  } catch (error) {
    console.error('Error:', error.message);
    const status = error.response?.status || 500;
    res.status(status).json({
      error: 'Failed to fetch Google Patents',
      message: error.message,
      statusCode: error.response?.status,
      suggestion: status === 403
        ? 'Google Patents is blocking requests. Try adding delays between searches.'
        : 'Try again later.'
    });
  }
});

/**
 * GET /search/patent
 * Friendly wrapper: ?assignee=Michelin&keyword=silica&from=2020&to=2024
 */
app.get('/search/patent', async (req, res) => {
  const { assignee, keyword, from, to } = req.query;
  if (!assignee && !keyword) {
    return res.status(400).json({ error: 'At least one of assignee or keyword is required' });
  }

  let q = '';
  if (assignee) q += `assignee:${assignee}`;
  if (keyword) q += (q ? ' AND ' : '') + `(${keyword})`;
  if (from) q += ` AFTER:${from}/01/01`;
  if (to) q += ` BEFORE:${to}/12/31`;

  req.url = `/search/google?q=${encodeURIComponent(q)}&num=${req.query.num || 50}`;
  app._router.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`Patent search proxy listening on port ${PORT}`);
});
