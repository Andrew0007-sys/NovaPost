#!/usr/bin/env node
/**
 * Довідник Нової пошти -> статичні JSON під чекаут.
 * API-ключ НЕ потрібен: довідникові методи моделі Address публічні.
 *
 * На виході:
 *   data/areas.json              індекс областей, вантажиться одразу
 *   data/area-<Ref>-s.json       НП області + лічильники nb/np, вантажиться при виборі області
 *   data/area-<Ref>-b.json       відділення області, згруповані по НП
 *   data/area-<Ref>-p.json       поштомати області, згруповані по НП
 *   data/city-<Ref>-b.json       окремо для НП, де точок більше за BIG
 *   data/city-<Ref>-p.json
 *
 * Точка = масив [ref, num, name], а не об'єкт: на 38k поштоматів
 * повторювані ключі коштували б понад мегабайт.
 */

import { writeFile, rename, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.novaposhta.ua/v2.0/json/';
const OUT = 'data';
const PAGE_SIZE = 1000;
const DELAY_MS = 150;
const RETRIES = 3;

/** Поріг виносу НП в окремий файл. Це ж число має знати фронт. */
const BIG = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const uk = new Intl.Collator('uk');

async function np(modelName, calledMethod, methodProperties = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: '', modelName, calledMethod, methodProperties }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(JSON.stringify(json.errors ?? json.warnings));
      return json.data ?? [];
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await sleep(1000 * attempt);
    }
  }
  throw new Error(`${calledMethod}: ${lastErr.message}`);
}

async function npAll(modelName, calledMethod, props = {}) {
  const acc = [];
  for (let page = 1; ; page++) {
    const chunk = await np(modelName, calledMethod, { ...props, Page: String(page), Limit: String(PAGE_SIZE) });
    acc.push(...chunk);
    process.stdout.write(`\r  ${calledMethod}: ${acc.length}`);
    if (chunk.length < PAGE_SIZE) break;
    await sleep(DELAY_MS);
  }
  process.stdout.write('\n');
  return acc;
}

/**
 * CSP на чекауті Webflow має connect-src 'self' - fetch чужих доменів
 * заблокований, а теги <script> ні. Тому віддаємо дані як JS-файли,
 * які присвоюють об'єкт у window.__np[<ім'я файлу>].
 * Постав false, якщо колись даватимеш дані з того самого домену.
 */
const JSONP = true;

