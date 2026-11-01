// Готовит «нагрузочную» копию тестового сайта: те же доклады, размноженные до ~800 фрагментов
// (больше, чем будет у 30 реальных докладов), чтобы честно проверить скорость мгновенного слоя.
import fs from 'node:fs';
import path from 'node:path';

export default function globalSetup() {
  const src = '_site-test';
  if (!fs.existsSync(path.join(src, 'data', 'index.json'))) {
    throw new Error('Нет _site-test. Запустите: npm test (он сначала собирает сайт из tests/fixtures)');
  }
  const dst = path.join(src, 'stress');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.join(dst, 'data'), { recursive: true });
  for (const f of ['index.html', 'app.js', 'stem.js', 'style.css', 'worker.js']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  fs.mkdirSync(path.join(dst, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(src, 'vendor', 'minisearch.js'), path.join(dst, 'vendor', 'minisearch.js'));
  fs.copyFileSync(path.join(src, 'data', 'synonyms.txt'), path.join(dst, 'data', 'synonyms.txt'));

  const index = JSON.parse(fs.readFileSync(path.join(src, 'data', 'index.json'), 'utf8'));
  const copies = Math.ceil(800 / index.frags.length);
  const docs = [], frags = [];
  for (let c = 0; c < copies; c++) {
    index.docs.forEach((d) => docs.push({ ...d, id: `${d.id}-${c}`, title: `${d.title} (${c + 1})` }));
    index.frags.forEach((f) => frags.push({ ...f, doc: f.doc + c * index.docs.length, thumb: f.thumb ? `../${f.thumb}` : null }));
  }
  index.meta.dim = 0; // смысловой слой здесь не нужен
  fs.writeFileSync(path.join(dst, 'data', 'index.json'), JSON.stringify({ ...index, docs, frags }));
}
