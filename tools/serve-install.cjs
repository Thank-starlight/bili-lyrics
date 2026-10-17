const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../bili-lyrics.user.js'));
const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/close') {
    response.end('closed');
    server.close();
    clearTimeout(timer);
    return;
  }
  if (request.url !== '/bili-lyrics.user.js') {
    response.writeHead(404); response.end(); return;
  }
  response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(source);
});
const timer = setTimeout(() => server.close(), 300000);
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/bili-lyrics.user.js`));
