// Поиск по докладам: мгновенный слой (MiniSearch + стемминг + опечатки),
// словарь синонимов и смысловой слой (эмбеддинги, модель грузится в фоне в воркере).
import MiniSearch from './vendor/minisearch.js';
import { processTerm, normalizeWord, WORD_RE } from './stem.js';

const $ = (s) => document.querySelector(s);
const els = {
  q: $('#q'), clear: $('#clear'), status: $('#status'), examples: $('#examples'), docs: $('#docs'),
  legend: $('#legend'), results: $('#results'), viewer: $('#viewer'),
};
const params = new URLSearchParams(location.search);
const SEMANTIC_ENABLED = params.get('semantic') !== '0';
const RESULT_LIMIT = 30;

const S = {
  data: null, ms: null, docFilter: null, query: '',
  vocab: [], postings: new Map(), stemCache: new Map(), synGroups: [],
  model: 'off', worker: null, vectors: null, qvecCache: new Map(), pending: new Map(), reqId: 0,
  lastResults: [], timings: [],
};
window.__search = S; // для автотестов и отладки

// ---------- утилиты ----------

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
function stemOf(word) {
  let s = S.stemCache.get(word);
  if (s === undefined) { s = processTerm(word); S.stemCache.set(word, s); }
  return s;
}
function lev(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Есть ли в словаре докладов слово, начинающееся с этой основы (бинарный поиск).
function vocabHasPrefix(p) {
  let lo = 0, hi = S.vocab.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (S.vocab[mid] < p) lo = mid + 1; else hi = mid; }
  return lo < S.vocab.length && S.vocab[lo].startsWith(p);
}
function tokensWithPos(text) {
  const out = [];
  for (const m of text.matchAll(WORD_RE)) out.push({ w: m[0], a: m.index, b: m.index + m[0].length, s: stemOf(m[0]) });
  return out;
}
// Короткие основы («дан» у «дань») совпадают со всем подряд («данные»), поэтому для них
// после основы допускаем только обычное окончание.
const ENDINGS = new Set(['', 'а', 'я', 'о', 'е', 'и', 'ы', 'у', 'ю', 'ь', 'й', 'ей', 'ой', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ью', 'ов', 'ев', 'ами', 'ями']);
const shortStemOk = (word, stem) => stem.length >= 4 || ENDINGS.has(normalizeWord(word).slice(stem.length));

// ---------- загрузка ----------

async function load() {
  const res = await fetch('data/index.json');
  if (!res.ok) throw new Error('index.json: ' + res.status);
  S.data = await res.json();
  const { docs, frags } = S.data;

  const vocab = new Set();
  frags.forEach((f, i) => {
    f.id = i;
    f.docTitle = docs[f.doc].title;
    f.toks = null;
    for (const m of (f.title + ' ' + f.text).matchAll(WORD_RE)) {
      const s = stemOf(m[0]);
      if (!s) continue;
      vocab.add(s);
      let p = S.postings.get(s);
      if (!p) S.postings.set(s, (p = new Set()));
      p.add(i);
    }
  });
  S.vocab = [...vocab].sort();

  S.ms = new MiniSearch({
    fields: ['title', 'text'],
    idField: 'id',
    tokenize: (s) => s.match(WORD_RE) || [],
    processTerm: (t) => processTerm(t) || null,
    searchOptions: { boost: { title: 2.5, text: 1 }, weights: { prefix: 0.7, fuzzy: 0.45 } },
  });
  S.ms.addAll(frags);

  try {
    const syn = await (await fetch('data/synonyms.txt')).text();
    S.synGroups = parseSynonyms(syn);
  } catch { S.synGroups = []; }
}

function parseSynonyms(text) {
  return text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).map((line) =>
    line.split(',').map((raw) => raw.trim()).filter(Boolean).map((raw) => {
      const words = raw.match(WORD_RE) || [];
      const stems = words.map((w) => processTerm(w)).filter(Boolean);
      return { raw, words: words.filter((w) => processTerm(w)), stems };
    }).filter((p) => p.stems.length));
}

// ---------- мгновенный слой ----------

function queryTerms(q) {
  return (q.match(WORD_RE) || []).map((w) => ({ w, s: processTerm(w) })).filter((t) => t.s);
}

function lexicalSearch(q) {
  const terms = queryTerms(q);
  if (!terms.length) return { items: [], terms, ctx: emptyCtx() };
  const qs = terms.map((t) => t.s);
  const filter = S.docFilter == null ? undefined : (r) => S.data.frags[r.id].doc === S.docFilter;
  const raw = S.ms.search(qs.join(' '), {
    prefix: (t) => t.length >= 2,
    // Нечёткий поиск только для слов, которых нет в докладах: иначе «налог» нашёл бы «залог».
    fuzzy: (t) => (t.length >= 4 && !vocabHasPrefix(t) ? 0.25 : false),
    filter,
  });

  const ctx = emptyCtx();
  ctx.qs = qs;
  const items = raw.map((r) => {
    const kinds = new Set();
    for (const term of Object.keys(r.match)) {
      const qi = qs.findIndex((s) => sameRoot(term, s));
      if (qi >= 0) kinds.add('e');
      else {
        let best = 0, bd = 9;
        qs.forEach((s, i) => { const d = lev(s, term.slice(0, s.length + 1), 3); if (d < bd) { bd = d; best = i; } });
        ctx.fuzzy.set(term, best);
        kinds.add('f');
      }
    }
    // Титульный слайд повторяет название доклада и редко бывает ответом — чуть ниже.
    const f = S.data.frags[r.id];
    const cover = f.n === 1 && f.title === f.docTitle;
    return { id: r.id, score: r.score * (cover ? 0.6 : 1), kinds };
  });

  // Словарь синонимов: совпадения добавляются ниже точных.
  const syn = synonymMatches(terms, ctx);
  const byId = new Map(items.map((it) => [it.id, it]));
  const synOnly = [];
  for (const [id, sc] of syn) {
    if (S.docFilter != null && S.data.frags[id].doc !== S.docFilter) continue;
    const it = byId.get(id);
    if (it) { it.score *= 1 + Math.min(0.3, 0.1 * sc); it.kinds.add('s'); }
    else synOnly.push({ id, score: sc, kinds: new Set(['s']) });
  }
  items.sort((a, b) => b.score - a.score);
  synOnly.sort((a, b) => b.score - a.score);
  return { items: [...items, ...synOnly], terms, ctx };
}

function emptyCtx() {
  return { qs: [], fuzzy: new Map(), syn: new Map(), sem: null };
}

function stemMatchesQuery(phraseStem, qStem, isLast) {
  if (phraseStem === qStem) return true;
  if (isLast && qStem.length >= 4 && phraseStem.startsWith(qStem)) return true; // слово ещё дописывают
  return qStem.length >= 6 && lev(phraseStem, qStem, 1) <= 1; // опечатка
}

function synonymMatches(terms, ctx) {
  const qs = terms.map((t) => t.s);
  const scores = new Map();
  for (const group of S.synGroups) {
    // Какие слова запроса «включают» эту группу.
    let trigger = -1;
    const used = new Set();
    for (const p of group) {
      for (let i = 0; i + p.stems.length <= qs.length; i++) {
        if (p.stems.every((s, k) => stemMatchesQuery(s, qs[i + k], i + k === qs.length - 1))) {
          trigger = i;
          p.stems.forEach((s) => used.add(s));
        }
      }
    }
    if (trigger < 0) continue;
    for (const p of group) {
      if (p.stems.every((s) => used.has(s) || qs.includes(s))) continue;
      for (const [id, n] of phraseHits(p)) {
        scores.set(id, (scores.get(id) || 0) + n);
        p.stems.forEach((s) => { if (!ctx.syn.has(s)) ctx.syn.set(s, trigger); });
      }
    }
  }
  return scores;
}

// Фрагменты, где встречается фраза из словаря (слова фразы — рядом друг с другом).
function phraseHits(p) {
  const out = new Map();
  let cand = null;
  for (const s of p.stems) {
    const post = S.postings.get(s);
    if (!post) return out;
    cand = cand ? new Set([...cand].filter((x) => post.has(x))) : new Set(post);
  }
  for (const id of cand) {
    const f = S.data.frags[id];
    f.toks ??= tokensWithPos(f.text);
    const titleToks = tokensWithPos(f.title);
    let n = 0;
    const scan = (toks, w) => {
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].s !== p.stems[0] || !shortStemOk(toks[i].w, p.stems[0])) continue;
        let j = i, ok = true;
        for (let k = 1; k < p.stems.length && ok; k++) {
          const lim = Math.min(toks.length, j + 4);
          let found = -1;
          for (let x = j + 1; x < lim; x++) if (toks[x].s === p.stems[k]) { found = x; break; }
          if (found < 0) ok = false; else j = found;
        }
        if (ok) n += w;
      }
    };
    scan(titleToks, 2.5);
    scan(f.toks, 1);
    if (n) out.set(id, n);
  }
  return out;
}

