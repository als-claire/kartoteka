// Русский стеммер Snowball (https://snowballstem.org/algorithms/russian/stemmer.html)
// и общая нормализация слов. Один и тот же файл используется сборкой (Node) и сайтом.

const VOWELS = 'аеиоуыэюя';
const isV = (c) => VOWELS.includes(c);

const PERFECTIVE_1 = ['вшись', 'вши', 'в'];
const PERFECTIVE_2 = ['ившись', 'ывшись', 'ивши', 'ывши', 'ив', 'ыв'];
const REFLEXIVE = ['ся', 'сь'];
const ADJECTIVE = ['ими', 'ыми', 'его', 'ого', 'ему', 'ому', 'ее', 'ие', 'ые', 'ое', 'ей', 'ий', 'ый', 'ой',
  'ем', 'им', 'ым', 'ом', 'их', 'ых', 'ую', 'юю', 'ая', 'яя', 'ою', 'ею'];
const PARTICIPLE_1 = ['ем', 'нн', 'вш', 'ющ', 'щ'];
const PARTICIPLE_2 = ['ивш', 'ывш', 'ующ'];
const VERB_1 = ['ла', 'на', 'ете', 'йте', 'ли', 'й', 'л', 'ем', 'н', 'ло', 'но', 'ет', 'ют', 'ны', 'ть', 'ешь', 'нно'];
const VERB_2 = ['ила', 'ыла', 'ена', 'ейте', 'уйте', 'ите', 'или', 'ыли', 'ей', 'уй', 'ил', 'ыл', 'им', 'ым', 'ен',
  'ило', 'ыло', 'ено', 'ят', 'ует', 'уют', 'ит', 'ыт', 'ены', 'ить', 'ыть', 'ишь', 'ую', 'ю'];
const NOUN = ['иями', 'ями', 'ами', 'ией', 'иям', 'ием', 'иях', 'ев', 'ов', 'ие', 'ье', 'еи', 'ии', 'ей', 'ой', 'ий',
  'ям', 'ем', 'ам', 'ом', 'ах', 'ях', 'ию', 'ью', 'ия', 'ья', 'а', 'е', 'и', 'й', 'о', 'у', 'ы', 'ь', 'ю', 'я'];

// Самое длинное окончание из списка, целиком лежащее в зоне с позиции `from`.
function longest(word, from, list) {
  let best = null;
  for (const s of list) {
    if (word.length - s.length >= from && word.endsWith(s) && (!best || s.length > best.length)) best = s;
  }
  return best;
}

// Окончание группы 1 считается, только если перед ним «а» или «я» (тоже внутри зоны).
function removeGrouped(word, from, g1, g2) {
  const a = longest(word, from, g1);
  const b = longest(word, from, g2);
  if (b && (!a || b.length >= a.length)) return word.slice(0, -b.length);
  if (a) {
    const i = word.length - a.length - 1;
    if (i >= from && (word[i] === 'а' || word[i] === 'я')) return word.slice(0, -a.length);
  }
  return null;
}

function regions(word) {
  let rv = word.length, r2 = word.length, i = 0;
  while (i < word.length && !isV(word[i])) i++;
  if (i >= word.length) return { rv, r2 };
  rv = ++i;
  while (i < word.length && isV(word[i])) i++;
  i++; // после первой согласной — R1
  while (i < word.length && !isV(word[i])) i++;
  while (i < word.length && isV(word[i])) i++;
  if (i < word.length) r2 = i + 1;
  return { rv, r2 };
}

export function stemRu(input) {
  let w = input;
  if (!/[а-я]/.test(w)) return w;
  const { rv, r2 } = regions(w);
  if (rv >= w.length) return w;

  // Шаг 1
  let r = removeGrouped(w, rv, PERFECTIVE_1, PERFECTIVE_2);
  if (r !== null) w = r;
  else {
    const refl = longest(w, rv, REFLEXIVE);
    if (refl) w = w.slice(0, -refl.length);
    const adj = longest(w, rv, ADJECTIVE);
    if (adj) {
      w = w.slice(0, -adj.length);
      const p = removeGrouped(w, rv, PARTICIPLE_1, PARTICIPLE_2);
      if (p !== null) w = p;
    } else {
      r = removeGrouped(w, rv, VERB_1, VERB_2);
      if (r !== null) w = r;
      else {
        const n = longest(w, rv, NOUN);
        if (n) w = w.slice(0, -n.length);
      }
    }
  }
  // Шаг 2
  if (w.length > rv && w.endsWith('и')) w = w.slice(0, -1);
  // Шаг 3
  const d = longest(w, Math.max(r2, rv), ['ость', 'ост']);
  if (d) w = w.slice(0, -d.length);
  // Шаг 4
  const sup = longest(w, rv, ['ейше', 'ейш']);
  if (sup) {
    w = w.slice(0, -sup.length);
    if (w.length - 2 >= rv && w.endsWith('нн')) w = w.slice(0, -1);
  } else if (w.length - 2 >= rv && w.endsWith('нн')) w = w.slice(0, -1);
  else if (w.length - 1 >= rv && w.endsWith('ь')) w = w.slice(0, -1);
  return w;
}

// Слова, которые не несут смысла для поиска.
export const STOPWORDS = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по ' +
  'только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до ' +
  'вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам ' +
  'чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один ' +
  'почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше ' +
  'тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть ' +
  'том нельзя такой им более всегда конечно всю между это также the of and in to a is').split(' '));

// Слова через дефис («конституционно-демократическая») индексируются по частям.
export const WORD_RE = /[\p{L}\p{N}]+/gu;

export function normalizeWord(w) {
  return w.toLowerCase().replace(/ё/g, 'е');
}

// Слово → термин индекса (или null для стоп-слов).
export function processTerm(word) {
  const w = normalizeWord(word);
  if (STOPWORDS.has(w)) return null;
  return stemRu(w);
}

export function tokenize(text) {
  return text.match(WORD_RE) || [];
}
