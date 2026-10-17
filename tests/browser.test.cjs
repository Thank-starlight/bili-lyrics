const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../bili-lyrics.user.js'), 'utf8');
const browserPath = process.env.BILI_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

(async () => {
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let loggedIn = true, empty = false, mismatch = false, failCdn = false, wbiAttempts = 0, refreshOnce = false;
    const requests = [];
    const cueBody = Array.from({ length: 90 }, (_, i) => ({ from: i * 4, to: i * 4 + 3,
      content: i === 5 ? '<img src=x onerror="alert(1)">' : `第 ${i + 1} 句：这是一段用于验证滚动、跟随和时间跳转的演示字幕。` }));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'www.bilibili.com') {
        return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8') });
      }
      requests.push(url.href);
      let result;
      if (url.pathname.endsWith('/view')) {
        result = { code: 0, data: { aid: 116369354066626, bvid: 'BV1XfD7BeEve', title: '交互测试', pages: [
          { page: 1, cid: 37340840295, part: '第一部分' }, { page: 2, cid: 37340908975, part: '第二部分' },
        ] } };
      } else if (url.pathname.endsWith('/nav')) {
        result = { code: loggedIn ? 0 : -101, data: { isLogin: loggedIn, wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
        } } };
      } else if (url.pathname.endsWith('/wbi/v2')) {
        wbiAttempts++;
        assert.match(url.searchParams.get('w_rid'), /^[a-f\d]{32}$/);
        if (refreshOnce) { refreshOnce = false; result = { code: -403 }; }
        else result = { code: 0, data: { aid: 116369354066626, cid: mismatch ? 1 : Number(url.searchParams.get('cid')),
          need_login_subtitle: !loggedIn, subtitle: { subtitles: empty ? [] : [
            { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/test/zh.json' },
            { lan: 'en', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/test/en.json' },
          ] } } };
      } else if (url.hostname === 'aisubtitle.hdslb.com') {
        if (failCdn) return route.fulfill({ status: 403, body: 'expired' });
        result = { body: url.pathname.endsWith('en.json') ? [{ from: 0.125, to: 4.875, content: 'English subtitles' }] : cueBody };
      } else throw new Error('Unexpected request: ' + url.href);
      return route.fulfill({ contentType: 'application/json', headers: {
        'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true',
      }, body: JSON.stringify(result) });
    });
    await page.goto('https://www.bilibili.com/video/BV1XfD7BeEve/');
    await page.addScriptTag({ content: script });
    const panel = page.locator('#bili-lyrics-panel');
    const head = panel.locator('.head');
    const cues = panel.locator('.cue');
    const expectText = async (locator, pattern) => {
      await locator.filter({ hasText: pattern }).waitFor();
    };
    assert.equal(requests.length, 0, 'collapsed panel must not request data');
    await head.click();
    await cues.nth(89).waitFor();
    assert.equal(await cues.count(), 90);
    assert.equal(await panel.evaluate(el => el.parentElement === document.body), true, 'panel must stay outside the site Vue tree');
    assert.equal(await panel.locator('.cue img').count(), 0, 'subtitle HTML must remain text');
    await page.evaluate(() => { document.querySelector('video').currentTime = 176.25; });
    await expectText(panel.locator('[aria-current="true"]'), /第 45 句/);
    await page.waitForFunction(() => document.querySelector('#bili-lyrics-panel').shadowRoot.querySelector('.list').scrollTop > 100);
    fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../test-results/panel-preview.png') });
    await panel.locator('.list').dispatchEvent('wheel', { deltaY: 200 });
    assert.equal(await panel.locator('.follow').getAttribute('aria-pressed'), 'false');
    await panel.locator('.follow').click();
    assert.equal(await panel.locator('.follow').getAttribute('aria-pressed'), 'true');
    await cues.nth(12).click();
    assert.equal(await page.evaluate(() => document.querySelector('video').currentTime), 48);
    assert.equal(await page.evaluate(() => window.playCount), 1);
    await page.evaluate(() => { document.querySelector('video').currentTime = 51.5; });
    assert.equal(await panel.locator('[aria-current="true"]').count(), 0, 'silent gap clears highlight');
    await panel.locator('.search').fill('第 70 句');
    assert.equal(await panel.locator('.cue:visible').count(), 1);
    await expectText(panel.locator('.count'), /1 \/ 90/);
    await panel.locator('.follow').click();
    assert.equal(await panel.locator('.search').inputValue(), '');
    assert.equal(await panel.locator('.cue:visible').count(), 90);
    await head.click();
    assert.equal(await panel.locator('.body').isVisible(), false);
    const countBeforeExpand = requests.length;
    await head.click();
    assert.equal(requests.length, countBeforeExpand, 'reopen uses current data');
    await panel.locator('select').selectOption('1');
    await expectText(cues, /English subtitles/);
    const downloadPromise = page.waitForEvent('download');
    await panel.locator('.export').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /BV1XfD7BeEve_P1_en\.srt/);
    const srt = fs.readFileSync(await download.path(), 'utf8');
    assert.match(srt, /00:00:00,125 --> 00:00:04,875/);
    await page.evaluate(() => history.pushState({}, '', '?p=2'));
    await cues.nth(89).waitFor();
    assert.ok(requests.some(url => url.includes('cid=37340908975')));
    // Replaced player nodes must reconnect their events.
    await page.evaluate(() => { window.makePlayer(); document.querySelector('video').currentTime = 24; });
    await expectText(panel.locator('[aria-current="true"]'), /第 7 句/);
    empty = true; loggedIn = false;
    await panel.locator('.reload').click();
    await expectText(panel.locator('.status'), /请先在 B 站登录/);
    assert.equal(await cues.count(), 0);
    assert.equal(await panel.locator('.export').isDisabled(), true);
    empty = false; loggedIn = true; mismatch = true;
    await panel.locator('.reload').click();
    await expectText(panel.locator('.status'), /编号不匹配/);
    assert.equal(await cues.count(), 0);
    mismatch = false; refreshOnce = true;
    const attempts = wbiAttempts;
    await panel.locator('.reload').click();
    await cues.nth(89).waitFor();
    assert.equal(wbiAttempts - attempts, 2, 'signature retry is bounded');
    failCdn = true;
    await panel.locator('select').selectOption('1');
    await expectText(panel.locator('.status'), /HTTP 403/);
    assert.equal(await cues.count(), 0, 'failed track must not leave old text clickable');
    failCdn = false;
    await panel.locator('.reload').click();
    await cues.nth(89).waitFor();
    // A slow previous-track response must not replace a newer selection.
    let release;
    let requested;
    const started = new Promise(resolve => { requested = resolve; });
    await page.route('**/test/en.json', async route => {
      requested();
      await new Promise(resolve => { release = resolve; });
      await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ body: [{ from: 0, to: 1, content: 'STALE' }] }) });
    });
    await panel.locator('select').selectOption('1');
    await started;
    await panel.locator('select').selectOption('0');
    await cues.nth(89).waitFor();
    release();
    await page.waitForTimeout(100);
    assert.equal(await cues.count(), 90);
    assert.equal(await panel.getByText('STALE', { exact: true }).count(), 0);
    const drag = async (locator, dx, dy, offset = null) => {
      const box = await locator.boundingBox();
      const x = box.x + (offset?.x ?? box.width / 2);
      const y = box.y + (offset?.y ?? box.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      await page.mouse.up();
    };
    const beforeDrag = await panel.boundingBox();
    await drag(panel.locator('.header'), -240, -150, { x: 110, y: 34 });
    const afterDrag = await panel.boundingBox();
    assert.ok(Math.abs(afterDrag.x - (beforeDrag.x - 240)) < 2);
    assert.ok(Math.abs(afterDrag.y - (beforeDrag.y - 150)) < 2);
    assert.equal(await head.getAttribute('aria-expanded'), 'true', 'dragging must not collapse the panel');
    await drag(panel.locator('[data-edge="se"]'), 140, 50);
    const afterResize = await panel.boundingBox();
    assert.ok(Math.abs(afterResize.width - afterDrag.width - 140) < 2);
    assert.ok(Math.abs(afterResize.height - afterDrag.height - 50) < 2);
    await drag(panel.locator('[data-edge="nw"]'), -60, -40);
    const resized = await panel.boundingBox();
    assert.ok(Math.abs(resized.x - (afterResize.x - 60)) < 2);
    assert.ok(Math.abs(resized.height - afterResize.height - 40) < 2);
    await panel.locator('.theme').click();
    assert.equal(await panel.getAttribute('data-theme'), 'dark');
    assert.equal(await panel.locator('.card').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(23, 30, 42)');
    assert.equal(await head.getAttribute('aria-expanded'), 'true', 'theme button must not collapse the panel');
    await page.evaluate(() => { document.querySelector('video').currentTime = 176.25; });
    await expectText(panel.locator('[aria-current="true"]'), /第 45 句/);
    await page.screenshot({ path: path.join(__dirname, '../test-results/panel-dark-resized.png') });
    await panel.locator('.theme').click();
    assert.equal(await panel.getAttribute('data-theme'), 'light');
    await panel.locator('.theme').click();
    await page.reload();
    await page.addScriptTag({ content: script });
    assert.equal(await panel.getAttribute('data-theme'), 'dark', 'theme is restored on reload');
    const restoredCollapsed = await panel.boundingBox();
    assert.ok(Math.abs(restoredCollapsed.x - resized.x) < 2);
    assert.ok(Math.abs(restoredCollapsed.width - resized.width) < 2);
    await head.click();
    await cues.nth(89).waitFor();
    const restored = await panel.boundingBox();
    assert.ok(Math.abs(restored.height - resized.height) < 2, 'expanded height is restored');
    await page.setViewportSize({ width: 480, height: 540 });
    await page.waitForFunction(() => {
      const rect = document.querySelector('#bili-lyrics-panel').getBoundingClientRect();
      return rect.x >= 11 && rect.y >= 11 && rect.right <= innerWidth - 11 && rect.bottom <= innerHeight - 11;
    });
    const small = await panel.boundingBox();
    assert.ok(small.x >= 11 && small.y >= 11 && small.x + small.width <= 469 && small.y + small.height <= 529,
      'panel must remain reachable on a smaller viewport');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => document.querySelector('#bili-lyrics-panel').getBoundingClientRect().width > 480);
    await drag(panel.locator('.header'), -1400, -900, { x: 100, y: 34 });
    const clamped = await panel.boundingBox();
    assert.equal(clamped.x, 12); assert.equal(clamped.y, 12);
    await panel.locator('.reset-layout').click();
    const reset = await panel.boundingBox();
    assert.equal(reset.width, 350); assert.equal(reset.height, 620);
    assert.equal(reset.x, 912); assert.equal(reset.y, 260);
    assert.equal(await panel.getAttribute('data-theme'), 'dark', 'position reset preserves the chosen theme');
    await page.evaluate(() => { document.querySelector('.right-container').remove(); });
    await page.waitForFunction(() => document.querySelector('#bili-lyrics-panel')?.hasAttribute('floating'));
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: subtitle interactions, errors/races, drag without collapse, two-corner resize, dark/light theme, saved geometry/theme, viewport clamping, reset and floating mount.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
