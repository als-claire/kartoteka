// Сборка сайта: читает презентации, извлекает текст по слайдам, делает миниатюры,
// распознаёт текст на картинках (OCR), считает эмбеддинги и кладёт всё в папку сайта.
//
//   node build/build.mjs                 — из presentations/ в _site/
//   node build/build.mjs --input tests/fixtures --out _site-test
//
// Результаты по каждому файлу кэшируются в .cache/, поэтому повторная сборка быстрая.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { MODEL, PATHS, THUMB_WIDTH, DOCX_CHUNK, OCR_MIN_CHARS, HUB_PROBES } from './config.mjs';
import { tokenize, processTerm } from '../site/stem.js';

const BUILD_VERSION = 4; // увеличить, если меняется формат извлечения — кэш пересчитается
const args = parseArgs(process.argv.slice(2));
const INPUT = args.input || PATHS.presentations;
const OUT = args.out || PATHS.out;
const CACHE = PATHS.cache;
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const log = (...a) => console.log(...a);
// В GitHub Actions предупреждения попадают в сводку запуска, чтобы их было видно без чтения логов.
const warn = (...a) => console.warn(process.env.GITHUB_ACTIONS ? '::warning::' : '⚠', ...a);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return o;
}

// ---------- текстовые утилиты ----------

const JUNK_RE = [
  /^\d{1,3}$/,
  /^(слайд|блок|часть|раздел|модуль|глава|тема|страница|стр\.?|slide|page)\s*№?\s*\d+(\s*(из|\/|of)\s*\d+)?\.?$/i,
  /^\d+\s*(\/|из|of)\s*\d+$/i,
  /^[\p{P}\p{S}\s]*$/u,
];
const isJunk = (s) => JUNK_RE.some((re) => re.test(s.trim()));