// ---------- смысловой слой ----------

function startModel() {
  const meta = S.data.meta;
  if (!SEMANTIC_ENABLED || !meta.dim || !('Worker' in window)) { setModel('off'); return; }
  setModel('loading', 0);
  try {
    S.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch { setModel('error'); return; }
  S.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') setModel('loading', m.progress);
    else if (m.type === 'ready') loadVectors();
    else if (m.type === 'error') { console.warn('Модель не загрузилась:', m.message); setModel('error'); }
    else if (m.type === 'vec') {
      const cb = S.pending.get(m.id);
      S.pending.delete(m.id);
      cb?.(m.vec);
    }
  };
  S.worker.onerror = (e) => { console.warn('Ошибка воркера', e.message); setModel('error'); };
  S.worker.postMessage({ type: 'init', model: meta.model, version: meta.transformers });
}

async function loadVectors() {
  try {
    const [vb, hb] = await Promise.all(['data/vectors.bin', 'data/hub.bin'].map(async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(u + ': ' + r.status);
      return r.arrayBuffer();
    }));
    S.hub = Float32Array.from(new Int16Array(hb), (x) => x / 10000);
    S.vectors = new Int8Array(vb);
    const { frags, meta } = S.data;
    let off = meta.fragCount;
    for (const f of frags) { f.sentBase = off; off += f.sents.length; }
    setModel('ready');
    if (S.query) scheduleSemantic(S.query);
  } catch (e) {
    console.warn(e);
    setModel('error');
  }
}

