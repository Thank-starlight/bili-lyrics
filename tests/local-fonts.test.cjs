const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const script = fs.readFileSync(path.join(__dirname, '../bili-lyrics.user.js'), 'utf8');
const executablePath = process.env.BILI_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(file => fs.existsSync(file));

async function fixture(page) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.bilibili.com') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8') });
    const data = url.pathname.endsWith('/nav') ? { isLogin: true, wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    } } : url.pathname.endsWith('/wbi/v2') ? { aid: 1, cid: 11, subtitle: { subtitles: [{ lan: 'zh', subtitle_url: '//aisubtitle.hdslb.com/font-test.json' }] } }
      : { aid: 1, bvid: 'BV1XfD7BeEve', title: 'Font test', pages: [{ page: 1, cid: 11, part: 'Test' }] };
    await route.fulfill({ contentType: 'application/json', headers: {
      'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true',
    }, body: JSON.stringify(url.hostname === 'aisubtitle.hdslb.com'
      ? { body: [{ from: 0, to: 20, content: '用于验证本机字体选择的字幕' }] } : { code: 0, data }) });
  });
}

async function openPanel(page) {
  await page.goto('https://www.bilibili.com/video/BV1XfD7BeEve/');
  await page.addScriptTag({ content: script });
  const panel = page.locator('#bili-lyrics-panel');
  await panel.locator('.head').click();
  await panel.locator('.cue').waitFor();
  await panel.locator('.font-toggle').click();
  return panel;
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await fixture(page);
    await page.addInitScript(() => {
      window.unsafeWindow = window;
      window.fontCalls = 0;
      window.fontMode = 'allowed';
      window.fakeFontQuery = async function () {
        if (this !== window) throw Error('Invalid Window receiver');
        window.fontCalls++;
        window.fontHadActivation = navigator.userActivation.isActive;
        if (window.fontMode === 'denied') throw new DOMException('Denied', 'NotAllowedError');
        if (window.fontMode === 'failed') throw Error('Font service failed');
        if (window.fontMode === 'empty') return [];
        return [{ family: 'Alpha Sans', style: 'Regular' }, { family: 'Alpha Sans', style: 'Bold' },
          { family: 'Beta Serif', style: 'Regular' }, { family: '霞鹜文楷', style: 'Regular' }];
      };
      window.queryLocalFonts = window.fakeFontQuery;
    });
    let panel = await openPanel(page);
    assert.equal(await page.evaluate(() => window.fontCalls), 0, 'no font query before explicit click');
    await panel.locator('.font-read').click();
    await panel.locator('.font-read-status').filter({ hasText: '已读取 3 种字体' }).waitFor();
    assert.equal(await page.evaluate(() => window.fontHadActivation), true);
    assert.equal(await panel.locator('optgroup option').count(), 3, 'deduplicate font-family styles');
    await panel.locator('.font-preset').selectOption('local:Alpha Sans');
    assert.match(await panel.locator('.cue span').evaluate(el => getComputedStyle(el).fontFamily), /Alpha Sans/);
    assert.equal(await panel.locator('.custom-font-field').isVisible(), false);
    await panel.locator('.local-font-search').fill('Beta');
    assert.equal(await panel.locator('optgroup option').count(), 2, 'retain selected font while filtering');
    await panel.locator('.font-preset').selectOption('local:Beta Serif');
    const saved = await page.evaluate(() => localStorage.getItem('bili-lyrics:panel:v1'));
    assert.equal(JSON.parse(saved).fontFamily, 'Beta Serif');
    assert.ok(!saved.includes('Alpha Sans'), 'do not persist the font inventory');
    panel = await openPanel(page);
    assert.equal(await page.evaluate(() => window.fontCalls), 0, 'reload restores selected font without querying');
    assert.equal(await panel.locator('.font-preset').inputValue(), 'local:Beta Serif');
    assert.equal(await panel.locator('optgroup option').count(), 1);
    await page.evaluate(() => { window.queryLocalFonts = undefined; });
    await panel.locator('.font-read').click();
    await panel.locator('.font-read-status').filter({ hasText: '不支持' }).waitFor();
    await page.evaluate(() => { window.queryLocalFonts = window.fakeFontQuery; window.fontMode = 'denied'; });
    await panel.locator('.font-read').click();
    await panel.locator('.font-read-status').filter({ hasText: '访问权限' }).waitFor();
    assert.equal(await panel.locator('.font-read').isDisabled(), false);
    assert.equal(await panel.locator('.font-preset').inputValue(), 'local:Beta Serif');
    await page.evaluate(() => { window.fontMode = 'empty'; });
    await panel.locator('.font-read').click();
    await panel.locator('.font-read-status').filter({ hasText: '没有返回' }).waitFor();
    await page.evaluate(() => { window.fontMode = 'failed'; });
    await panel.locator('.font-read').click();
    await panel.locator('.font-read-status').filter({ hasText: '读取本机字体失败' }).waitFor();
    await page.evaluate(() => { window.fontMode = 'allowed'; });
    await panel.locator('.font-read').click();
    await panel.locator('.font-read-status').filter({ hasText: '已读取 3 种字体' }).waitFor();
    await panel.locator('.font-preset').selectOption('local:霞鹜文楷');
    await panel.locator('.theme').click();
    fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../test-results/panel-local-fonts.png') });
    await panel.locator('.font-reset').click();
    assert.equal(await panel.locator('.font-preset').inputValue(), 'system');
    assert.equal(await panel.locator('optgroup option').count(), 3);
    assert.deepEqual(errors, []);
    console.log('Local font checks passed: click permission flow, grouped families, search, selection, persistence, unsupported/denied/empty/error cases and retry.');
    await page.close();

    if (process.env.BILI_NATIVE_FONT_TEST === '1') {
      const nativePage = await browser.newPage();
      await fixture(nativePage);
      const nativePanel = await openPanel(nativePage);
      assert.equal(await nativePage.evaluate(() => typeof window.queryLocalFonts), 'function');
      const session = await nativePage.context().newCDPSession(nativePage);
      const { targetInfo } = await session.send('Target.getTargetInfo');
      await session.send('Browser.grantPermissions', { origin: 'https://www.bilibili.com', permissions: ['localFonts'], browserContextId: targetInfo.browserContextId });
      await nativePanel.locator('.font-read').click();
      await nativePanel.locator('.font-read-status').filter({ hasText: /^已读取 \d+ 种字体/ }).waitFor();
      const count = await nativePanel.locator('optgroup option').count();
      assert.ok(count > 0);
      const value = await nativePanel.locator('optgroup option').first().getAttribute('value');
      await nativePanel.locator('.font-preset').selectOption(value);
      assert.equal(await nativePanel.locator('.font-preset').inputValue(), value);
      console.log(`Native browser API verified: ${count} font families enumerated and a font selected in an isolated test context.`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
