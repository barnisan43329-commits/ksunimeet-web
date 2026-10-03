// Локальный сервер ровно того, что публикуется на Pages.
//
// Отдаёт только public/ и всегда с Cache-Control: no-store — иначе браузер
// держит старый app.js и правки «не применяются».
//
//   node tools/vendor.mjs     # один раз: положить supabase.js в public/
//   node tools/serve.mjs      # http://127.0.0.1:8137
//
// Перед запуском нужен public/config.js — его пишет сборка Pages из
// переменных репозитория. Локально достаточно двух публичных значений:
//   window.KSU_CONFIG = { supabaseUrl: "…", supabaseAnonKey: "…" };
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const port = Number(process.argv[2] || 8137);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = normalize(url === '/' ? '/index.html' : url);
  const file = join(root, rel);

  // Никаких выходов за пределы public/.
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(port, '127.0.0.1', () => {
  console.log('KsuNiMeet local: http://127.0.0.1:' + port + '/');
});