function setModel(state, progress) {
  S.model = state;
  const t = {
    loading: `<span class="dot wait"></span>Поиск по словам работает. ${progress >= 99.5 ? 'Запускаю смысловую модель…' : `Загружаю смысловую модель${progress ? ` — ${Math.round(progress)}%` : '…'}`}`,
    ready: '<span class="dot ok"></span>Поиск по словам и по смыслу',
    error: '<span class="dot"></span>Смысловая модель не загрузилась — работает поиск по словам и синонимам',
    off: '<span class="dot"></span>Поиск по словам и синонимам',
  }[state];
  els.status.innerHTML = t;
  els.status.dataset.model = state;
}

function embedQuery(q) {
  if (S.qvecCache.has(q)) return Promise.resolve(S.qvecCache.get(q));
  return new Promise((resolve) => {
    const id = ++S.reqId;
    S.pending.set(id, (v) => { S.qvecCache.set(q, v); resolve(v); });
    S.worker.postMessage({ type: 'embed', id, text: S.data.meta.model.queryPrefix + q });
  });
}

let semTimer = 0;
function scheduleSemantic(q) {
  clearTimeout(semTimer);
  if (S.model !== 'ready' || !queryTerms(q).length) return;
  semTimer = setTimeout(async () => {
    const vec = await embedQuery(q);
    if (q !== S.query) return;
    render(q, vec);
  }, S.qvecCache.has(q) ? 0 : 160);
}

// Косинусная близость запроса к вектору №row минус его «хабность» (средняя близость
// к случайным запросам): так короткие и общие слайды не всплывают на любой запрос.
function sim(vec, row) {
  const dim = vec.length, base = row * dim, v = S.vectors;
  let s = 0;
  for (let k = 0; k < dim; k++) s += vec[k] * v[base + k];
  return s / 127 - S.hub[row];
}

// Ниже — обычно шум: «футбольный чемпионат» даёт ~0.08, осмысленные запросы — 0.09–0.2
// (подобрано на тестовых докладах; если смысловой поиск находит мусор — поднимите).
const SEM_MIN = 0.09;
const SEM_WINDOW = 0.06; // и не сильно хуже лучшего результата

function semanticSearch(vec) {
  const out = [];
  for (const f of S.data.frags) {
    if (S.docFilter != null && f.doc !== S.docFilter) continue;
    let best = sim(vec, f.id);
    for (let k = 0; k < f.sents.length; k++) best = Math.max(best, sim(vec, f.sentBase + k));
    out.push({ id: f.id, sim: best });
  }
  out.sort((a, b) => b.sim - a.sim);
  if (!out.length) return [];
  const top = out[0].sim;
  return out.filter((r, i) => i < 15 && r.sim >= Math.max(SEM_MIN, top - SEM_WINDOW));
}

