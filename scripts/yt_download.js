/**
 * Puppeteer script: downloads YouTube audio via y2mate.gs
 * Usage: node yt_download.js "<youtube-url>"
 * Output: ./output/audio.mp3
 *
 * Every action is logged so GitHub Actions output shows exactly what happened.
 */

const puppeteer  = require('puppeteer-core');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const http       = require('http');
const { execSync } = require('child_process');

const ytUrl = process.argv[2];
if (!ytUrl) {
  console.error('Usage: node yt_download.js <youtube-url>');
  process.exit(1);
}

const OUTPUT_DIR = path.resolve('./output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function screenshot(page, name) {
  const p = path.join(OUTPUT_DIR, name);
  await page.screenshot({ path: p, fullPage: false }).catch(e => log('WARN', `screenshot failed: ${e.message}`));
  log('SCREENSHOT', name);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    log('DOWNLOAD', `Starting download → ${url.slice(0, 120)}`);
    const out = fs.createWriteStream(dest);
    const get = url.startsWith('https:') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Referer':    'https://y2mate.gs/',
    };
    function doGet(u) {
      get.get(u, { headers }, res => {
        log('DOWNLOAD', `HTTP ${res.statusCode} ${u.slice(0, 80)}`);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          log('DOWNLOAD', `Redirect → ${res.headers.location.slice(0, 80)}`);
          out.close();
          downloadFile(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          out.close();
          reject(new Error('HTTP ' + res.statusCode + ' downloading ' + u));
          return;
        }
        res.pipe(out);
        let downloaded = 0;
        res.on('data', chunk => { downloaded += chunk.length; });
        out.on('finish', () => {
          log('DOWNLOAD', `Done — ${(downloaded / 1024 / 1024).toFixed(2)} MB`);
          out.close();
          resolve();
        });
      }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    }
    doGet(url);
  });
}