function cleanText(s) {
  return s
    .replace(/\u00AD/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Склеивает строки абзаца: перенос «эконо-\nмика» → «экономика».
function joinLines(lines) {
  let out = '';
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (!out) out = t;
    else if (/[а-яa-z]-$/i.test(out) && /^[а-яa-z]/.test(t)) out = out.slice(0, -1) + t;
    else out += ' ' + t;
  }
  return out;
}

// Предложения как отрезки [начало, конец] в тексте фрагмента.
function splitSentences(text) {
  const res = [];
  const re = /[^\n]+/g;
  let m;
  while ((m = re.exec(text))) {
    const line = m[0];
    const base = m.index;
    const parts = line.split(/(?<=[.!?…»"])\s+(?=[«"(]?[А-ЯЁA-Z0-9—–-])/u);
    let off = 0;
    for (const p of parts) {
      const start = line.indexOf(p, off);
      off = start + p.length;
      if (p.trim()) res.push([base + start, base + start + p.length]);
    }
  }
  // Слишком короткие куски («1882 г.», «•») приклеиваем к следующему.
  const merged = [];
  for (let i = 0; i < res.length; i++) {
    const [s, e] = res[i];
    if (e - s < 12 && i + 1 < res.length) {
      res[i + 1] = [s, res[i + 1][1]];
      continue;
    }
    merged.push([s, e]);
  }
  return merged;
}

const NAME_RE = /([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+(?:вич|вна|ична|чна))?|[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.|[А-ЯЁ]\.\s?[А-ЯЁ]\.\s?[А-ЯЁ][а-яё]+)/u;
const AUTHOR_LABEL_RE = /(?:^|\s)(?:автор[ыа]?|выполнил[аи]?|подготовил[аи]?|докладчик(?:и|ца)?|исполнитель|студент(?:ка|ы)?|работу выполнил[аи]?)\s*[:\-–—]?\s*(.+)/iu;

function findAuthor(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(AUTHOR_LABEL_RE);
    if (!m) continue;
    let rest = m[1].trim();
    if (!rest && lines[i + 1]) rest = lines[i + 1];
    rest = rest.replace(/^(студент(ка|ы)?|группы?)\s+/i, '');
    const n = rest.match(NAME_RE);
    if (n) return n[1].replace(/\s+/g, ' ');
    if (rest && rest.length < 60 && !/группа|курс|факультет/i.test(rest)) return rest.split(',')[0].trim();
  }
  return '';
}

function metaAuthor(s) {
  s = (s || '').trim();
  if (!s || s.length > 80 || !/\s/.test(s)) return '';
  if (/^(user|admin|пользователь|microsoft|windows|python|unknown)/i.test(s)) return '';
  return s;
}

function slugify(name) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const base = name.toLowerCase().replace(/[а-яё]/g, (c) => map[c] ?? c).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const h = crypto.createHash('sha1').update(name).digest('hex').slice(0, 6);
  return `${base || 'doc'}-${h}`;
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

// ---------- OCR ----------

let ocrWorker = null;
async function ocr(png) {
  if (!ocrWorker) {
    const { createWorker } = await import('tesseract.js');
    fs.mkdirSync(path.join(CACHE, 'tessdata'), { recursive: true });
    ocrWorker = await createWorker(['rus', 'eng'], 1, { cachePath: path.join(CACHE, 'tessdata'), logger: () => {} });
  }
  const { data } = await ocrWorker.recognize(Buffer.from(png));
  return cleanText(data.text.split('\n').filter((l) => (l.match(/\p{L}/gu) || []).length >= 2).join('\n'));
}

// ---------- миниатюры ----------

let sharp;
async function toWebp(png, width = THUMB_WIDTH) {
  sharp ??= (await import('sharp')).default;
  return sharp(Buffer.from(png)).resize({ width, withoutEnlargement: false }).webp({ quality: 78 }).toBuffer();
}

// ---------- PDF ----------

let mupdf;
async function loadMupdf() { mupdf ??= await import('mupdf'); return mupdf; }

function pageTitleAndText(json, height) {
  const lines = [];
  const blocks = [];
  let hasImage = false;
  for (const b of json.blocks) {
    if (b.type === 'image') { hasImage = true; continue; }
    if (b.type !== 'text') continue;
    const bl = [];
    for (const l of b.lines) {
      const t = cleanText(l.text || '');
      if (!t) continue;
      const item = { text: t, size: l.font?.size || 0, y: l.bbox.y, junk: isJunk(t) };
      lines.push(item);
      if (!item.junk) bl.push(item);
    }
    if (bl.length) blocks.push(bl);
  }
  const top = lines.filter((l) => !l.junk && l.y < height * 0.5 && /\p{L}/u.test(l.text));
  let title = '';
  if (top.length) {
    const max = Math.max(...top.map((l) => l.size));
    const big = top.filter((l) => l.size >= max * 0.92).sort((a, b) => a.y - b.y);
    // Берём первую строку и следующие сразу под ней (многострочный заголовок).
    const parts = [big[0]];
    for (let i = 1; i < big.length; i++) {
      if (big[i].y - parts[parts.length - 1].y < big[i].size * 1.8) parts.push(big[i]);
      else break;
    }
    title = joinLines(parts.map((p) => p.text)).slice(0, 160);
  }
  const text = cleanText(blocks.map((bl) => joinLines(bl.map((l) => l.text))).join('\n'));
  return { title, text, hasImage, lines: lines.filter((l) => !l.junk).map((l) => l.text) };
}

async function renderPdfPages(buf, { withText = true } = {}) {
  const m = await loadMupdf();
  const doc = m.Document.openDocument(buf, 'application/pdf');
  const n = doc.countPages();
  const pages = [];
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    const w = x1 - x0, h = y1 - y0;
    const scale = THUMB_WIDTH / w;
    const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
    const thumb = await toWebp(pix.asPNG());
    const res = { thumb };
    if (withText) {
      const json = JSON.parse(page.toStructuredText('preserve-whitespace,preserve-images').asJSON());
      Object.assign(res, pageTitleAndText(json, h));
      if (res.text.length < OCR_MIN_CHARS && res.hasImage) {
        const s2 = Math.min(3, 2000 / w);
        const big = page.toPixmap(m.Matrix.scale(s2, s2), m.ColorSpace.DeviceRGB, false, true).asPNG();
        const t = await ocr(big);
        if (t) {
          res.text = cleanText(res.text + '\n' + t);
          res.ocr = true;
          if (!res.title) res.title = t.split('\n').find((l) => l.length > 3 && !isJunk(l))?.slice(0, 120) || '';
        }
      }
    }
    pages.push(res);
  }
  const meta = { title: doc.getMetaData('info:Title') || '', author: doc.getMetaData('info:Author') || '' };
  return { pages, meta };
}

async function extractPdf(buf) {
  const { pages, meta } = await renderPdfPages(buf);
  const first = pages[0] || { title: '', lines: [] };
  return {
    title: first.title || meta.title,
    author: findAuthor(first.lines || []) || metaAuthor(meta.author),
    frags: pages.map((p, i) => ({ n: i + 1, title: p.title, text: p.text, ocr: p.ocr || undefined })),
    thumbs: pages.map((p) => p.thumb),
  };
}

// ---------- PPTX ----------

function findSoffice() {
  const cands = ['soffice', 'libreoffice', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 20000 });
      if (r.status === 0) return c;
    } catch { /* нет такого */ }
  }
  return null;
}
let soffice;

