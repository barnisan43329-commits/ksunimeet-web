// Кладём supabase-js в сам сайт, а не тянем с CDN.
//
// jsDelivr и unpkg стоят за Cloudflare, а сеть Cloudflare российские
// провайдеры режут с июня 2025. Свой файл на своём хостинге этой участи
// не имеет. Ту же копию делает сборка Pages (шаг в pages.yml) — этот скрипт
// нужен, чтобы запустить сайт локально.
import { mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const to = resolve(root, 'public/vendor/supabase.js');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log('vendor: supabase.js →', to, statSync(to).size, 'bytes');