// Reciprocal Rank Fusion: складываем 1/(60 + место) из обоих списков.
function fuse(lex, sem) {
  const K = 60;
  const m = new Map();
  lex.forEach((it, i) => m.set(it.id, { ...it, rrf: 1 / (K + i + 1) + 1e-6 }));
  sem.forEach((s, i) => {
    const cur = m.get(s.id);
    if (cur) { cur.rrf += 1 / (K + i + 1); cur.sem = s; }
    else m.set(s.id, { id: s.id, score: 0, kinds: new Set(['m']), sem: s, rrf: 1 / (K + i + 1) });
  });
  return [...m.values()].sort((a, b) => b.rrf - a.rrf);
}

// ---------- подсветка и выбор предложения ----------

// Основа слова из текста продолжает основу из запроса («кред» → «кредитован»)
// или чуть короче её (Snowball режет «кредит» до «кред», а «кредиты» — до «кредит»).
const sameRoot = (s, q) => s.startsWith(q) || (s.length >= 4 && q.length - s.length <= 2 && q.startsWith(s));

function tokenKind(tok, ctx) {
  if (!tok.s) return null;
  if (ctx.qs.some((q) => sameRoot(tok.s, q))) return 'e';
  if (ctx.fuzzy.has(tok.s)) return 'f';
  if (ctx.syn.has(tok.s) && shortStemOk(tok.w, tok.s)) return 's';
  return null;
}

function highlight(text, ctx) {
  let out = '', pos = 0;
  for (const t of tokensWithPos(text)) {
    const k = tokenKind(t, ctx);
    if (!k) continue;
    out += esc(text.slice(pos, t.a)) + `<mark class="m-${k}">${esc(text.slice(t.a, t.b))}</mark>`;
    pos = t.b;
  }
  return out + esc(text.slice(pos));
}

function sentenceTokens(f) {
  f.sentToks ??= f.sents.map(([a, b]) => tokensWithPos(f.text.slice(a, b)));
  return f.sentToks;
}

function sentenceScores(f, ctx, sem) {
  const res = [];
  const toks = sentenceTokens(f);
  f.sents.forEach(([a, b], k) => {
    const s = f.text.slice(a, b);
    const covered = new Set();
    let sc = 0;
    for (const t of toks[k]) {
      const kind = tokenKind(t, ctx);
      if (!kind) continue;
      sc += kind === 'e' ? 1 : kind === 'f' ? 0.7 : 0.6;
      const qi = kind === 'e' ? ctx.qs.findIndex((q) => sameRoot(t.s, q))
        : kind === 'f' ? ctx.fuzzy.get(t.s) : ctx.syn.get(t.s);
      covered.add(qi);
    }
    sc += covered.size * 3;
    if (sem && S.vectors) sc += Math.max(0, sim(ctx.qvec, f.sentBase + k)) * 20;
    if (s.trim() === f.title.trim()) sc *= 0.4; // заголовок и так виден
    if (s.length < 25) sc *= 0.7;
    res.push({ k, a, b, sc, lexical: covered.size > 0 });
  });
  return res;
}

function bestSentence(f, ctx, item) {
  const scored = sentenceScores(f, ctx, !!item.sem);
  if (!scored.length) return null;
  let best = scored[0];
  for (const s of scored) if (s.sc > best.sc) best = s;
  if (best.sc <= 0) {
    const firstBody = scored.find((s) => f.text.slice(s.a, s.b).trim() !== f.title.trim());
    best = firstBody || best;
  }
  return best;
}

function renderSentence(f, s, ctx, item) {
  if (!s) return highlight(f.title, ctx);
  let text = f.text.slice(s.a, s.b).trim();
  const html = highlight(text, ctx);
  const semOnly = item.sem && !s.lexical;
  return semOnly ? `<span class="m-sem">${html}</span>` : html;
}

function snippet(f, ctx, item) {
  const s = bestSentence(f, ctx, item);
  if (!s) return { html: '', s };
  let html = renderSentence(f, s, ctx, item);
  // Если предложение короткое — добавим следующее, чтобы был контекст.
  const next = f.sents[s.k + 1];
  if (f.text.slice(s.a, s.b).length < 110 && next) html += ' ' + highlight(f.text.slice(next[0], next[1]).trim(), ctx);
  return { html, s };
}

