import { test, expect } from '@playwright/test';

// Запрос → какой слайд должен оказаться в первой тройке.
const CASES = [
  { q: 'кредит', doc: 'Банковское дело', n: 4, why: 'форма слова (кредиты, кредитование)' },
  { q: 'кредитования', doc: 'Банковское дело', n: 2, why: 'другая форма слова' },
  { q: 'урбанизацыя', doc: 'Урбанизация', n: 2, why: 'опечатка' },
  { q: 'урбонизация', doc: 'Урбанизация', n: 2, why: 'опечатка в середине слова' },
  { q: 'урбан', doc: 'Урбанизация', n: 2, why: 'неполное слово' },
  { q: 'банкротство', doc: 'Банковское дело', n: 5, why: 'синоним: несостоятельность, невозврат долга' },
  { q: 'налоги', doc: 'Налоговая система', n: [2, 3, 4], why: 'синонимы: дань, пошлины, тариф' },
  { q: 'городская дума', doc: 'Урбанизация', n: 4, why: 'два слова' },
  { q: 'золотой стандарт', doc: 'Банковское дело', n: 6, why: 'словосочетание' },
  { q: 'выборы в думу', doc: 'Политические партии', n: 2, why: 'PPTX' },
  { q: 'учетный процент', doc: 'Банковское дело', n: 7, why: 'текст распознан с картинки (OCR), ё/е' },
  { q: 'кадеты', doc: 'Политические партии', n: 3, why: 'PPTX, форма слова' },
];

async function loadIndex(page) {
  return page.evaluate(async () => (await fetch('data/index.json')).json());
}

// Вводит запрос по буквам; после каждой буквы мерит, сколько занял поиск с перерисовкой.
async function typeAndMeasure(page, q) {
  await page.fill('#q', '');
  const times = [];
  for (let i = 1; i <= q.length; i++) {
    const ms = await page.evaluate((v) => {
      const el = document.querySelector('#q');
      const t = performance.now();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      void document.body.offsetHeight; // учитываем и раскладку страницы
      return performance.now() - t;
    }, q.slice(0, i));
    times.push(ms);
  }
  return times;
}

async function top3(page) {
  return page.$$eval('[data-rank]', (els) => els.slice(0, 3).map((e) => `${e.dataset.doc}#${e.dataset.n}`));
}