async function writeAtomic(file, data) {
  const key = path.basename(file, '.json');
  const target = JSONP ? file.replace(/\.json$/, '.js') : file;
  const body = JSONP
    ? `window.__np=window.__np||{};window.__np[${JSON.stringify(key)}]=${JSON.stringify(data)};\n`
    : JSON.stringify(data);

  const tmp = `${target}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, target);
}

/** Партнерські точки (Store) рахуємо як відділення. */
const isPostomat = w => w.CategoryOfWarehouse === 'Postomat';

/** Точка -> [ref, номер, адреса]. Координати в дропдауні не потрібні. */
const slim = w => [w.Ref, w.Number, w.ShortAddress || w.Description];

/** №2 має бути перед №10. */
const byNum = (x, y) => (parseInt(x[1], 10) || 0) - (parseInt(y[1], 10) || 0);

async function main() {
  await mkdir(OUT, { recursive: true });

  console.log('1/3 getAreas');
  const areasRaw = await np('Address', 'getAreas');
  await sleep(DELAY_MS);

  console.log('2/3 getWarehouses');
  const whRaw = await npAll('Address', 'getWarehouses');

  console.log('3/3 build');

  // У відділенні область приходить рядком, Ref немає -> мапимо по назві.
  const areaRefByName = new Map(areasRaw.map(a => [a.Description.trim(), a.Ref]));

  const tree = new Map();
  let skipped = 0;

  for (const w of whRaw) {
    if (w.WarehouseStatus && w.WarehouseStatus !== 'Working') continue;

    const areaRef = areaRefByName.get((w.SettlementAreaDescription || '').trim());
    const setRef = w.SettlementRef;
    if (!areaRef || !setRef) { skipped++; continue; }

    let area = tree.get(areaRef);
    if (!area) tree.set(areaRef, (area = {
      name: (w.SettlementAreaDescription || '').trim(),
      settlements: new Map(),
    }));

    let s = area.settlements.get(setRef);
    if (!s) area.settlements.set(setRef, (s = {
      ref: setRef,
      name: (w.SettlementDescription || w.CityDescription || '').trim(),
      raion: (w.SettlementRegionsDescription || '').trim() || undefined,
      b: [],
      p: [],
    }));

    (isPostomat(w) ? s.p : s.b).push(slim(w));
  }

  for (const f of await readdir(OUT)) {
    if (/^(area|city|areas).*\.(json|js)$/.test(f)) await unlink(path.join(OUT, f));
  }

  const updated = new Date().toISOString();
  const index = [];
  let bigCount = 0;

  for (const [areaRef, area] of tree) {
    const all = [...area.settlements.values()].sort((a, b) => uk.compare(a.name, b.name));

    // Великі НП їдуть окремими файлами, решта - інлайном у файлі області.
    const inline = { b: {}, p: {} };

    for (const s of all) {
      for (const key of ['b', 'p']) {
        const list = s[key];
        if (!list.length) continue;
        list.sort(byNum);

        if (list.length > BIG) {
          await writeAtomic(path.join(OUT, `city-${s.ref}-${key}.json`), { updated, w: list });
          bigCount++;
        } else {
          inline[key][s.ref] = list;
        }
      }
    }

    const base = { ref: areaRef, name: area.name, updated };
    await writeAtomic(path.join(OUT, `area-${areaRef}-b.json`), { ...base, s: inline.b });
    await writeAtomic(path.join(OUT, `area-${areaRef}-p.json`), { ...base, s: inline.p });

    // Легкий індекс НП. nb/np > BIG означає, що точки в окремому city-файлі.
    await writeAtomic(path.join(OUT, `area-${areaRef}-s.json`), {
      ...base,
      big: BIG,
      settlements: all.map(x => ({
        ref: x.ref, name: x.name, raion: x.raion, nb: x.b.length, np: x.p.length,
      })),
    });

    index.push({
      ref: areaRef,
      name: area.name,
      b: all.reduce((n, x) => n + x.b.length, 0),
      p: all.reduce((n, x) => n + x.p.length, 0),
      s: all.length,
    });
  }

  index.sort((a, b) => uk.compare(a.name, b.name));
  await writeAtomic(path.join(OUT, 'areas.json'), { updated, big: BIG, areas: index });

  const branches = index.reduce((n, a) => n + a.b, 0);
  const postomats = index.reduce((n, a) => n + a.p, 0);

  console.log(`\nОбластей: ${index.length}  Відділень: ${branches}  Поштоматів: ${postomats}  Пропущено: ${skipped}`);
  console.log(`Великих НП винесено окремо: ${bigCount}`);

  const files = await readdir(OUT);
  const sizes = await Promise.all(files.map(async f => [f, (await stat(path.join(OUT, f))).size]));
  sizes.sort((a, b) => b[1] - a[1]);
  const totalKb = sizes.reduce((n, [, s]) => n + s, 0) / 1024;
  console.log(`\nВсього: ${(totalKb / 1024).toFixed(1)} MB у ${files.length} файлах`);
  console.log('Найбільші:');
  for (const [f, size] of sizes.slice(0, 5)) console.log(`  ${(size / 1024).toFixed(0).padStart(6)} KB  ${f}`);

  if (index.length < 20 || branches + postomats < 10000) {
    throw new Error('Підозріло малий дамп - не публікуємо');
  }
}

main().catch(e => { console.error('\n' + e.message); process.exit(1); });