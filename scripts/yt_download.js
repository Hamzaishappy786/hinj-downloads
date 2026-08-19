/**
 * Puppeteer script: downloads a YouTube video's audio via y2mate.gs.
 * Usage: node yt_download.js "<youtube-url>"
 * Output: ./output/audio.mp3
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const http      = require('http');

const ytUrl = process.argv[2];
if (!ytUrl) {
  console.error('Usage: node yt_download.js <youtube-url>');
  process.exit(1);
}

const OUTPUT_DIR = path.resolve('./output');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const out     = fs.createWriteStream(dest);
    const get     = url.startsWith('https:') ? https : http;
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://y2mate.gs/' };
    get.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.close();
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        out.close();
        reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
        return;
      }
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 800 }
  });

  const page = await browser.newPage();

  // Intercept any audio/mp3 response URL as a fallback
  let capturedAudioUrl = null;
  page.on('response', response => {
    const url = response.url();
    const ct  = (response.headers()['content-type'] || '').toLowerCase();
    const cd  = (response.headers()['content-disposition'] || '').toLowerCase();
    if (ct.includes('audio/') || cd.includes('.mp3') ||
        (url.includes('.mp3') && !url.includes('favicon'))) {
      capturedAudioUrl = url;
      console.log('[intercept] Captured audio URL:', url);
    }
  });

  // Enable browser-level downloads to OUTPUT_DIR
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: OUTPUT_DIR
  });

  console.log('[1/4] Navigating to y2mate.gs...');
  await page.goto('https://y2mate.gs', { waitUntil: 'networkidle2', timeout: 30_000 });

  // Fill in the YouTube URL (XPath from user's instructions)
  console.log('[2/4] Entering YouTube URL:', ytUrl);
  const [urlInput] = await page.$x('/html/body/form/div[2]/input');
  if (!urlInput) throw new Error('URL input field not found — y2mate.gs layout may have changed');
  await urlInput.click({ clickCount: 3 });
  await page.keyboard.type(ytUrl);

  // Click the Convert / Search button
  const [convertBtn] = await page.$x('/html/body/form/div[3]/button');
  if (!convertBtn) throw new Error('Convert button not found');
  await convertBtn.click();

  // Wait for y2mate to process (conversion takes 10–20 seconds)
  console.log('[3/4] Waiting 18 seconds for conversion...');
  await new Promise(r => setTimeout(r, 18_000));

  // Click the Download button
  const [downloadBtn] = await page.$x('/html/body/form/div[3]/button[2]');
  if (!downloadBtn) throw new Error('Download button not found — conversion may have failed or taken longer than expected');
  await downloadBtn.click();

  // Wait for the file to land in OUTPUT_DIR
  console.log('[4/4] Waiting for file download...');
  await new Promise(r => setTimeout(r, 10_000));

  await browser.close();

  // Check for a downloaded file
  const files = fs.readdirSync(OUTPUT_DIR).filter(f =>
    /\.(mp3|m4a|webm|ogg)$/.test(f.toLowerCase()));

  const dest = path.join(OUTPUT_DIR, 'audio.mp3');

  if (files.length > 0) {
    const src = path.join(OUTPUT_DIR, files[0]);
    if (src !== dest) fs.renameSync(src, dest);
    const size = fs.statSync(dest).size;
    console.log('Done! Saved to', dest, '—', (size / 1024 / 1024).toFixed(1), 'MB');
  } else if (capturedAudioUrl) {
    console.log('No file via browser download; downloading from intercepted URL...');
    await downloadFile(capturedAudioUrl, dest);
    const size = fs.statSync(dest).size;
    console.log('Done! Saved to', dest, '—', (size / 1024 / 1024).toFixed(1), 'MB');
  } else {
    throw new Error(
      'No audio file was downloaded.\n' +
      'Possible causes:\n' +
      '  • y2mate.gs needs more time (try increasing the wait to 25s)\n' +
      '  • The video is age-restricted or unavailable\n' +
      '  • y2mate.gs changed its page layout (check the XPaths)\n' +
      'Check the uploaded screenshot artifact for what the page looked like.'
    );
  }
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
