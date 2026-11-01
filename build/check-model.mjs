// Быстрая проверка: модель загружается и даёт осмысленную близость.
// Запуск: node build/check-model.mjs
import { pipeline, env } from '@huggingface/transformers';
import { MODEL } from './config.mjs';

env.cacheDir = '.cache/models';

const t0 = Date.now();
const extractor = await pipeline('feature-extraction', MODEL.id, { dtype: MODEL.dtype });
console.log(`Модель ${MODEL.id} (${MODEL.dtype}) загружена за ${Date.now() - t0} мс`);

const docs = [
  'Несостоятельность должника и процедура конкурсного производства',
  'Рост городов в XIX веке и переселение крестьян',
  'Таможенные пошлины и тарифы при Петре I',
  'Выборы и партийная система в парламентской республике',
];
const queries = ['банкротство', 'урбанизация', 'налоги', 'демократия'];

const embed = async (texts, prefix) =>
  (await extractor(texts.map((t) => prefix + t), { pooling: 'mean', normalize: true })).tolist();

const D = await embed(docs, MODEL.docPrefix);
const Q = await embed(queries, MODEL.queryPrefix);
let ok = 0;
Q.forEach((q, i) => {
  const sims = D.map((d) => d.reduce((s, v, k) => s + v * q[k], 0));
  const best = sims.indexOf(Math.max(...sims));
  if (best === i) ok++;
  console.log(`${queries[i].padEnd(14)} → ${docs[best]}  [${sims.map((s) => s.toFixed(2)).join(' ')}]`);
});
console.log(`${ok}/${queries.length} верно`);
process.exit(ok === queries.length ? 0 : 1);