// ---------- отрисовка ----------

function thumbHtml(f, big = false) {
  const d = S.data.docs[f.doc];
  if (f.thumb) {
    return `<img src="${f.thumb}" alt="${esc(`${d.title}, ${unitName(d)} ${f.n}`)}" loading="${big ? 'eager' : 'lazy'}" decoding="async" width="720" height="405">`;
  }
  return `<span class="tcard"><b>${esc(f.title)}</b>${esc(f.text.slice(0, big ? 600 : 140))}</span>`;
}
const unitName = (d) => (d.kind === 'docx' ? 'фрагмент' : 'слайд');
function sourceHtml(f) {
  const d = S.data.docs[f.doc];
  return `<b>${esc(d.title)}</b>${d.author ? ` · ${esc(d.author)}` : ''} · ${unitName(d)} ${f.n}`;
}

function itemHtml(it, rank, ctx) {
  const g = S.data.frags[it.id];
  const d = S.data.docs[g.doc];
  const sn = snippet(g, ctx, it);
  const onlySem = it.kinds.size === 1 && it.kinds.has('m');
  const onlySyn = !it.kinds.has('e') && !it.kinds.has('f') && it.kinds.has('s');
  return `<article class="item" data-doc="${d.id}" data-n="${g.n}" data-rank="${rank}">
    <button class="thumb" type="button" data-open="${g.id}" aria-label="Открыть ${unitName(d)} ${g.n} крупно">${thumbHtml(g)}</button>
    <div><div class="item-meta">${esc(d.title)} · ${unitName(d)} ${g.n}${onlySem ? '<span class="badge">по смыслу</span>' : onlySyn ? '<span class="badge">синоним</span>' : ''}${g.ocr ? '<span class="badge">текст с картинки</span>' : ''}</div>
    <button class="item-title" type="button" data-open="${g.id}">${highlight(g.title, ctx)}</button>
    <p class="item-snip">${sn.html}</p></div>
  </article>`;
}

const FIRST_BATCH = 5;
let renderToken = 0;

function render(q, qvec = null) {
  const t0 = performance.now();
  renderToken++;
  const lex = lexicalSearch(q);
  const ctx = lex.ctx;
  let items = lex.items;
  if (qvec && S.vectors) {
    ctx.qvec = qvec;
    items = fuse(items, semanticSearch(qvec));
  }
  items = items.slice(0, RESULT_LIMIT);
  S.lastResults = items.map((it) => ({ doc: S.data.docs[S.data.frags[it.id].doc].id, n: S.data.frags[it.id].n, kinds: [...it.kinds] }));

  if (!lex.terms.length) {
    renderHome();
  } else if (!items.length) {
    els.legend.hidden = true;
    els.results.innerHTML = `<div class="empty">Ничего не нашлось по запросу «${esc(q)}».${S.docFilter != null ? ' Попробуйте искать во всех докладах.' : ''}${S.model === 'loading' ? ' Скоро подключится поиск по смыслу — он может найти больше.' : ''}</div>`;
  } else {
    els.legend.hidden = false;
    const [first, ...rest] = items;
    const f = S.data.frags[first.id];
    const s = bestSentence(f, ctx, first);
    let html = `<article class="answer" data-doc="${S.data.docs[f.doc].id}" data-n="${f.n}" data-rank="1">
      <div><div class="answer-label">Ответ</div>
      <p class="answer-text">${renderSentence(f, s, ctx, first)}</p>
      <div class="source">${sourceHtml(f)}${f.title ? ` — «${esc(f.title)}»` : ''}</div></div>
      <button class="thumb" type="button" data-open="${f.id}" aria-label="Открыть ${unitName(S.data.docs[f.doc])} крупно">${thumbHtml(f, true)}</button>
    </article>`;
    if (rest.length) html += `<div class="list-head">Ещё ${rest.length} ${plural(rest.length, 'фрагмент', 'фрагмента', 'фрагментов')}</div>`;
    // Сразу рисуем ответ и первые карточки, остальные — следующим кадром, чтобы ввод не тормозил.
    const now = rest.slice(0, FIRST_BATCH), later = rest.slice(FIRST_BATCH);
    els.results.innerHTML = html + now.map((it, i) => itemHtml(it, i + 2, ctx)).join('');
    if (later.length) {
      const token = renderToken;
      requestAnimationFrame(() => {
        if (token !== renderToken) return;
        els.results.insertAdjacentHTML('beforeend', later.map((it, i) => itemHtml(it, i + 2 + FIRST_BATCH, ctx)).join(''));
      });
    }
  }
  const ms = performance.now() - t0;
  S.timings.push({ q, ms, semantic: !!qvec });
  els.results.dataset.ms = ms.toFixed(1);
  els.results.dataset.query = q;
  els.results.dataset.semantic = qvec ? '1' : '0';
}

