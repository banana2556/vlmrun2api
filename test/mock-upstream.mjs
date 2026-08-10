import http from 'node:http';

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startMockUpstream(port = 8788) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'e2e-model' }] }));
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readBody(req);
      requests.push(body);
      res.writeHead(200, {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream'
      });
      res.write('data: {"id":"e2e","choices":[{"delta":{"content":"local-ok"}}]}\n\n');
      return res.end('data: [DONE]\n\n');
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, requests };
}
