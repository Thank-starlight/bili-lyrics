// ==UserScript==
// @name         B站滚动字幕 · Bili Lyrics
// @namespace    local.bili-lyrics
// @version      1.2.0
// @homepageURL  https://github.com/Thank-starlight/bili-lyrics
// @supportURL   https://github.com/Thank-starlight/bili-lyrics/issues
// @updateURL    https://raw.githubusercontent.com/Thank-starlight/bili-lyrics/main/bili-lyrics.user.js
// @downloadURL  https://raw.githubusercontent.com/Thank-starlight/bili-lyrics/main/bili-lyrics.user.js
// @description  视频页右侧展开字幕，歌词式跟随、自由滚动、点击跳转、搜索与导出。
// @match        https://www.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @connect      hdslb.com
// @connect      subtitle.bilibili.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

  // RFC 1321 MD5, used only to sign Bilibili's WBI query parameters.
  function md5(text) {
    const bytes = new TextEncoder().encode(text);
    const buffer = new ArrayBuffer(Math.ceil((bytes.length + 9) / 64) * 64);
    const padded = new Uint8Array(buffer);
    const view = new DataView(buffer);
    padded.set(bytes);
    padded[bytes.length] = 128;
    view.setUint32(buffer.byteLength - 8, (bytes.length * 8) >>> 0, true);
    view.setUint32(buffer.byteLength - 4, Math.floor(bytes.length / 536870912), true);
    const shifts = [[7,12,17,22], [5,9,14,20], [4,11,16,23], [6,10,15,21]];
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let offset = 0; offset < buffer.byteLength; offset += 64) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        const round = i >>> 4;
        const f = round === 0 ? (b & c) | (~b & d)
          : round === 1 ? (d & b) | (~d & c)
          : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
        const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16
          : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
        const k = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
        const sum = (a + f + k + view.getUint32(offset + g * 4, true)) | 0;
        const shift = shifts[round][i % 4];
        const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
        a = d; d = c; c = b; b = next;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0;
      c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    const digest = new DataView(new ArrayBuffer(16));
    [a0,b0,c0,d0].forEach((n, i) => digest.setInt32(i * 4, n, true));
    return Array.from(new Uint8Array(digest.buffer), n => n.toString(16).padStart(2, '0')).join('');
  }

  function signWbi(params, img, sub, now = Math.floor(Date.now() / 1000)) {
    if (!/^[a-f\d]{32}$/i.test(img) || !/^[a-f\d]{32}$/i.test(sub)) {
      throw new Error('没有取得有效的 WBI 密钥，请刷新重试。');
    }
    const raw = img + sub;
    const key = MIXIN.map(i => raw[i]).join('').slice(0, 32);
    const values = { ...params, wts: now };
    const query = Object.keys(values).sort().map(k =>
      `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`
    ).join('&');
    return `${query}&w_rid=${md5(query + key)}`;
  }

  function normalizeCues(data) {
    if (!Array.isArray(data.body)) throw new Error('字幕文件格式不受支持（缺少 body）。');
    return data.body.filter(c => typeof c.content === 'string' && c.content.trim()
      && Number.isFinite(c.from) && Number.isFinite(c.to) && c.from >= 0 && c.to > c.from)
      .map(c => ({ from: c.from, to: c.to, content: c.content }))
      .sort((a, b) => a.from - b.from);
  }

  function activeCue(cues, time) {
    let left = 0, right = cues.length - 1, result = -1;
    while (left <= right) {
      const mid = (left + right) >>> 1;
      if (cues[mid].from <= time) { result = mid; left = mid + 1; }
      else right = mid - 1;
    }
    // Prefer the latest starting cue; handle overlapping cues and silent gaps.
    for (let i = result; i >= 0; i--) {
      if (time < cues[i].to) return i;
      // Most subtitle files have no overlaps; bounded work is avoided via prefix ends below.
      if (cues[i]._maxEnd !== undefined && cues[i]._maxEnd <= time) break;
    }
    return -1;
  }

  function clock(seconds, full = false) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
    return `${h || full ? String(h).padStart(2, '0') + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function srtTime(seconds) {
    const ms = Math.round(seconds * 1000);
    return `${clock(Math.floor(ms / 1000), true)},${String(ms % 1000).padStart(3, '0')}`;
  }

  function toSrt(cues) {
    return cues.map((c, i) => `${i + 1}\n${srtTime(c.from)} --> ${srtTime(c.to)}\n${c.content}\n`).join('\n');
  }

  function subtitleUrl(raw) {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (url.protocol !== 'https:' || !(url.hostname.endsWith('.hdslb.com')
      || url.hostname === 'subtitle.bilibili.com')) throw new Error('字幕地址不是受支持的 B 站 CDN。');
    return url.href;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { md5, signWbi, normalizeCues, activeCue, clock, toSrt, subtitleUrl };
    return;
  }

  if (document.getElementById('bili-lyrics-panel')) return;
  const API = 'https://api.bilibili.com';
  let keyCache = null;

  async function requestJSON(url, isApi = true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(url, {
        credentials: isApi ? 'include' : 'omit', signal: controller.signal,
      });
    } catch (error) {
      if (typeof GM_xmlhttpRequest !== 'function') throw new Error('网络请求失败，请检查网络后重试。');
      // Userscript request is a fallback for CORS/network restrictions. The browser
      // supplies Bilibili cookies; no cookie is copied or sent to another service.
      return await new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: 'GET', url, timeout: 15000, anonymous: !isApi,
        headers: isApi ? { Referer: 'https://www.bilibili.com/' } : {},
        onload: result => {
          if (result.status < 200 || result.status >= 300) {
            reject(Object.assign(new Error(`请求失败（HTTP ${result.status}）。`), { status: result.status }));
            return;
          }
          try { resolve(JSON.parse(result.responseText)); }
          catch { reject(new Error('接口没有返回有效 JSON，请稍后重试。')); }
        },
        onerror: () => reject(new Error('网络请求失败，请检查网络后重试。')),
        ontimeout: () => reject(new Error('请求超时，请重试。')),
      }));
    } finally { clearTimeout(timer); }
    if (!response.ok) throw Object.assign(new Error(`请求失败（HTTP ${response.status}）。`), { status: response.status });
    try { return await response.json(); }
    catch { throw new Error('接口没有返回有效 JSON，请稍后重试。'); }
  }

  async function getKeys(force = false) {
    if (!force && keyCache && Date.now() - keyCache.at < 900000) return keyCache;
    const nav = await requestJSON(`${API}/x/web-interface/nav`);
    const images = nav.data?.wbi_img;
    if (!images?.img_url || !images?.sub_url) throw new Error('无法获取 WBI 密钥，请刷新 B 站页面。');
    const name = url => new URL(url).pathname.split('/').pop().split('.')[0];
    keyCache = { img: name(images.img_url), sub: name(images.sub_url), loggedIn: !!nav.data.isLogin, at: Date.now() };
    return keyCache;
  }

  async function playerInfo(info) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const keys = await getKeys(attempt > 0);
      try {
        const query = signWbi({ aid: info.aid, bvid: info.bvid, cid: info.cid, web_location: 1315873 }, keys.img, keys.sub);
        const result = await requestJSON(`${API}/x/player/wbi/v2?${query}`);
        if ([-352,-403].includes(result.code) || result.data?.v_voucher) {
          throw Object.assign(new Error('B 站暂时要求验证，请在原页面完成验证后重试。'), { refresh: true });
        }
        if (result.code !== 0) throw new Error(`字幕接口：${result.message || result.code}`);
        const data = result.data;
        if (!data || String(data.cid) !== String(info.cid) || String(data.aid) !== String(info.aid)) {
          throw new Error('接口返回的视频编号不匹配，已停止加载，请重试。');
        }
        return { data, loggedIn: keys.loggedIn };
      } catch (error) {
        if (attempt === 0 && (error.refresh || [403,412].includes(error.status))) continue;
        throw error;
      }
    }
  }

  const host = document.createElement('div');
  host.id = 'bili-lyrics-panel';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { --bg:#fff; --surface:#f5f7fa; --border:#e4e9f0; --line:#f0f2f5; --text:#283445; --muted:#718096; --faint:#919baa; --cue:#7e8b9d; --accent:#009bcf; --active:#edf9ff; --hover:#f5f8fc; --time:#94a0b1; --shadow:#23314b12; display:block; color-scheme:light; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; color:var(--text); text-align:left; }
      :host([data-theme="dark"]) { --bg:#171e2a; --surface:#202a3a; --border:#334155; --line:#2a3546; --text:#e5edf7; --muted:#a3afc1; --faint:#8995a8; --cue:#b0bacb; --accent:#64d1f5; --active:#173747; --hover:#263243; --time:#8c9bb0; --shadow:#0006; color-scheme:dark; }
      * { box-sizing:border-box; } [hidden] { display:none !important; }
      .card { height:100%; display:flex; flex-direction:column; border:1px solid var(--border); border-radius:14px; background:var(--bg); overflow:hidden; box-shadow:0 5px 24px var(--shadow); }
      button,input,select { font:inherit; } button { cursor:pointer; } button:disabled { cursor:default; opacity:.45; }
      button:focus-visible,input:focus-visible,select:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
      .header { display:flex; flex:0 0 72px; align-items:center; touch-action:none; user-select:none; cursor:grab; }
      :host([moving]) .header, :host([moving]) .head { cursor:grabbing; }
      .head { display:flex; align-items:center; gap:10px; flex:1; min-width:0; height:100%; padding:12px 10px 12px 16px; border:0; background:transparent; text-align:left; color:inherit; cursor:grab; touch-action:none; }
      .icon { display:grid; place-items:center; flex:0 0 32px; height:32px; color:var(--accent); background:var(--active); border-radius:10px; font-weight:700; font-size:19px; }
      .title { flex:1; font-weight:650; font-size:15px; } .title small { display:block; color:var(--faint); font-size:10px; font-weight:400; letter-spacing:1px; }
      .header-actions { display:flex; gap:2px; padding-right:10px; }
      .header-actions button { display:grid; place-items:center; width:28px; height:30px; padding:0; border:0; border-radius:7px; color:var(--muted); background:transparent; font-size:18px; }
      .header-actions button:hover { color:var(--accent); background:var(--surface); }
      .chevron { color:var(--faint); font-size:17px; } .body { display:flex; flex-direction:column; flex:1; min-height:0; border-top:1px solid var(--line); }
      .tools { padding:12px 14px 10px; flex:none; max-height:60%; overflow-y:auto; overscroll-behavior:contain; } .toolbar { display:flex; gap:7px; align-items:center; }
      select { min-width:0; flex:1; height:31px; padding:0 6px; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:6px; font-size:12px; }
      .small { border:1px solid var(--border); background:var(--bg); color:var(--muted); border-radius:6px; padding:4px 8px; font-size:12px; white-space:nowrap; }
      .search { width:100%; border:1px solid var(--border); background:var(--surface); border-radius:7px; padding:7px 10px; margin-top:9px; font-size:12px; color:var(--text); }
      .search::placeholder { color:var(--faint); opacity:1; }
      .font-toggle[aria-expanded="true"] { color:var(--accent); background:var(--active); }
      .font-settings { margin-top:10px; padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); }
      .setting-label,.custom-font-field { display:block; font-size:12px; color:var(--muted); }
      .font-settings select { display:block; width:100%; margin-top:4px; background:var(--bg); }
      .custom-font-field { margin-top:9px; }
      .font-name { display:block; width:100%; min-width:0; margin-top:4px; padding:6px 8px; border:1px solid var(--border); border-radius:6px; color:var(--text); background:var(--bg); font-size:12px; }
      .font-name::placeholder { color:var(--faint); opacity:1; }
      .font-size-row { display:flex; align-items:center; gap:8px; margin-top:10px; font-size:12px; color:var(--muted); }
      .font-size-row label,.font-size-value { flex:none; } .font-size-row input { flex:1; min-width:0; width:100%; accent-color:var(--accent); }
      .font-size-value { min-width:32px; font-variant-numeric:tabular-nums; text-align:right; }
      .font-bottom { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:9px; font-size:11px; color:var(--faint); }
      .meta { display:flex; flex:none; align-items:center; justify-content:space-between; padding:0 15px 9px; gap:8px; font-size:11px; color:var(--faint); }
      .follow { border:0; color:var(--accent); background:var(--active); padding:3px 8px; border-radius:12px; font-size:11px; }
      .follow[aria-pressed="false"] { color:var(--muted); background:var(--surface); }
      .list { position:relative; flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:var(--border) transparent; padding:16px 10px 80px; scroll-behavior:auto; }
      .cue { width:100%; display:flex; align-items:baseline; gap:10px; border:0; border-radius:9px; background:transparent; text-align:left; color:var(--cue); padding:11px 10px; line-height:1.8; transition:background .15s,color .15s; }
      .cue:hover { background:var(--hover); color:var(--text); } .cue time { flex:0 0 46px; font:10px/1.8 ui-monospace,Consolas,monospace; color:var(--time); }
      .cue span { white-space:pre-wrap; overflow-wrap:anywhere; font-family:var(--cue-font,inherit); font-size:var(--cue-size,14px); }
      .cue[aria-current="true"] { background:var(--active); color:var(--accent); font-weight:600; } .cue[aria-current="true"] time { color:var(--accent); }
      .status { flex:1; min-height:0; overflow:auto; padding:22px 18px; color:var(--muted); line-height:1.9; font-size:13px; white-space:pre-line; }
      .foot { display:flex; flex:none; align-items:center; justify-content:space-between; padding:10px 14px; border-top:1px solid var(--line); font-size:11px; color:var(--faint); }
      .foot button { border:0; background:transparent; color:var(--muted); font-size:11px; }
      :host([floating]) { position:fixed; z-index:10000; margin:0; }
      .resize-handle { position:absolute; touch-action:none; user-select:none; }
      .resize-handle[data-edge="n"],.resize-handle[data-edge="s"] { height:8px; left:12px; right:12px; cursor:ns-resize; }
      .resize-handle[data-edge="n"] { top:-3px; } .resize-handle[data-edge="s"] { bottom:-3px; }
      .resize-handle[data-edge="w"],.resize-handle[data-edge="e"] { width:8px; top:12px; bottom:12px; cursor:ew-resize; }
      .resize-handle[data-edge="w"] { left:-3px; } .resize-handle[data-edge="e"] { right:-3px; }
      .resize-handle[data-edge="nw"],.resize-handle[data-edge="ne"],.resize-handle[data-edge="sw"],.resize-handle[data-edge="se"] { width:14px; height:14px; }
      .resize-handle[data-edge="nw"] { top:-3px; left:-3px; cursor:nwse-resize; } .resize-handle[data-edge="ne"] { top:-3px; right:-3px; cursor:nesw-resize; }
      .resize-handle[data-edge="sw"] { bottom:-3px; left:-3px; cursor:nesw-resize; } .resize-handle[data-edge="se"] { bottom:0; right:0; cursor:nwse-resize; }
      .resize-handle[data-edge="se"]::after { content:""; position:absolute; right:4px; bottom:4px; width:7px; height:7px; border-right:2px solid var(--faint); border-bottom:2px solid var(--faint); border-radius:0 0 2px 0; opacity:.7; }
      @media(prefers-reduced-motion:reduce) { * { transition:none !important; } }
    </style>
    <section class="card" aria-label="滚动字幕">
      <div class="header" title="拖动标题栏移动面板；点击标题展开或收起">
      <button class="head" aria-expanded="false" aria-controls="lyrics-body">
        <span class="icon" aria-hidden="true">≋</span><span class="title">滚动字幕<small>BILI LYRICS</small></span><span class="chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="header-actions"><button class="theme" aria-label="深色模式" aria-pressed="false" title="切换为深色模式">☾</button><button class="reset-layout" aria-label="重置位置和大小" title="重置位置和大小">↺</button></div>
      </div>
      <div class="body" id="lyrics-body" hidden>
        <div class="tools"><div class="toolbar"><select aria-label="字幕语言" disabled><option>等待加载字幕</option></select><button class="small font-toggle" aria-label="字体设置" aria-expanded="false" aria-controls="lyrics-font-settings" title="设置字幕字体和字号">Aa</button><button class="small reload" title="重新获取当前分 P 的字幕">重试</button></div><input class="search" type="search" placeholder="搜索这段视频的字幕…" aria-label="搜索字幕" disabled>
          <div class="font-settings" id="lyrics-font-settings" hidden>
            <label class="setting-label" for="lyrics-font-family">字幕字体</label>
            <select id="lyrics-font-family" class="font-preset" aria-label="字幕字体">
              <option value="system">系统默认</option><option value="yahei">微软雅黑</option><option value="simsun">宋体</option><option value="kaiti">楷体</option><option value="simhei">黑体</option><option value="pingfang">苹方</option><option value="sourcehan">思源黑体</option><option value="wenkai">霞鹜文楷</option><option value="custom">自定义字体…</option>
            </select>
            <label class="custom-font-field" hidden>本机字体名称<input class="font-name" type="text" aria-label="自定义字体名称" maxlength="120" placeholder="例如：LXGW WenKai / 霞鹜文楷" autocomplete="off" spellcheck="false"></label>
            <div class="font-size-row"><label for="lyrics-font-size">字号</label><input id="lyrics-font-size" class="font-size" type="range" min="12" max="32" step="1" value="14" aria-label="字幕字号"><output class="font-size-value" for="lyrics-font-size">14px</output></div>
            <div class="font-bottom"><span>需本机已安装；未安装时使用备用字体</span><button class="small font-reset">恢复默认</button></div>
          </div>
        </div>
        <div class="meta"><span class="count">点击字幕跳到对应时间</span><button class="follow" aria-pressed="true">跟随播放</button></div>
        <div class="status" role="status" aria-live="polite">展开后加载当前视频的字幕。</div>
        <div class="list" tabindex="0" role="region" aria-label="字幕列表，可上下滚动" hidden></div>
        <div class="foot"><span class="position">点击一句，回到那一刻</span><button class="export" disabled>导出 SRT ↓</button></div>
      </div>
    </section>
    <div class="resize-handles" hidden>${['n','s','w','e','nw','ne','sw','se'].map(edge => `<div class="resize-handle" data-edge="${edge}" title="拖动边缘调整面板大小"></div>`).join('')}</div>`;

  const $ = selector => shadow.querySelector(selector);
  const ui = { head: $('.head'), body: $('.body'), select: $('select[aria-label="字幕语言"]'), search: $('.search'),
    reload: $('.reload'), follow: $('.follow'), status: $('.status'), list: $('.list'),
    count: $('.count'), position: $('.position'), export: $('.export') };
  let expanded = false, loaded = false, following = true;
  let route = '', generation = 0, trackGeneration = 0, info = null, tracks = [], cues = [], rows = [];
  let active = -1, video = null;
  const PREFS_KEY = 'bili-lyrics:panel:v1';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const SYSTEM_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';
  const FONT_PRESETS = {
    system: SYSTEM_FONT,
    yahei: '"Microsoft YaHei","微软雅黑",sans-serif',
    simsun: '"SimSun","宋体",serif',
    kaiti: '"KaiTi","楷体",serif',
    simhei: '"SimHei","黑体",sans-serif',
    pingfang: '"PingFang SC","苹方-简",sans-serif',
    sourcehan: '"Noto Sans CJK SC","Source Han Sans SC","思源黑体",sans-serif',
    wenkai: '"LXGW WenKai","霞鹜文楷",serif',
  };
  const cleanFontName = value => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch {}
  const layout = {
    x: Number.isFinite(saved.x) ? saved.x : null,
    y: Number.isFinite(saved.y) ? saved.y : null,
    width: Number.isFinite(saved.width) ? saved.width : 350,
    height: Number.isFinite(saved.height) ? saved.height : 620,
    theme: ['dark','light'].includes(saved.theme) ? saved.theme
      : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    fontPreset: Object.hasOwn(FONT_PRESETS, saved.fontPreset) || saved.fontPreset === 'custom' ? saved.fontPreset : 'system',
    fontFamily: cleanFontName(saved.fontFamily),
    fontSize: Number.isFinite(saved.fontSize) ? clamp(Math.round(saved.fontSize), 12, 32) : 14,
  };
  let suppressHeaderClickUntil = 0;

  function savePreferences() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(layout)); } catch {}
  }

  function applyTheme() {
    const dark = layout.theme === 'dark';
    host.dataset.theme = layout.theme;
    $('.theme').setAttribute('aria-pressed', String(dark));
    $('.theme').title = dark ? '切换为浅色模式' : '切换为深色模式';
    $('.theme').textContent = dark ? '☀' : '☾';
  }

  function applyFont() {
    // A custom name is one quoted CSS family, not a CSS fragment or a URL.
    const custom = cleanFontName(layout.fontFamily);
    const family = layout.fontPreset === 'custom'
      ? custom ? `${JSON.stringify(custom)},${SYSTEM_FONT}` : SYSTEM_FONT
      : FONT_PRESETS[layout.fontPreset];
    host.style.setProperty('--cue-font', family);
    host.style.setProperty('--cue-size', `${layout.fontSize}px`);
    $('.font-preset').value = layout.fontPreset;
    $('.custom-font-field').hidden = layout.fontPreset !== 'custom';
    if ($('.font-name').value !== layout.fontFamily) $('.font-name').value = layout.fontFamily;
    $('.font-size').value = String(layout.fontSize);
    $('.font-size-value').value = `${layout.fontSize}px`;
    requestAnimationFrame(() => { if (following) centerActive(); });
  }

  $('.font-toggle').addEventListener('click', () => {
    const open = $('.font-settings').hidden;
    $('.font-settings').hidden = !open;
    $('.font-toggle').setAttribute('aria-expanded', String(open));
    requestAnimationFrame(() => { if (following) centerActive(); });
  });
  $('.font-preset').addEventListener('change', () => {
    layout.fontPreset = $('.font-preset').value;
    applyFont(); savePreferences();
  });
  $('.font-name').addEventListener('input', () => {
    // Keep spaces while typing multi-word names; trim only the CSS family.
    layout.fontFamily = $('.font-name').value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
    applyFont(); savePreferences();
  });
  $('.font-size').addEventListener('input', () => {
    layout.fontSize = clamp(Number($('.font-size').value), 12, 32);
    applyFont(); savePreferences();
  });
  $('.font-reset').addEventListener('click', () => {
    Object.assign(layout, { fontPreset: 'system', fontFamily: '', fontSize: 14 });
    applyFont(); savePreferences();
  });

  function applyLayout() {
    const width = clamp(layout.width, Math.min(280, innerWidth - 24), Math.max(1, innerWidth - 24));
    const height = expanded ? clamp(layout.height, Math.min(280, innerHeight - 24), Math.max(1, innerHeight - 24)) : Math.min(74, innerHeight - 24);
    const x = clamp(layout.x ?? innerWidth - width - 18, 12, Math.max(12, innerWidth - width - 12));
    const y = clamp(layout.y ?? innerHeight - height - 20, 12, Math.max(12, innerHeight - height - 12));
    Object.assign(host.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
  }

  function beginGesture(event, edge = '') {
    if (event.button !== 0 || (!edge && event.target.closest('.header-actions'))) return;
    const rect = host.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    const controller = new AbortController();
    let moved = false;
    const captureTarget = event.currentTarget;
    const move = e => {
      if (e.pointerId !== event.pointerId) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) {
        moved = true;
        host.setAttribute('moving', '');
        captureTarget.setPointerCapture(event.pointerId);
      }
      e.preventDefault();
      if (!edge) {
        layout.x = clamp(rect.left + dx, 12, Math.max(12, innerWidth - rect.width - 12));
        layout.y = clamp(rect.top + dy, 12, Math.max(12, innerHeight - rect.height - 12));
      } else {
        const minWidth = Math.min(280, innerWidth - 24), minHeight = Math.min(280, innerHeight - 24);
        let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
        if (edge.includes('w')) left = clamp(rect.left + dx, 12, rect.right - minWidth);
        if (edge.includes('e')) right = clamp(rect.right + dx, rect.left + minWidth, innerWidth - 12);
        if (edge.includes('n')) top = clamp(rect.top + dy, 12, rect.bottom - minHeight);
        if (edge.includes('s')) bottom = clamp(rect.bottom + dy, rect.top + minHeight, innerHeight - 12);
        Object.assign(layout, { x: left, y: top, width: right - left, height: bottom - top });
      }
      applyLayout();
    };
    const finish = e => {
      if (e.pointerId !== event.pointerId) return;
      controller.abort();
      host.removeAttribute('moving');
      if (captureTarget.hasPointerCapture(event.pointerId)) captureTarget.releasePointerCapture(event.pointerId);
      if (moved) {
        suppressHeaderClickUntil = performance.now() + 250;
        savePreferences();
        if (following) centerActive();
      }
    };
    window.addEventListener('pointermove', move, { signal: controller.signal, passive: false });
    window.addEventListener('pointerup', finish, { signal: controller.signal });
    window.addEventListener('pointercancel', finish, { signal: controller.signal });
  }

  $('.header').addEventListener('pointerdown', event => beginGesture(event));
  for (const handle of shadow.querySelectorAll('.resize-handle')) {
    handle.addEventListener('pointerdown', event => beginGesture(event, handle.dataset.edge));
  }
  $('.theme').addEventListener('click', () => {
    layout.theme = layout.theme === 'dark' ? 'light' : 'dark';
    applyTheme(); savePreferences();
  });
  $('.reset-layout').addEventListener('click', () => {
    Object.assign(layout, { x: null, y: null, width: 350, height: 620 });
    applyLayout(); savePreferences();
    if (following) centerActive();
  });
  window.addEventListener('resize', applyLayout);
  applyTheme(); applyLayout(); applyFont();

  function currentRoute() {
    const bvid = location.pathname.match(/\/video\/(BV[\w]+)\/?/i)?.[1];
    const p = Math.max(1, Number.parseInt(new URL(location.href).searchParams.get('p') || '1', 10) || 1);
    return bvid ? { bvid, p, key: `${bvid}:${p}` } : null;
  }

  function mount() {
    // Keep our DOM outside Bilibili's Vue tree. Inserting an unknown first child
    // into .right-container during hydration can make Vue reuse the wrong node.
    host.setAttribute('floating', '');
    if (host.parentElement !== document.body) document.body.append(host);
  }

  function status(message) {
    ui.status.textContent = message;
    ui.status.hidden = false;
    ui.list.hidden = true;
  }

  function setFollowing(on) {
    following = on;
    ui.follow.setAttribute('aria-pressed', String(on));
    ui.follow.textContent = on ? '跟随播放' : '回到当前句';
    if (on) centerActive();
  }

  function centerActive() {
    const row = rows[active];
    if (!row || row.hidden || !expanded || ui.list.hidden) return;
    ui.list.scrollTo({ top: row.offsetTop - (ui.list.clientHeight - row.offsetHeight) / 2,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function sync(force = false) {
    if (!video || !Number.isFinite(video.currentTime)) return;
    const next = activeCue(cues, video.currentTime);
    ui.position.textContent = `${clock(video.currentTime)} · ${info ? `P${info.p}` : '当前视频'}`;
    if (next === active && !force) return;
    if (rows[active]) rows[active].removeAttribute('aria-current');
    active = next;
    if (rows[active]) rows[active].setAttribute('aria-current', 'true');
    if (following) centerActive();
  }

  function bindVideo() {
    const next = document.querySelector('.bpx-player-video-wrap video, .bpx-player-video-wrap bwp-video, video.bilibili-player-video, video, bwp-video');
    if (next === video) return;
    if (video) for (const event of ['timeupdate','seeked','loadedmetadata']) video.removeEventListener(event, onTime);
    video = next;
    if (video) for (const event of ['timeupdate','seeked','loadedmetadata']) video.addEventListener(event, onTime);
    sync(true);
  }
  function onTime() { sync(); }

  async function seek(index) {
    const cue = cues[index];
    bindVideo();
    if (!cue || !video || typeof video.currentTime !== 'number') {
      ui.position.textContent = '播放器还没准备好，请先播放视频。';
      return;
    }
    try {
      video.currentTime = cue.from;
      setFollowing(true);
      sync(true);
      if (typeof video.play === 'function') await video.play();
    } catch { ui.position.textContent = '已定位，请在播放器中点击播放。'; }
  }

  function applySearch() {
    const query = ui.search.value.trim().toLocaleLowerCase();
    let count = 0;
    rows.forEach((row, i) => {
      row.hidden = !!query && !cues[i].content.toLocaleLowerCase().includes(query);
      if (!row.hidden) count++;
    });
    ui.count.textContent = query ? `${count} / ${cues.length} 句匹配` : `${cues.length} 句 · 点击跳转`;
    if (query) setFollowing(false);
    else if (following) centerActive();
  }

  function clearCues() {
    cues = []; rows = []; active = -1;
    ui.list.replaceChildren();
    ui.export.disabled = true;
    ui.search.disabled = true;
    ui.search.value = '';
    ui.count.textContent = '点击字幕跳到对应时间';
    ui.position.textContent = '点击一句，回到那一刻';
  }

  async function loadTrack(index) {
    const current = generation, token = ++trackGeneration;
    const track = tracks[index];
    clearCues();
    status('正在读取字幕正文…');
    try {
      if (!track) throw new Error('没有可选的字幕轨道。');
      const raw = track.subtitle_url || track.subtitle_url_v2;
      if (!raw) throw new Error('这个字幕轨道暂时没有下载地址。');
      const data = await requestJSON(subtitleUrl(raw), false);
      if (current !== generation || token !== trackGeneration) return;
      cues = normalizeCues(data);
      if (!cues.length) throw new Error('字幕文件中没有可显示的句子。');
      let maxEnd = 0;
      for (const cue of cues) { maxEnd = Math.max(maxEnd, cue.to); cue._maxEnd = maxEnd; }
      const fragment = document.createDocumentFragment();
      rows = cues.map((cue, i) => {
        const row = document.createElement('button');
        row.type = 'button'; row.className = 'cue'; row.dataset.index = String(i);
        const time = document.createElement('time'); time.textContent = clock(cue.from);
        const text = document.createElement('span'); text.textContent = cue.content;
        row.append(time, text);
        row.title = `跳到 ${clock(cue.from)}`;
        fragment.append(row);
        return row;
      });
      ui.list.replaceChildren(fragment);
      ui.status.hidden = true; ui.list.hidden = false;
      ui.export.disabled = false; ui.search.disabled = false;
      ui.list.scrollTop = 0;
      setFollowing(true); applySearch(); bindVideo(); sync(true);
    } catch (error) {
      if (current !== generation || token !== trackGeneration) return;
      clearCues(); status(error.message);
    }
  }

  async function load() {
    const target = currentRoute();
    if (!target) return;
    route = target.key;
    const current = ++generation;
    ++trackGeneration; loaded = true; tracks = []; info = null;
    clearCues(); ui.select.replaceChildren(new Option('正在获取字幕…', '')); ui.select.disabled = true;
    ui.reload.disabled = true;
    status('正在获取当前视频的字幕…');
    try {
      const view = await requestJSON(`${API}/x/web-interface/view?bvid=${encodeURIComponent(target.bvid)}`);
      if (current !== generation) return;
      if (view.code !== 0) throw new Error(`视频信息：${view.message || view.code}`);
      if (view.data?.bvid !== target.bvid) throw new Error('视频信息与当前页面不匹配，请刷新重试。');
      const page = view.data.pages?.find(p => p.page === target.p);
      if (!page) throw new Error(`找不到第 ${target.p} 个分 P，请重新选择分 P。`);
      info = { aid: view.data.aid, bvid: target.bvid, cid: page.cid, p: target.p, title: view.data.title, part: page.part };
      const result = await playerInfo(info);
      if (current !== generation) return;
      tracks = (result.data.subtitle?.subtitles || []).filter(t => t.subtitle_url || t.subtitle_url_v2);
      if (!tracks.length) {
        ui.select.replaceChildren(new Option('暂无可用字幕', ''));
        status(!result.loggedIn || result.data.need_login_subtitle
          ? '暂时没有取得字幕。\n请先在 B 站登录，再点「重试」。AI 字幕通常需要登录；空列表不代表视频一定没有字幕。'
          : '当前分 P 暂未返回字幕。\n可以先在播放器里开启「字幕」，再点「重试」。部分视频没有字幕，或字幕尚未生成。');
        return;
      }
      ui.select.replaceChildren(...tracks.map((t, i) => new Option(t.lan_doc || t.lan || `字幕 ${i + 1}`, String(i))));
      ui.select.disabled = false;
      const preferred = tracks.findIndex(t => /^(zh|ai-zh)/i.test(t.lan));
      ui.select.value = String(Math.max(0, preferred));
      await loadTrack(Number(ui.select.value));
    } catch (error) {
      if (current === generation) {
        ui.select.replaceChildren(new Option('加载失败', ''));
        status(`${error.message}\n可以点击「重试」重新加载。`);
      }
    } finally { if (current === generation) ui.reload.disabled = false; }
  }

  ui.head.addEventListener('click', () => {
    if (performance.now() < suppressHeaderClickUntil) return;
    expanded = !expanded;
    ui.head.setAttribute('aria-expanded', String(expanded));
    ui.body.hidden = !expanded;
    $('.chevron').textContent = expanded ? '⌃' : '⌄';
    $('.resize-handles').hidden = !expanded;
    applyLayout();
    if (expanded && !loaded) void load();
    else if (expanded) sync(true);
  });
  ui.reload.addEventListener('click', () => { keyCache = null; void load(); });
  ui.select.addEventListener('change', () => void loadTrack(Number(ui.select.value)));
  ui.search.addEventListener('input', applySearch);
  ui.follow.addEventListener('click', () => { ui.search.value = ''; applySearch(); setFollowing(true); sync(true); });
  ui.list.addEventListener('click', event => {
    const row = event.target.closest('.cue');
    if (row) void seek(Number(row.dataset.index));
  });
  // Only user input pauses follow; programmatic scrolling never fights the user.
  for (const event of ['wheel','touchstart','pointerdown']) {
    ui.list.addEventListener(event, () => setFollowing(false), { passive: true });
  }
  ui.list.addEventListener('keydown', event => {
    if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) setFollowing(false);
  });
  ui.export.addEventListener('click', () => {
    if (!cues.length || !info) return;
    const blob = new Blob(['\uFEFF', toSrt(cues)], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${info.bvid}_P${info.p}_${tracks[Number(ui.select.value)]?.lan || 'subtitle'}.srt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });

  function tick() {
    const target = currentRoute();
    host.hidden = !target;
    if (!target) {
      if (route) { route = ''; ++generation; ++trackGeneration; loaded = false; clearCues(); }
      return;
    }
    mount();
    if (target.key !== route) {
      route = target.key; ++generation; ++trackGeneration;
      loaded = false; clearCues(); tracks = []; info = null;
      if (expanded) void load();
    }
    bindVideo();
  }
  tick();
  // Bilibili replaces both route and video nodes during SPA / multi-part navigation.
  setInterval(tick, 700);
})();