function renderHome() {
  els.legend.hidden = true;
  const { docs, frags } = S.data;
  if (!docs.length) {
    els.results.innerHTML = '<div class="empty">Пока нет ни одного доклада. Загрузите файлы в папку presentations на GitHub.</div>';
    return;
  }
  if (S.docFilter != null) {
    const d = docs[S.docFilter];
    const list = frags.filter((f) => f.doc === S.docFilter);
    els.results.innerHTML = `<div class="list-head">${esc(d.title)}${d.author ? ` · ${esc(d.author)}` : ''} — ${list.length} ${plural(list.length, unitName(d), unitName(d) === 'слайд' ? 'слайда' : 'фрагмента', unitName(d) === 'слайд' ? 'слайдов' : 'фрагментов')}</div>` +
      list.map((g) => `<article class="item" data-doc="${d.id}" data-n="${g.n}">
        <button class="thumb" type="button" data-open="${g.id}" aria-label="Открыть ${unitName(d)} ${g.n} крупно">${thumbHtml(g)}</button>
        <div><div class="item-meta">${unitName(d)} ${g.n}</div>
        <button class="item-title" type="button" data-open="${g.id}">${esc(g.title)}</button>
        <p class="item-snip">${esc(g.text.slice(0, 220))}${g.text.length > 220 ? '…' : ''}</p></div></article>`).join('');
    return;
  }
  els.results.innerHTML = `<div class="list-head">Все доклады: ${docs.length}</div><div class="doc-grid">` +
    docs.map((d, i) => {
      const f = frags.find((x) => x.doc === i);
      return `<button class="doc-card" type="button" data-open="${f?.id ?? ''}">
        <span class="thumb">${f ? thumbHtml(f) : ''}</span>
        <span class="dc-body"><span class="dc-title">${esc(d.title)}</span>
        <span class="dc-meta">${d.author ? esc(d.author) + ' · ' : ''}${d.count} ${d.kind === 'docx' ? plural(d.count, 'фрагмент', 'фрагмента', 'фрагментов') : plural(d.count, 'слайд', 'слайда', 'слайдов')}</span></span>
      </button>`;
    }).join('') + '</div>';
}

// ---------- просмотр слайда ----------

const V = { id: null, ctx: emptyCtx() };
function openViewer(id) {
  const f = S.data.frags[id];
  if (!f) return;
  V.id = id;
  const d = S.data.docs[f.doc];
  const lex = S.query ? lexicalSearch(S.query) : null;
  V.ctx = lex ? lex.ctx : emptyCtx();
  $('#v-meta').innerHTML = `<b>${esc(d.title)}</b>${d.author ? ` · ${esc(d.author)}` : ''} · ${unitName(d)} ${f.n} из ${d.count}`;
  $('#v-img').innerHTML = `<div class="thumb">${thumbHtml(f, true)}</div>`;
  $('#v-title').innerHTML = highlight(f.title, V.ctx);
  // Заголовок уже показан выше — не повторяем его первой строкой текста.
  const body = f.text.startsWith(f.title + '\n') ? f.text.slice(f.title.length + 1) : f.text;
  $('#v-text').innerHTML = highlight(body, V.ctx);
  $('#v-file').href = d.file;
  $('#v-file').textContent = `Открыть исходный файл (${d.kind.toUpperCase()})`;
  $('#v-prev').disabled = !S.data.frags[id - 1] || S.data.frags[id - 1].doc !== f.doc;
  $('#v-next').disabled = !S.data.frags[id + 1] || S.data.frags[id + 1].doc !== f.doc;
  if (!els.viewer.open) els.viewer.showModal();
  $('.v-body').scrollTop = 0;
}
function step(dir) {
  const f = S.data.frags[V.id];
  const g = S.data.frags[V.id + dir];
  if (g && g.doc === f.doc) openViewer(V.id + dir);
}