// Try to find an element using several selector strategies, returns the first that works
async function findElement(page, strategies) {
  for (const { type, selector, desc } of strategies) {
    try {
      let el = null;
      if (type === 'xpath') {
        const els = await page.$x(selector);
        el = els.length > 0 ? els[0] : null;
      } else if (type === 'css') {
        el = await page.$(selector);
      } else if (type === 'eval') {
        el = await page.evaluateHandle(selector);
        const valid = el && await page.evaluate(e => e !== null && e !== undefined && e.tagName !== undefined, el).catch(() => false);
        if (!valid) el = null;
      }
      if (el) {
        log('FIND', `Found via ${type}: ${desc}`);
        return el;
      }
    } catch (_) {}
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {

  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH
    || execSync('which chromium-browser || which chromium || which google-chrome 2>/dev/null').toString().trim();

  log('INIT', `Browser: ${execPath}`);
  log('INIT', `YouTube URL: ${ytUrl}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  let capturedAudioUrl = null;
  let newTabUrl        = null;

  // Intercept audio responses
  page.on('response', response => {
    const url = response.url();
    const ct  = (response.headers()['content-type']  || '').toLowerCase();
    const cd  = (response.headers()['content-disposition'] || '').toLowerCase();
    if (ct.includes('audio/') || cd.includes('attachment') || /\.(mp3|m4a|ogg|webm)(\?|$)/.test(url)) {
      capturedAudioUrl = url;
      log('INTERCEPT', `Audio URL captured: ${url.slice(0, 100)}`);
    }
  });

  // Watch for new tabs
  browser.on('targetcreated', async target => {
    await sleep(1500);
    newTabUrl = target.url();
    log('NEWTAB', `Opened: ${newTabUrl.slice(0, 100)}`);
  });

  // ── Step 1: Navigate ──────────────────────────────────────────────────────
  log('1/6', 'Navigating to y2mate.gs...');
  await page.goto('https://y2mate.gs', { waitUntil: 'networkidle2', timeout: 40_000 });
  log('1/6', `Page title: "${await page.title()}"`);
  await screenshot(page, '01_home.png');

  // ── Step 2: Find the URL input ────────────────────────────────────────────
  log('2/6', 'Looking for URL input field...');
  const inputEl = await findElement(page, [
    { type: 'xpath', selector: '/html/body/form/div[2]/input', desc: 'XPath form input' },
    { type: 'css',   selector: 'input[type="text"]',           desc: 'CSS input[type=text]' },
    { type: 'css',   selector: 'input[name="url"]',            desc: 'CSS input[name=url]' },
    { type: 'css',   selector: 'input[placeholder]',           desc: 'CSS input[placeholder]' },
    { type: 'css',   selector: 'form input',                   desc: 'CSS form input (any)' },
    { type: 'eval',  selector: () => document.querySelector('input') || null, desc: 'first input on page' },
  ]);

  if (!inputEl) {
    await screenshot(page, '02_no_input.png');
    // Dump all inputs for debugging
    const inputs = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map(i =>
        `<${i.tagName} type="${i.type}" name="${i.name}" placeholder="${i.placeholder}">`).join('\n')
    );
    log('DEBUG', `All inputs on page:\n${inputs || '(none)'}`);
    throw new Error('URL input not found — y2mate.gs layout may have changed');
  }

  // ── Step 3: Fill the URL input ────────────────────────────────────────────
  log('3/6', `Clicking & typing YouTube URL into input...`);
  await inputEl.click({ clickCount: 3 });
  await sleep(300);
  await page.keyboard.type(ytUrl);
  await sleep(300);
  const typedValue = await page.evaluate(el => el.value, inputEl).catch(() => '?');
  log('3/6', `Input value after typing: "${typedValue}"`);
  await screenshot(page, '03_typed.png');

  // ── Step 4: Click the Convert / Search button ────────────────────────────
  log('4/6', 'Looking for Convert/Search button...');
  const convertBtn = await findElement(page, [
    { type: 'xpath', selector: '/html/body/form/div[3]/button',                        desc: 'XPath form button' },
    { type: 'xpath', selector: '/html/body/form/div[3]/button[1]',                     desc: 'XPath form button[1]' },
    { type: 'css',   selector: 'form button[type="submit"]',                           desc: 'CSS form submit button' },
    { type: 'css',   selector: 'form button',                                          desc: 'CSS form button (any)' },
    { type: 'eval',  selector: () => {
        const btns = [...document.querySelectorAll('button,input[type=submit]')];
        return btns.find(b =>
          /search|convert|go|start/i.test(b.textContent + b.value + b.getAttribute('aria-label') || '')
        ) || btns[0] || null;
    }, desc: 'button by text/aria' },
  ]);

  if (!convertBtn) {
    await screenshot(page, '04_no_convert_btn.png');
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll('button,input[type=submit]')].map(b =>
        `<${b.tagName} type="${b.type}">${b.textContent.trim().slice(0,30)}`).join('\n')
    );
    log('DEBUG', `All buttons:\n${btns || '(none)'}`);
    throw new Error('Convert button not found');
  }

  log('4/6', 'Clicking Convert button...');
  await convertBtn.click();
  await sleep(500);
  await screenshot(page, '04_after_convert_click.png');

  // ── Step 5: Wait for conversion result — poll every 500ms instead of fixed sleeps ──
  log('5/6', 'Polling for download button (max 80s, checking every 500ms)...');

  let audioUrl    = null;
  let downloadBtn = null;
  const POLL_INTERVAL = 500;
  const MAX_WAIT_MS   = 80_000;
  const started       = Date.now();
  let attempt         = 0;

  while (Date.now() - started < MAX_WAIT_MS) {
    attempt++;
    await sleep(POLL_INTERVAL);

    // 1. Try to read audio URL directly from DOM (most reliable)
    audioUrl = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.href || '';
        if (/\.(mp3|m4a|ogg|webm)(\?|$)/i.test(h) || h.includes('download')) return h;
      }
      for (const el of document.querySelectorAll('[data-url],[data-href],[data-link],[data-download]')) {
        for (const attr of ['data-url','data-href','data-link','data-download']) {
          const v = el.getAttribute(attr);
          if (v && v.startsWith('http')) return v;
        }
      }
      return null;
    });

    if (audioUrl) {
      log('5/6', `Audio URL found in DOM after ${((Date.now()-started)/1000).toFixed(1)}s: ${audioUrl.slice(0,100)}`);
      break;
    }

    // 2. Check if a download button is visible now
    downloadBtn = await findElement(page, [
      // y2mate typically shows an <a> or <button> with mp3 text
      { type: 'eval', selector: () => {
          const all = [...document.querySelectorAll('a,button,input[type=button],input[type=submit]')];
          return all.find(el => {
            const t = (el.textContent + (el.getAttribute('aria-label')||'')).toLowerCase();
            return t.includes('download') || t.includes('mp3') || t.includes('audio');
          }) || null;
      }, desc: 'button/link with download|mp3|audio text' },
      { type: 'xpath', selector: '//a[contains(@class,"download")]',          desc: 'XPath a.download' },
      { type: 'xpath', selector: '//button[contains(@class,"download")]',     desc: 'XPath button.download' },
      { type: 'css',   selector: 'a.download, a[href*="download"]',          desc: 'CSS a.download or href*=download' },
      { type: 'css',   selector: '.result a, .result button',                desc: 'CSS .result a/button' },
    ]);

    if (downloadBtn) {
      log('5/6', `Download button found after ${((Date.now()-started)/1000).toFixed(1)}s`);
      break;
    }

    // Take a screenshot + dump page text every ~15s to help with debugging
    const elapsed = Date.now() - started;
    if (elapsed > 0 && Math.floor(elapsed / 15_000) !== Math.floor((elapsed - POLL_INTERVAL) / 15_000)) {
      await screenshot(page, `05_at_${Math.floor(elapsed/1000)}s.png`);
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 400));
      log('DEBUG', `t=${Math.floor(elapsed/1000)}s — page: "${await page.title()}" — text: ${txt.replace(/\n/g,' ').slice(0,200)}`);
    }
  }
  log('5/6', `Poll finished — elapsed: ${((Date.now()-started)/1000).toFixed(1)}s, attempts: ${attempt}`);

  await screenshot(page, '05_after_wait.png');

  // ── Step 6: Download the audio ────────────────────────────────────────────
  log('6/6', 'Attempting to obtain download URL...');
  const dest = path.join(OUTPUT_DIR, 'audio.mp3');

  if (audioUrl) {
    log('6/6', `Downloading from DOM URL: ${audioUrl.slice(0,100)}`);
    await downloadFile(audioUrl, dest);

  } else if (downloadBtn) {
    const btnUrl = await page.evaluate(el => {
      return el.href || el.getAttribute('data-url') || el.getAttribute('data-href') || null;
    }, downloadBtn);
    log('6/6', `Download button data URL: ${btnUrl || '(none)'}`);

    if (btnUrl && btnUrl.startsWith('http')) {
      await downloadFile(btnUrl, dest);
    } else {
      log('6/6', 'Clicking download button...');
      await downloadBtn.click();
      await sleep(10_000);
      await screenshot(page, '06_after_dl_click.png');
    }

  } else if (capturedAudioUrl) {
    log('6/6', `Downloading from intercepted network URL: ${capturedAudioUrl.slice(0,100)}`);
    await downloadFile(capturedAudioUrl, dest);

  } else if (newTabUrl && newTabUrl.startsWith('http') && !newTabUrl.includes('y2mate.gs')) {
    log('6/6', `Downloading from new-tab URL: ${newTabUrl.slice(0,100)}`);
    await downloadFile(newTabUrl, dest);

  } else {
    await screenshot(page, '06_nothing_found.png');
    throw new Error(
      'No audio URL found after 80s of polling.\n' +
      'Check screenshots (01_home.png … 05_at_*.png) uploaded as debug-screenshots artifact.'
    );
  }

  await browser.close();

  // ── Verify ────────────────────────────────────────────────────────────────
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => /\.(mp3|m4a|webm|ogg)$/i.test(f));
  if (files.length > 0 && !files.includes('audio.mp3')) {
    fs.renameSync(path.join(OUTPUT_DIR, files[0]), dest);
    log('DONE', `Renamed ${files[0]} → audio.mp3`);
  }

  if (!fs.existsSync(dest)) {
    throw new Error('audio.mp3 still missing after all attempts');
  }

  const size = fs.statSync(dest).size;
  log('DONE', `File size: ${(size / 1024 / 1024).toFixed(2)} MB`);
  if (size < 102_400) throw new Error(`audio.mp3 is too small (${size} bytes) — download likely failed`);

})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
