const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { md5, signWbi, normalizeCues, activeCue, clock, toSrt, subtitleUrl } = require('../bili-lyrics.user.js');

test('MD5 matches Node crypto across UTF-8 and padding/block boundaries', () => {
  for (const value of ['', 'abc', '中文字幕 🎧', ...[55,56,63,64,65,128,1000].map(n => 'a'.repeat(n))]) {
    assert.equal(md5(value), crypto.createHash('md5').update(value).digest('hex'));
  }
});

test('WBI matches the published fixed-time example', () => {
  assert.equal(signWbi({ foo: '114', bar: '514', zab: 1919810 },
    '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169),
  'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  assert.throws(() => signWbi({}, '', ''), /WBI/);
});

test('WBI encodes spaces, Unicode, and strips filtered punctuation', () => {
  const query = signWbi({ foo: "one one!'()*", bar: '五一四' },
    '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169);
  const expectedQuery = 'bar=%E4%BA%94%E4%B8%80%E5%9B%9B&foo=one%20one&wts=1702204169';
  assert.equal(query, expectedQuery + '&w_rid=' + crypto.createHash('md5').update(expectedQuery + 'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
});

test('Cue lookup handles silence, end boundaries, overlaps and reverse seeking', () => {
  const cues = normalizeCues({ body: [
    { from: 5, to: 6, content: '短句' }, { from: 1, to: 10, content: '长句' },
    { from: 12, to: 13, content: '结束' }, { from: -1, to: 2, content: '非法' },
    { from: 20, to: 19, content: '非法' }, { from: 0, to: 1, content: '' },
  ] });
  assert.equal(cues.length, 3);
  for (const [time, index] of [[0,-1],[1,0],[5,1],[6,0],[10,-1],[12,2],[13,-1],[2,0]]) {
    assert.equal(activeCue(cues, time), index);
  }
});

test('SRT preserves milliseconds and carries rounded values correctly', () => {
  assert.equal(clock(13574), '03:46:14');
  assert.equal(toSrt([{ from: 59.9999, to: 3600.345, content: '字幕' }]),
    '1\n00:01:00,000 --> 01:00:00,345\n字幕\n');
});

test('Subtitle URLs accept Bilibili CDN only', () => {
  assert.equal(subtitleUrl('//aisubtitle.hdslb.com/bfs/subtitle/a.json?auth=x'), 'https://aisubtitle.hdslb.com/bfs/subtitle/a.json?auth=x');
  for (const url of ['https://evil.example/a', 'http://aisubtitle.hdslb.com/a', 'https://hdslb.com.evil.example/a']) {
    assert.throws(() => subtitleUrl(url));
  }
});