// ---------- события ----------

let urlTimer = 0;
function updateUrl(push) {
  clearTimeout(urlTimer);
  const u = new URL(location.href);
  if (S.query) u.searchParams.set('q', S.query); else u.searchParams.delete('q');
  if (S.docFilter != null) u.searchParams.set('doc', S.data.docs[S.docFilter].id); else u.searchParams.delete('doc');
  if (u.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', u);
}

function setQuery(q, { push = false } = {}) {
  S.query = q;
  els.clear.hidden = !q;
  render(q, S.qvecCache.get(q) || null);
  // Адрес обновляем не на каждую букву: браузеры ограничивают частые изменения истории.
  if (push) updateUrl(true);
  else { clearTimeout(urlTimer); urlTimer = setTimeout(() => updateUrl(false), 250); }
  scheduleSemantic(q);
}

function renderChips() {
  const ex = S.data.meta.examples || [];
  els.examples.innerHTML = ex.map((w) => `<button class="chip" type="button" data-q="${esc(w)}">${esc(w)}</button>`).join('');
  els.examples.previousElementSibling.hidden = !ex.length;
  const docs = S.data.docs;
  els.docs.innerHTML = `<button class="chip" type="button" data-doc="" aria-pressed="${S.docFilter == null}">Все доклады</button>` +
    docs.map((d, i) => `<button class="chip" type="button" data-doc="${i}" aria-pressed="${S.docFilter === i}" title="${esc(d.title)}${d.author ? ' — ' + esc(d.author) : ''}">${esc(d.title)}</button>`).join('');
}

function bind() {
  els.q.addEventListener('input', () => setQuery(els.q.value));
  els.clear.addEventListener('click', () => { els.q.value = ''; setQuery(''); els.q.focus(); });
  els.examples.addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (b) { els.q.value = b.dataset.q; setQuery(b.dataset.q, { push: true }); }
  });
  els.docs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-doc]');
    if (!b) return;
    S.docFilter = b.dataset.doc === '' ? null : +b.dataset.doc;
    renderChips();
    setQuery(S.query, { push: true });
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b && b.dataset.open !== '') openViewer(+b.dataset.open);
  });
  $('#v-close').addEventListener('click', () => els.viewer.close());
  $('#v-prev').addEventListener('click', () => step(-1));
  $('#v-next').addEventListener('click', () => step(1));
  els.viewer.addEventListener('click', (e) => { if (e.target === els.viewer) els.viewer.close(); });
  document.addEventListener('keydown', (e) => {
    if (!els.viewer.open) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
  let tx = null;
  els.viewer.addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
  els.viewer.addEventListener('touchend', (e) => {
    if (tx == null) return;
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    tx = null;
  });
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* приватный режим */ }
  });
  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    const di = S.data.docs.findIndex((d) => d.id === p.get('doc'));
    S.docFilter = di >= 0 ? di : null;
    els.q.value = p.get('q') || '';
    renderChips();
    S.query = els.q.value;
    els.clear.hidden = !S.query;
    render(S.query, S.qvecCache.get(S.query) || null);
    scheduleSemantic(S.query);
  });
}

async function main() {
  try {
    await load();
  } catch (e) {
    console.error(e);
    els.status.textContent = 'Не удалось загрузить данные поиска. Обновите страницу.';
    return;
  }
  const di = S.data.docs.findIndex((d) => d.id === params.get('doc'));
  S.docFilter = di >= 0 ? di : null;
  const q = params.get('q') || '';
  els.q.value = q;
  S.query = q;
  els.clear.hidden = !q;
  renderChips();
  bind();
  render(q);
  setModel(SEMANTIC_ENABLED ? 'loading' : 'off');
  document.body.dataset.ready = '1';
  S.semanticDebug = async (text) => semanticSearch(await embedQuery(text)).map((r) => ({ ...r, title: S.data.frags[r.id].title }));
  // Модель грузим, когда страница уже показана и ответила на первый запрос.
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 300));
  idle(() => {
    // Прогрев: разбираем предложения и один раз прогоняем поиск, чтобы первая буква не тормозила.
    for (const f of S.data.frags) sentenceTokens(f);
    const w = S.data.meta.examples?.[0];
    if (w) { const lx = lexicalSearch(w); lx.items.slice(0, FIRST_BATCH + 1).forEach((it, i) => itemHtml(it, i, lx.ctx)); }
    startModel();
  });
}

main();
