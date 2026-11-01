// Генерирует тестовые доклады в tests/fixtures/ (2 PDF, DOCX, PPTX).
// Запуск: node tests/make-fixtures.mjs  (нужен Chromium из Playwright: npx playwright install chromium)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import JSZip from 'jszip';

const OUT = 'tests/fixtures';
fs.mkdirSync(OUT, { recursive: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- PDF ----------

const bank = {
  file: 'Банковское дело в Российской империи.pdf',
  slides: [
    { title: 'Банковское дело в Российской империи', cover: ['Доклад по курсу «Экономическая история»', 'Выполнила: Смирнова Анна, группа ЭИ-21', 'Москва, 2026'] },
    { title: 'Государственный банк', body: ['Государственный банк Российской империи учреждён в 1860 году на базе Государственного коммерческого банка.', 'Его задачей было оживление торговли и упрочение денежной кредитной системы.', 'Банк занимался кредитованием промышленности и железнодорожного строительства.'] },
    { title: 'Акционерные коммерческие банки', body: ['Первый частный акционерный банк открылся в Петербурге в 1864 году.', 'Коммерческие банки принимали вклады и выдавали кредиты купцам под залог товаров.', 'К 1914 году в стране действовало около пятидесяти акционерных банков.'] },
    { title: 'Сельский кредит', body: ['Крестьянский поземельный банк основан в 1882 году.', 'Он выдавал крестьянам ссуды на покупку помещичьей земли на срок до 55 лет.', 'Дворянский банк предоставлял помещикам дешёвые займы под залог имений.'] },
    { title: 'Банковские кризисы', body: ['Крах Скопинского банка в 1882 году стал крупнейшим финансовым скандалом эпохи.', 'Причиной стала несостоятельность банка: вклады раздавались без обеспечения.', 'Массовый невозврат долга заёмщиками разорил тысячи мелких вкладчиков.'] },
    { title: 'Денежная реформа Витте', body: ['В 1897 году министр финансов Сергей Витте ввёл золотой стандарт.', 'Бумажный рубль стал свободно обмениваться на золото.', 'Устойчивая валюта привлекла в Россию иностранные инвестиции.'] },
    { image: ['Ставка учётного процента', 'Государственного банка', 'в 1900 году составляла', 'пять с половиной процентов'] },
    { title: 'Выводы', body: ['Банковская система империи сложилась во второй половине XIX века.', 'Государство сохраняло контроль над кредитом через Государственный банк.'] },
  ],
};

const city = {
  file: 'Урбанизация и рост городов в XIX веке.pdf',
  slides: [
    { title: 'Урбанизация и рост городов в XIX веке', cover: ['Доклад по истории городов', 'Автор: Петров Иван Сергеевич'] },
    { title: 'Причины урбанизации', body: ['Отмена крепостного права в 1861 году освободила миллионы крестьян.', 'Промышленный переворот создал спрос на рабочую силу в городах.', 'Городское население империи за полвека выросло втрое.'] },
    { title: 'Промышленные центры', body: ['Иваново-Вознесенск называли русским Манчестером.', 'Фабричные посёлки быстро превращались в города.'] },
    { title: 'Городская реформа 1870 года', body: ['Городовое положение 1870 года ввело всесословные городские думы.', 'Избирательное право определялось имущественным цензом.', 'Дума избирала городскую управу и городского голову.'] },
    { title: 'Жилищный вопрос', body: ['Рабочие жили в казармах при фабриках и в подвалах доходных домов.', 'Скученность и антисанитария вызывали эпидемии холеры.'] },
    { title: 'Городское хозяйство', body: ['Московский водопровод из Мытищ перестроили в 1890-х годах.', 'Появились конка, электрическое освещение улиц и трамвай.'] },
  ],
};

function slideHtml(s, i, total) {
  const tag = `<div class="tag">Блок ${i + 1} из ${total}</div><div class="num">${i + 1}</div>`;
  if (s.cover) return `<section class="cover">${tag}<h1>${esc(s.title)}</h1>${s.cover.map((c) => `<p>${esc(c)}</p>`).join('')}</section>`;
  if (s.image) return `<section>${tag}<img data-lines="${encodeURIComponent(JSON.stringify(s.image))}"></section>`;
  return `<section>${tag}<h2>${esc(s.title)}</h2><ul>${s.body.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></section>`;
}

const css = `
@page { size: 1280px 720px; margin: 0 }
body { margin: 0; font-family: Arial, sans-serif; }
section { width: 1280px; height: 720px; box-sizing: border-box; padding: 70px 90px; position: relative; page-break-after: always; background: #f6f4ef; color: #222; overflow: hidden }
.tag { position: absolute; top: 24px; right: 40px; font-size: 14px; color: #888 }
.num { position: absolute; bottom: 24px; right: 40px; font-size: 14px; color: #888 }
h1 { font-size: 58px; margin-top: 180px } h2 { font-size: 44px; margin: 0 0 40px }
.cover p { font-size: 26px } li { font-size: 28px; margin-bottom: 18px; line-height: 1.3 }
img { display: block; margin: 40px auto; width: 1000px }`;

async function makePdf(browser, deck) {
  const page = await browser.newPage();
  const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>${deck.slides.map((s, i) => slideHtml(s, i, deck.slides.length)).join('')}`;
  await page.setContent(html);
  // Слайд-картинка: текст нарисован на canvas, поэтому в PDF он не извлекается — только OCR.
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('img[data-lines]')) {
      const lines = JSON.parse(decodeURIComponent(img.dataset.lines));
      const c = document.createElement('canvas');
      c.width = 1000; c.height = 520;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#1d3557'; g.font = 'bold 54px Arial';
      lines.forEach((l, i) => g.fillText(l, 50, 110 + i * 100));
      img.src = c.toDataURL('image/png');
    }
  });
  await page.pdf({ path: path.join(OUT, deck.file), width: '1280px', height: '720px', printBackground: true });
  await page.close();
}

// ---------- DOCX ----------

async function makeDocx() {
  const long = 'Таможенный тариф 1724 года стал первым протекционистским тарифом в истории России. ' +
    'Пётр I стремился защитить молодую мануфактурную промышленность от иностранной конкуренции. ' +
    'Ввозные пошлины на товары, которые уже производились внутри страны, достигали семидесяти пяти процентов их стоимости. ' +
    'На сырьё и товары, которых в России не делали, пошлины оставались низкими. ' +
    'Вывоз сырья, напротив, облагался повышенными сборами, чтобы оно доставалось отечественным мануфактурам. ' +
    'Сбор пошлин производился в ефимках, то есть в иностранной серебряной монете, что пополняло казну драгоценным металлом. ' +
    'Тариф неоднократно пересматривался при преемниках Петра, однако его принципы сохранялись до середины века. ' +
    'Историки спорят о том, насколько он действительно помог развитию промышленности.';
  const parts = [
    ['h', 'Налоговая система Древней Руси и Московского государства'],
    ['p', 'Подготовила: Кузнецова Мария'],
    ['h', 'Дань и полюдье'],
    ['p', 'В X веке киевские князья ежегодно объезжали подвластные земли и собирали дань мехами, мёдом и воском. Такой объезд назывался полюдьем.'],
    ['p', 'После гибели князя Игоря княгиня Ольга установила уроки и погосты — фиксированные размеры и места сбора.'],
    ['h', 'Торговые пошлины'],
    ['p', 'Купцы платили мыт за провоз товаров через заставы и тамгу с продажи товаров на торгу.'],
    ['h', 'Таможенный тариф 1724 года'],
    ['p', long],
    ['h', 'Заключение'],
    ['p', 'Податная система постепенно перешла от натуральных повинностей к денежным налогам.'],
  ];
  const body = parts.map(([t, s]) => t === 'h'
    ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc(s)}</w:t></w:r></w:p>`
    : `<w:p><w:r><w:t xml:space="preserve">${esc(s)}</w:t></w:r></w:p>`).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>User</dc:creator></cp:coreProperties>`);
  fs.writeFileSync(path.join(OUT, 'Налоговая система Древней Руси.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
}

// ---------- PPTX (упрощённый, только то, что читает сборка) ----------

async function makePptx() {
  const slides = [
    { title: 'Политические партии и выборы в начале XX века', body: ['Доклад по политологии', 'Докладчик: Сидоров Олег'] },
    { title: 'Государственная дума 1906 года', body: ['Выборы в первую Думу были непрямыми и проходили по куриям.', 'Избирательный закон давал преимущество землевладельцам.'] },
    { title: 'Партия кадетов', body: ['Конституционно-демократическая партия выступала за парламентскую монархию.', 'Кадеты получили большинство мест в первой Думе.'] },
    { title: 'Становление парламентаризма', body: ['Манифест 17 октября 1905 года даровал гражданские свободы.', 'Народное представительство стало частью государственного строя.'] },
  ];
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const sp = (ph, sz, paras) => `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras.map((t) => `<a:p><a:r><a:rPr lang="ru-RU" sz="${sz}"/><a:t>${esc(t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${ns}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
  slides.forEach((s, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><p:sld ${ns}><p:cSld><p:spTree>${sp(i ? 'title' : 'ctrTitle', 4000, [s.title])}${sp('body', 2000, s.body)}${sp('sldNum', 1200, [String(i + 1)])}</p:spTree></p:cSld></p:sld>`);
  });
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  fs.writeFileSync(path.join(OUT, 'Политические партии и выборы.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
}

const browser = await chromium.launch();
await makePdf(browser, bank);
await makePdf(browser, city);
await browser.close();
await makeDocx();
await makePptx();
console.log('Тестовые доклады созданы в', OUT);