function relsMap(xml, baseDir) {
  const map = {};
  for (const m of (xml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/Id="([^"]+)"/)?.[1];
    const target = m[0].match(/Target="([^"]+)"/)?.[1];
    if (id && target) map[id] = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(baseDir, target));
  }
  return map;
}

function paragraphs(xml) {
  const out = [];
  for (const p of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p [^>]*>([\s\S]*?)<\/a:p>/g)) {
    const body = (p[1] ?? p[2]).replace(/<a:br\/>/g, '<a:t> </a:t>');
    const t = cleanText(decodeXml([...body.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((x) => x[1]).join('')));
    if (t) out.push(t);
  }
  return out;
}

async function extractPptx(buf, file) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const read = async (p) => (zip.file(p) ? zip.file(p).async('string') : '');
  const pres = await read('ppt/presentation.xml');
  const presRels = relsMap(await read('ppt/_rels/presentation.xml.rels'), 'ppt');
  const slidePaths = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => presRels[m[1]]).filter(Boolean);

  const frags = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const sp = slidePaths[i];
    const xml = await read(sp);
    const rels = relsMap(await read(path.posix.join(path.posix.dirname(sp), '_rels', path.posix.basename(sp) + '.rels')), path.posix.dirname(sp));
    const shapes = [];
    for (const m of xml.matchAll(/<p:(sp|graphicFrame)\b[\s\S]*?<\/p:\1>/g)) {
      const s = m[0];
      const ph = s.match(/<p:ph\b[^>]*type="([^"]+)"/)?.[1] || '';
      const sizes = [...s.matchAll(/\bsz="(\d+)"/g)].map((x) => +x[1]);
      const isTitle = ph === 'title' || ph === 'ctrTitle';
      if (/^(sldNum|dt|ftr)$/.test(ph)) continue;
      const paras = paragraphs(s).filter((t) => !isJunk(t));
      if (paras.length) shapes.push({ isTitle, size: sizes.length ? Math.max(...sizes) : (isTitle ? 4400 : 1800), paras });
    }
    let titleShape = shapes.find((s) => s.isTitle);
    if (!titleShape && shapes.length) titleShape = shapes.reduce((a, b) => (b.size > a.size ? b : a));
    const title = titleShape ? joinLines(titleShape.paras).slice(0, 160) : '';
    const ordered = titleShape ? [titleShape, ...shapes.filter((s) => s !== titleShape)] : shapes;
    let text = cleanText(ordered.map((s) => s.paras.join('\n')).join('\n'));
    let isOcr;
    const pics = [...xml.matchAll(/<p:pic\b[\s\S]*?r:embed="([^"]+)"/g)].map((m) => rels[m[1]]).filter(Boolean);
    if (text.length < OCR_MIN_CHARS && pics.length) {
      for (const pic of pics) {
        if (!/\.(png|jpe?g|gif|bmp|tiff?)$/i.test(pic) || !zip.file(pic)) continue;
        sharp ??= (await import('sharp')).default;
        const png = await sharp(await zip.file(pic).async('nodebuffer')).png().toBuffer();
        const t = await ocr(png);
        if (t) { text = cleanText(text + '\n' + t); isOcr = true; }
      }
    }
    frags.push({ n: i + 1, title, text, ocr: isOcr, lines: ordered.flatMap((s) => s.paras) });
  }

  const core = await read('docProps/core.xml');
  const metaTitle = decodeXml(core.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1] || '');
  const creator = decodeXml(core.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)?.[1] || '');

  // Миниатюры: через LibreOffice (PPTX → PDF), если он установлен.
  let thumbs = frags.map(() => null);
  soffice ??= findSoffice() || false;
  if (soffice) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-'));
    const src = path.join(tmp, 'slides.pptx');
    fs.writeFileSync(src, buf);
    const r = spawnSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', tmp, src], { timeout: 180000 });
    const pdf = path.join(tmp, 'slides.pdf');
    if (r.status === 0 && fs.existsSync(pdf)) {
      const { pages } = await renderPdfPages(fs.readFileSync(pdf), { withText: false });
      if (pages.length === frags.length) thumbs = pages.map((p) => p.thumb);
      else warn(`${file}: LibreOffice дал ${pages.length} страниц вместо ${frags.length}, миниатюры пропущены`);
    } else warn(`${file}: LibreOffice не смог сконвертировать файл, миниатюры пропущены`);
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    warn(`${file}: LibreOffice не найден — у слайдов PPTX будут текстовые карточки вместо миниатюр`);
  }

  return {
    title: frags[0]?.title || metaTitle,
    author: findAuthor(frags[0]?.lines || []) || metaAuthor(creator),
    frags: frags.map(({ lines, ...f }) => f),
    thumbs,
  };
}

