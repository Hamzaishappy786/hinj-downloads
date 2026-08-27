/**
 * Puppeteer script: downloads YouTube audio via y2mate.gs
 * Usage: node yt_download.js "<youtube-url>"
 * Output: ./output/audio.mp3
 */

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const http      = require('http');
const { execSync } = require('child_process');

const ytUrl = process.argv[2];
if (!ytUrl) {
  console.error('Usage: node yt_download.js <youtube-url>');
  process.exit(1);
}

const OUTPUT_DIR = path.resolve('./output');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const get = url.startsWith('https:') ? https : http;
    const headers = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', 'Referer': 'https://y2mate.gs/' };
    get.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.close();
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        out.close();
        reject(new Error('HTTP ' + res.statusCode + ' downloading ' + url));
        return;
      }
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH
    || execSync('which chromium-browser || which chromium || which google-chrome').toString().trim();

  console.log('Using browser:', execPath);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 }
  });

  const page = await browser.newPage();
  let capturedAudioUrl = null;

  // Intercept any audio/download responses
  page.on('response', response => {
    const url  = response.url();
    const ct   = (response.headers()['content-type']  || '').toLowerCase();
    const cd   = (response.headers()['content-disposition'] || '').toLowerCase();
    if (ct.includes('audio/') || cd.includes('attachment') || /\.(mp3|m4a|ogg|webm)(\?|$)/.test(url)) {
      capturedAudioUrl = url;
      console.log('[intercept] Audio URL captured:', url);
    }
  });

  // Watch for new tabs opened by the download button
  let newTabUrl = null;
  browser.on('targetcreated', async target => {
    await new Promise(r => setTimeout(r, 1500));
    newTabUrl = target.url();
    console.log('[newtab] Opened:', newTabUrl);
  });

  console.log('[1/5] Navigating to y2mate.gs...');
  await page.goto('https://y2mate.gs', { waitUntil: 'networkidle2', timeout: 30_000 });

  console.log('[2/5] Entering YouTube URL:', ytUrl);
  const [urlInput] = await page.$x('/html/body/form/div[2]/input');
  if (!urlInput) {
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'error_no_input.png') });
    throw new Error('URL input not found — y2mate.gs layout may have changed');
  }
  await urlInput.click({ clickCount: 3 });
  await page.keyboard.type(ytUrl);

  const [convertBtn] = await page.$x('/html/body/form/div[3]/button');
  if (!convertBtn) throw new Error('Convert button not found');
  await convertBtn.click();

  console.log('[3/5] Waiting for conversion (20s)...');
  await new Promise(r => setTimeout(r, 20_000));

  // Take screenshot so we can see what happened
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'after_conversion.png') });

  // Try to find the download URL directly from the page DOM (most reliable)
  console.log('[4/5] Looking for download link in page...');
  const audioUrl = await page.evaluate(() => {
    // Check all anchor tags for mp3/audio hrefs
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';
      if (/\.(mp3|m4a|ogg|webm)(\?|$)/i.test(href) || href.includes('download')) return href;
    }
    // Check buttons with data-url or onclick containing a URL
    for (const btn of document.querySelectorAll('button, a')) {
      const attrs = ['data-url', 'data-href', 'data-link', 'data-download'];
      for (const attr of attrs) {
        const val = btn.getAttribute(attr);
        if (val && val.startsWith('http')) return val;
      }
    }
    // Check forms for action URLs pointing to audio
    for (const form of document.querySelectorAll('form')) {
      const action = form.action || '';
      if (action.includes('download') || /\.(mp3|m4a)/.test(action)) return action;
    }
    return null;
  });

  if (audioUrl) {
    console.log('[4/5] Found audio URL in DOM:', audioUrl);
    console.log('[5/5] Downloading...');
    await downloadFile(audioUrl, path.join(OUTPUT_DIR, 'audio.mp3'));
  } else {
    // Fall back: click the download button and wait for a response
    console.log('[4/5] No URL in DOM, clicking download button...');
    let dlBtn = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const btns = await page.$x('/html/body/form/div[3]/button[2]');
      if (btns.length > 0) { dlBtn = btns[0]; break; }
      console.log(`  Waiting 5s for download button (attempt ${attempt + 1}/4)...`);
      await new Promise(r => setTimeout(r, 5_000));
    }

    if (dlBtn) {
      // Get the href/action before clicking
      const btnUrl = await page.evaluate(btn => {
        return btn.getAttribute('data-url') || btn.getAttribute('data-href')
          || btn.getAttribute('data-link') || btn.closest('a')?.href || null;
      }, dlBtn);
      console.log('Button data URL:', btnUrl);

      await dlBtn.click();
      await new Promise(r => setTimeout(r, 8_000));
      await page.screenshot({ path: path.join(OUTPUT_DIR, 'after_click.png') });
    }
  }

  await browser.close();

  // Check if file was downloaded via browser or captured
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => /\.(mp3|m4a|webm|ogg)$/.test(f.toLowerCase()));

  const dest = path.join(OUTPUT_DIR, 'audio.mp3');

  if (files.length > 0 && !files.includes('audio.mp3')) {
    fs.renameSync(path.join(OUTPUT_DIR, files[0]), dest);
    console.log('Done! Renamed', files[0], 'to audio.mp3');
  } else if (files.includes('audio.mp3')) {
    console.log('Done! audio.mp3 already saved.');
  } else if (capturedAudioUrl) {
    console.log('[5/5] Downloading from intercepted URL...');
    await downloadFile(capturedAudioUrl, dest);
    console.log('Done!');
  } else if (newTabUrl && newTabUrl.startsWith('http') && newTabUrl !== 'https://y2mate.gs/') {
    console.log('[5/5] Downloading from new tab URL:', newTabUrl);
    await downloadFile(newTabUrl, dest);
    console.log('Done!');
  } else {
    throw new Error(
      'No audio file was found.\n' +
      'Check the uploaded screenshot artifacts (after_conversion.png, after_click.png)\n' +
      'to see what the page looked like.'
    );
  }

  const size = fs.statSync(dest).size;
  console.log('File size:', (size / 1024 / 1024).toFixed(2), 'MB');
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