test.describe('мгновенный слой (без смысловой модели)', () => {
  for (const c of CASES) {
    test(`«${c.q}» — ${c.why}`, async ({ page }) => {
      await page.goto('./?semantic=0');
      await page.waitForSelector('body[data-ready="1"]');
      const index = await loadIndex(page);
      const doc = index.docs.find((d) => d.title.includes(c.doc));
      expect(doc, `доклад «${c.doc}»`).toBeTruthy();

      const times = await typeAndMeasure(page, c.q);
      const got = await top3(page);
      const want = [c.n].flat().map((n) => `${doc.id}#${n}`);
      expect(got.some((g) => want.includes(g)), `в первой тройке ${got.join(', ')} должен быть слайд ${c.n} доклада «${doc.title}»`).toBeTruthy();
      expect(Math.max(...times), `время по буквам: ${times.map((t) => t.toFixed(1)).join(', ')} мс`).toBeLessThan(50);

      // Карточка «Ответ» с подсветкой и источником.
      await expect(page.locator('.answer .answer-text')).not.toBeEmpty();
      await expect(page.locator('.answer .source')).toContainText(doc.title);
      expect(await page.locator('#results mark').count()).toBeGreaterThan(0);
      // Запрос сохраняется в адресе.
      await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(c.q);
    });
  }

  test('ответ быстрее 50 мс и на ~800 фрагментах', async ({ page }) => {
    await page.goto('./stress/?semantic=0');
    await page.waitForSelector('body[data-ready="1"]');
    const all = [];
    for (const q of ['кредит', 'урбанизацыя', 'банкротство', 'налоги', 'городская дума']) all.push(...(await typeAndMeasure(page, q)));
    all.sort((a, b) => a - b);
    console.log(`  800 фрагментов: медиана ${all[all.length >> 1].toFixed(1)} мс, максимум ${all.at(-1).toFixed(1)} мс`);
    expect(all.at(-1)).toBeLessThan(50);
  });

  test('синонимы ниже точных совпадений, подсветка разными стилями', async ({ page }) => {
    await page.goto('./?semantic=0&q=' + encodeURIComponent('кризис'));
    await page.waitForSelector('body[data-ready="1"]');
    const kinds = await page.evaluate(() => window.__search.lastResults.map((r) => r.kinds));
    const firstSynOnly = kinds.findIndex((k) => !k.includes('e') && !k.includes('f'));
    const lastExact = kinds.map((k) => k.includes('e')).lastIndexOf(true);
    expect(firstSynOnly === -1 || firstSynOnly > lastExact).toBeTruthy();
    await expect(page.locator('#legend')).toBeVisible();
    await page.fill('#q', 'урбонизация');
    await expect(page.locator('#results mark.m-f').first()).toBeVisible();
    await page.fill('#q', 'банкротство');
    await expect(page.locator('#results mark.m-s').first()).toBeVisible();
  });

  test('ссылка с ?q= открывает тот же поиск, пустой запрос — список докладов', async ({ page }) => {
    await page.goto('./?semantic=0&q=' + encodeURIComponent('золотой стандарт'));
    await expect(page.locator('#q')).toHaveValue('золотой стандарт');
    await expect(page.locator('.answer')).toContainText('золотой стандарт');
    await page.fill('#q', '');
    await expect(page.locator('.doc-card')).toHaveCount(4);
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBeNull();
  });

  test('фильтр по докладу', async ({ page }) => {
    await page.goto('./?semantic=0');
    await page.waitForSelector('body[data-ready="1"]');
    await page.locator('#docs .chip', { hasText: 'Урбанизация' }).click();
    await page.fill('#q', 'реформа');
    const docs = await page.$$eval('[data-rank]', (els) => [...new Set(els.map((e) => e.dataset.doc))]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toContain('urbanizaciya');
  });

  test('просмотр слайда: крупно, полный текст, листание стрелками', async ({ page }) => {
    await page.goto('./?semantic=0&q=' + encodeURIComponent('сельский кредит'));
    await page.locator('.answer .thumb').click();
    const dlg = page.locator('#viewer');
    await expect(dlg).toBeVisible();
    await expect(page.locator('#v-meta')).toContainText('слайд 4 из 8');
    await expect(page.locator('#v-text')).toContainText('Крестьянский поземельный банк');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#v-meta')).toContainText('слайд 5 из 8');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#v-meta')).toContainText('слайд 3 из 8');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  });
});

test.describe('без смысловой модели (не загрузилась)', () => {
  test('сайт открывается и ищет, если CDN и huggingface недоступны', async ({ page }) => {
    await page.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net/, (r) => r.abort());
    await page.goto('./');
    await page.waitForSelector('body[data-ready="1"]');
    await page.fill('#q', 'урбанизацыя');
    await expect(page.locator('.answer')).toContainText('урбанизац', { ignoreCase: true });
    await expect(page.locator('#status')).toHaveAttribute('data-model', 'error', { timeout: 30_000 });
    await page.fill('#q', 'банкротство');
    await expect(page.locator('.answer .source')).toContainText('Банковское дело');
  });
});

test.describe('смысловой слой (нужен интернет)', () => {
  test.skip(!!process.env.OFFLINE, 'OFFLINE=1 — пропускаем');
  test.setTimeout(180_000);

  test('модель загружается и находит по смыслу', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#status')).toHaveAttribute('data-model', 'ready', { timeout: 150_000 });
    const index = await loadIndex(page);
    const city = index.docs.find((d) => d.title.includes('Урбанизация'));
    // Ни одного общего слова со слайдом — только смысл.
    await page.fill('#q', 'переезд деревенских жителей');
    await expect(page.locator('#results')).toHaveAttribute('data-semantic', '1', { timeout: 10_000 });
    expect(await top3(page)).toContain(`${city.id}#2`);
    await expect(page.locator('.answer .m-sem')).toBeVisible();
    // Запрос не по теме не должен притягивать случайные слайды.
    await page.fill('#q', 'футбольный чемпионат');
    await expect(page.locator('#results')).toHaveAttribute('data-semantic', '1', { timeout: 10_000 });
    await expect(page.locator('.empty')).toBeVisible();
  });
});