// ---------- DOCX ----------

async function extractDocx(buf) {
  const mammoth = (await import('mammoth')).default;
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  const items = [];
  for (const m of html.matchAll(/<(h[1-6]|p|li|th|td)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const t = cleanText(decodeXml(m[2].replace(/<[^>]+>/g, ' ')));
    if (t) items.push({ heading: m[1][0] === 'h', text: t });
  }
  const sections = [];
  let cur = null;
  for (const it of items) {
    if (it.heading) { cur = { title: it.text, paras: [] }; sections.push(cur); }
    else {
      if (!cur) { cur = { title: '', paras: [] }; sections.push(cur); }
      cur.paras.push(it.text);
    }
  }
  const docTitle = sections.find((s) => s.title)?.title || '';
  const firstLines = items.slice(0, 15).map((i) => i.text);

  // Длинные разделы режем на части ~DOCX_CHUNK символов по границам предложений.
  const frags = [];
  for (const s of sections) {
    if (!s.paras.length) continue;
    const text = s.paras.join('\n');
    const chunks = [];
    if (text.length <= DOCX_CHUNK * 1.3) chunks.push(text);
    else {
      let buf2 = '';
      for (const [a, b] of splitSentences(text)) {
        const sent = text.slice(a, b);
        if (buf2 && buf2.length + sent.length > DOCX_CHUNK) { chunks.push(buf2); buf2 = ''; }
        buf2 += (buf2 ? (text[a - 1] === '\n' ? '\n' : ' ') : '') + sent;
      }
      if (buf2) chunks.push(buf2);
    }
    chunks.forEach((c, k) => frags.push({
      n: frags.length + 1,
      title: (s.title || docTitle) + (chunks.length > 1 ? ` (часть ${k + 1})` : ''),
      text: cleanText(c),
    }));
  }
  const JSZip = (await import('jszip')).default;
  const core = await (await JSZip.loadAsync(buf)).file('docProps/core.xml')?.async('string') || '';
  return {
    title: docTitle || decodeXml(core.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1] || ''),
    author: findAuthor(firstLines) || metaAuthor(decodeXml(core.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)?.[1] || '')),
    frags,
    thumbs: frags.map(() => null),
  };
}

// ---------- эмбеддинги ----------

let extractor;
async function embed(texts, prefix = MODEL.docPrefix) {
  if (!texts.length) return [];
  if (!extractor) {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(CACHE, 'models');
    log(`Загружаю модель ${MODEL.id} (${MODEL.dtype})…`);
    extractor = await pipeline('feature-extraction', MODEL.id, { dtype: MODEL.dtype });
  }
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => prefix + t);
    out.push(...(await extractor(batch, { pooling: 'mean', normalize: true })).tolist());
  }
  return out;
}

// Нормированный вектор → int8 (−127…127). Косинус почти не меняется, файл в 4 раза меньше.
const quantize = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));

// ---------- основной цикл ----------

function readOverrides() {
  const p = 'data/doklady.txt';
  const map = {};
  if (!fs.existsSync(p)) return map;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const [file, title, author] = line.split('|').map((s) => s?.trim());
    if (file) map[file.toLowerCase()] = { title, author };
  }
  return map;
}

// fs.cpSync падает на Windows с кириллицей в пути, поэтому копируем сами.
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (/\.(pdf|pptx|docx)$/i.test(e.name) && !e.name.startsWith('~$')) out.push(p);
  }
  return out.sort((a, b) => a.localeCompare(b, 'ru'));
}

const usedCache = new Set();

// Удаляет из кэша удалённые или заменённые презентации (только при сборке сайта в GitHub Actions,
// чтобы кэш не рос; локально в том же кэше лежат и тестовые доклады).
function pruneCache() {
  const dir = path.join(CACHE, 'docs');
  if (!process.env.CI || args.input || !fs.existsSync(dir)) return;
  for (const k of fs.readdirSync(dir)) if (!usedCache.has(k)) fs.rmSync(path.join(dir, k), { recursive: true, force: true });
}

async function processFile(file) {
  const buf = fs.readFileSync(file);
  const key = crypto.createHash('sha1').update(buf).update(`v${BUILD_VERSION}|${MODEL.id}|${MODEL.dtype}|${THUMB_WIDTH}`).digest('hex');
  const cdir = path.join(CACHE, 'docs', key);
  usedCache.add(key);
  const cjson = path.join(cdir, 'doc.json');
  if (fs.existsSync(cjson)) return { ...JSON.parse(fs.readFileSync(cjson, 'utf8')), cdir, cached: true };

  const ext = path.extname(file).toLowerCase();
  const t0 = Date.now();
  const r = ext === '.pdf' ? await extractPdf(buf) : ext === '.pptx' ? await extractPptx(buf, file) : await extractDocx(buf);
  fs.mkdirSync(cdir, { recursive: true });
  const thumbs = [];
  r.thumbs.forEach((t, i) => {
    if (!t) return thumbs.push(false);
    fs.writeFileSync(path.join(cdir, `${i + 1}.webp`), t);
    thumbs.push(true);
  });
  const docTitle = r.title || path.basename(file, ext);
  const frags = r.frags.map((f, i) => ({
    ...f,
    title: f.title || (f.text.split('\n')[0] || '').slice(0, 100),
    sents: splitSentences(f.text),
    thumb: thumbs[i],
  }));

  // Векторы: весь фрагмент + каждое предложение отдельно (для выбора «ответа»).
  const fragInputs = frags.map((f) => `${docTitle}. ${f.title}. ${f.text}`.slice(0, 1500));
  const sentInputs = frags.flatMap((f) => f.sents.map(([a, b]) => `${f.title}: ${f.text.slice(a, b)}`.slice(0, 600)));
  const vecs = (await embed([...fragInputs, ...sentInputs])).map((v) => Buffer.from(quantize(v).buffer).toString('base64'));

  const rec = {
    kind: ext.slice(1),
    title: docTitle,
    author: r.author || '',
    frags,
    fragVecs: vecs.slice(0, frags.length),
    sentVecs: vecs.slice(frags.length),
  };
  fs.writeFileSync(cjson, JSON.stringify(rec));
  log(`  обработан за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  return { ...rec, cdir, cached: false };
}

function pickExamples(frags, synGroups) {
  // Примеры запросов: слова из заголовков, которые встречаются в нескольких докладах.
  const stems = new Map();
  for (const f of frags) {
    const seen = new Set();
    for (const w of tokenize(f.title)) {
      // Прилагательные («банковское») как примеры запросов выглядят странно — пропускаем.
      if (w.length < 5 || /\d/.test(w) || /(ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ых|их)$/i.test(w)) continue;
      const s = processTerm(w);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      const e = stems.get(s) || { word: w.toLowerCase(), count: 0, docs: new Set() };
      e.count++; e.docs.add(f.doc);
      stems.set(s, e);
    }
  }
  const ranked = [...stems.values()].sort((a, b) => b.docs.size - a.docs.size || b.count - a.count);
  const ex = [];
  // Один пример — на синоним, чтобы показать, что поиск понимает близкие слова.
  const allText = new Set(frags.flatMap((f) => tokenize(f.title + ' ' + f.text).map(processTerm)));
  for (const g of synGroups) {
    const present = g.filter((w) => !w.includes(' ') && allText.has(processTerm(w)));
    const absent = g.filter((w) => !w.includes(' ') && !allText.has(processTerm(w)));
    if (present.length && absent.length) { ex.push(absent[0]); break; }
  }
  for (const r of ranked) {
    if (ex.length >= 5) break;
    if (!ex.includes(r.word)) ex.push(r.word);
  }
  return ex.slice(0, 5);
}

async function main() {
  const t0 = Date.now();
  const files = listFiles(INPUT);
  log(`Нашёл файлов в «${INPUT}»: ${files.length}`);
  const overrides = readOverrides();

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'thumbs'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'files'), { recursive: true });

  const docs = [];
  const frags = [];
  const fragVecs = [];
  const sentVecs = [];
  const failed = [];
  for (const file of files) {
    const rel = path.relative(INPUT, file);
    log(`• ${rel}`);
    let r;
    try {
      r = await processFile(file);
    } catch (e) {
      failed.push(rel);
      warn(`Не удалось прочитать «${rel}»: ${e.message}. Файл пропущен.`);
      continue;
    }
    const id = slugify(rel);
    const ov = overrides[path.basename(file).toLowerCase()] || {};
    const fileName = `${id}${path.extname(file).toLowerCase()}`;
    fs.copyFileSync(file, path.join(OUT, 'files', fileName));
    fs.mkdirSync(path.join(OUT, 'thumbs', id), { recursive: true });
    const di = docs.length;
    docs.push({
      id,
      title: ov.title || r.title,
      author: ov.author || r.author,
      kind: r.kind,
      file: `files/${fileName}`,
      name: path.basename(file),
      count: r.frags.length,
    });
    r.frags.forEach((f, i) => {
      let thumb = null;
      if (f.thumb) {
        fs.copyFileSync(path.join(r.cdir, `${f.n}.webp`), path.join(OUT, 'thumbs', id, `${f.n}.webp`));
        thumb = `thumbs/${id}/${f.n}.webp`;
      }
      frags.push({ doc: di, n: f.n, title: f.title, text: f.text, sents: f.sents, thumb, ...(f.ocr ? { ocr: 1 } : {}) });
      fragVecs.push(r.fragVecs[i]);
    });
    sentVecs.push(...r.sentVecs);
    log(`  «${docs[di].title}» — ${docs[di].author || 'автор не найден'}, ${r.kind === 'docx' ? 'фрагментов' : 'слайдов'}: ${r.frags.length}${r.cached ? ' (из кэша)' : ''}`);
  }
  if (ocrWorker) await ocrWorker.terminate();
  if (!failed.length) pruneCache();

  // Векторы: сначала все фрагменты, потом все предложения по порядку.
  const vecs = [...fragVecs, ...sentVecs].map((b) => Buffer.from(b, 'base64'));
  const dim = vecs[0]?.length || 0;
  fs.writeFileSync(path.join(OUT, 'data', 'vectors.bin'), Buffer.concat(vecs));

  // «Хабность» каждого вектора: средняя близость к пробным запросам (int16, ×10000).
  const probes = vecs.length ? await embed(HUB_PROBES, MODEL.queryPrefix) : [];
  const hub = new Int16Array(vecs.length);
  vecs.forEach((v, i) => {
    let t = 0;
    for (const p of probes) {
      let s = 0;
      for (let k = 0; k < dim; k++) s += p[k] * ((v[k] << 24) >> 24);
      t += s / 127;
    }
    hub[i] = Math.round((t / probes.length) * 10000);
  });
  fs.writeFileSync(path.join(OUT, 'data', 'hub.bin'), Buffer.from(hub.buffer));

  const synText = fs.existsSync(PATHS.synonyms) ? fs.readFileSync(PATHS.synonyms, 'utf8') : '';
  fs.writeFileSync(path.join(OUT, 'data', 'synonyms.txt'), synText);
  const synGroups = synText.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => l.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean));

  const index = {
    meta: {
      built: new Date().toISOString(),
      model: MODEL,
      transformers: pkg.dependencies['@huggingface/transformers'],
      dim,
      fragCount: frags.length,
      sentCount: sentVecs.length,
      examples: pickExamples(frags.map((f) => ({ ...f })), synGroups),
    },
    docs,
    frags,
  };
  fs.writeFileSync(path.join(OUT, 'data', 'index.json'), JSON.stringify(index));

  // Файлы сайта и библиотека поиска.
  copyDir(PATHS.site, OUT);
  fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
  fs.copyFileSync('node_modules/minisearch/dist/es/index.js', path.join(OUT, 'vendor', 'minisearch.js'));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  const size = (p) => fs.statSync(path.join(OUT, 'data', p)).size;
  log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(1)} с: докладов ${docs.length}, фрагментов ${frags.length}, предложений ${sentVecs.length}.`);
  log(`index.json ${(size('index.json') / 1024).toFixed(0)} КБ, vectors.bin ${(size('vectors.bin') / 1024).toFixed(0)} КБ → ${OUT}/`);
  if (failed.length) {
    warn(`Пропущены файлы (${failed.length}): ${failed.join(', ')}`);
    if (args.strict) process.exit(1);
  }
}

main().catch((e) => {
  console.error('Сборка упала:', e);
  process.exit(1);
});
