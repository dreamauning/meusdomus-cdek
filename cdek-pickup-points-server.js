const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const CDEK_CLIENT_ID = '69njnL5edOoLVVJucGkHuP63nTCOkirQ';
const CDEK_CLIENT_SECRET = 'FvJZ9veCGdpasb01S5kVAPwnWJTAUdJU';
const CDEK_BASE_URL = 'https://api.cdek.ru/v2';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyAKLI96MAXo4-6iOBSNjw9sX0xVQ2d35ZuGeDZmXSEljYUMCCDUaRgSPZy3TOQQYjB/exec';
const SENDER_CITY_CODE = 44;
const CDEK_SHIPMENT_POINT = 'MSK2466';
const CDEK_TARIFF_CODES = { pvz: 136, door: 137 };
const CDEK_MARKUP_PERCENT = 5;
const DEFAULT_PACKAGE_CM = { length: 20, width: 15, height: 10 };
const CDEK_DEBUG_KEY = 'md-diag-5f81c2';

const app = express();
app.use(cors());

let cachedToken = null;
let tokenExpiresAt = 0;

async function getCdekToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', CDEK_CLIENT_ID);
  params.append('client_secret', CDEK_CLIENT_SECRET);

  const response = await fetch(`${CDEK_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`СДЭК не выдал токен (статус ${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function normalizeText(text) {
  return String(text || '').trim().toLowerCase().replace(/ё/g, 'е');
}

function cleanCityName(name) {
  return normalizeText(name)
    .replace(/^(г|город|пгт|рп|с|п|д|ст-ца|х|аул|село|поселок|деревня|станица)\.?\s+/, '')
    .replace(/\s+(г|город)\.?$/, '');
}

function regionKey(region) {
  const words = normalizeText(region).replace(/[^a-zа-я\s-]/g, ' ').split(/\s+/)
    .filter(w => w && ['обл', 'область', 'респ', 'республика', 'край', 'ао', 'авт', 'автономный', 'округ', 'г'].indexOf(w) === -1);
  return words[0] || '';
}

async function findCityCandidates(cityName) {
  const token = await getCdekToken();
  const url = `${CDEK_BASE_URL}/location/cities?country_codes=RU&city=${encodeURIComponent(cleanCityName(cityName))}&size=50`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Не удалось найти город "${cityName}" (статус ${response.status})`);
  }
  const cities = await response.json();
  return Array.isArray(cities) ? cities : [];
}

function chooseCity(cities, cityName, region) {
  if (!cities.length) return null;
  const target = cleanCityName(cityName);
  const exact = cities.filter(c => normalizeText(c.city) === target);
  let pool = exact.length ? exact : cities;
  const key = regionKey(region);
  if (key) {
    const inRegion = pool.filter(c => normalizeText(c.region).indexOf(key) !== -1);
    if (inRegion.length) pool = inRegion;
  }
  return pool.slice().sort((a, b) => (b.population || 0) - (a.population || 0))[0];
}

async function findCityCode(cityName, region) {
  const city = chooseCity(await findCityCandidates(cityName), cityName, region);
  return city ? city.code : null;
}

async function fetchCityPoints(cityCode, type) {
  const token = await getCdekToken();
  const response = await fetch(`${CDEK_BASE_URL}/deliverypoints?city_code=${cityCode}&type=${type}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`СДЭК не отдал пункты выдачи (статус ${response.status}): ${text}`);
  }
  const points = await response.json();
  return Array.isArray(points) ? points : [];
}

app.get('/api/cdek-points', async (req, res) => {
  try {
    const cityName = (req.query.city || '').trim();
    if (!cityName) {
      return res.status(400).json({ error: 'Укажите город в параметре city' });
    }

    const cityCode = await findCityCode(cityName, req.query.region);
    if (!cityCode) {
      return res.json([]);
    }

    const cdekPoints = await fetchCityPoints(cityCode, 'PVZ');

    const formatted = (cdekPoints || []).map((p) => ({
      id: 'cdek-' + p.code,
      city: cityName.toLowerCase(),
      name: 'СДЭК — ' + (p.name || p.location.address_full),
      address: p.location.address_full,
      lat: p.location.latitude,
      lng: p.location.longitude
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/cdek-debug', async (req, res) => {
  if (req.query.key !== CDEK_DEBUG_KEY) return res.status(403).json({ error: 'forbidden' });
  const cityName = String(req.query.city || '').trim();
  if (!cityName) return res.json({ error: 'Укажите city' });
  try {
    const candidates = await findCityCandidates(cityName);
    const chosen = chooseCity(candidates, cityName, req.query.region);
    const report = {
      query: { city: cityName, cleaned: cleanCityName(cityName), region: req.query.region || '' },
      candidates: candidates.slice(0, 15).map(c => ({ code: c.code, city: c.city, region: c.region, population: c.population || null })),
      chosen: chosen ? { code: chosen.code, city: chosen.city, region: chosen.region } : null
    };
    if (chosen) {
      const pvz = await fetchCityPoints(chosen.code, 'PVZ');
      const postamats = await fetchCityPoints(chosen.code, 'POSTAMAT');
      report.pvzCount = pvz.length;
      report.postamatCount = postamats.length;
      report.pvzExamples = pvz.slice(0, 3).map(p => p.location && p.location.address_full);
    }
    res.json(report);
  } catch (err) {
    res.json({ error: String(err.message || err) });
  }
});

app.get('/api/cdek-calculate', async (req, res) => {
  try {
    const cityName = (req.query.city || '').trim();
    const weightGrams = parseInt(req.query.weight, 10) || 500;
    const deliveryType = (req.query.deliveryType === 'door') ? 'door' : 'pvz';
    const tariffCode = CDEK_TARIFF_CODES[deliveryType];

    const lengthCm = parseInt(req.query.length, 10) || DEFAULT_PACKAGE_CM.length;
    const widthCm = parseInt(req.query.width, 10) || DEFAULT_PACKAGE_CM.width;
    const heightCm = parseInt(req.query.height, 10) || DEFAULT_PACKAGE_CM.height;

    if (!cityName) {
      return res.status(400).json({ error: 'Укажите город в параметре city' });
    }

    const toCityCode = await findCityCode(cityName, req.query.region);
    if (!toCityCode) {
      console.log(`[cdek-calculate] Город "${cityName}" не найден в справочнике СДЭК`);
      return res.json({ found: false });
    }

    const token = await getCdekToken();
    const requestBody = {
      tariff_code: tariffCode,
      from_location: { code: SENDER_CITY_CODE },
      to_location: { code: toCityCode },
      packages: [{
        weight: weightGrams,
        length: lengthCm,
        width: widthCm,
        height: heightCm
      }]
    };

    console.log(`[cdek-calculate] Запрос: город="${cityName}" (код ${toCityCode}), тариф=${tariffCode}, вес=${weightGrams}г, габариты=${lengthCm}×${widthCm}×${heightCm}см`);

    const calcResponse = await fetch(`${CDEK_BASE_URL}/calculator/tariff`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const rawText = await calcResponse.text();
    console.log(`[cdek-calculate] Сырой ответ СДЭК (статус ${calcResponse.status}): ${rawText}`);

    if (!calcResponse.ok) {
      throw new Error(`СДЭК не смог посчитать тариф (статус ${calcResponse.status}): ${rawText}`);
    }

    const calc = JSON.parse(rawText);

    const finalSum = (typeof calc.total_sum === 'number') ? calc.total_sum : calc.delivery_sum;

    if (typeof finalSum !== 'number') {
      console.error(`[cdek-calculate] СДЭК не вернул ни total_sum, ни delivery_sum для города "${cityName}": ${rawText}`);
      return res.json({ found: false, error: 'Тариф недоступен для этого направления' });
    }

    const realCost = finalSum;
    const costWithMarkup = Math.round(realCost * (1 + CDEK_MARKUP_PERCENT / 100));
    console.log(`[cdek-calculate] Реальная стоимость СДЭК: ${realCost} ₽ → с наценкой ${CDEK_MARKUP_PERCENT}%: ${costWithMarkup} ₽`);

    res.json({
      found: true,
      deliveryType: deliveryType,
      tariffCode: tariffCode,
      cost: costWithMarkup,
      periodMinDays: calc.period_min,
      periodMaxDays: calc.period_max
    });
  } catch (err) {
    console.error('[cdek-calculate] Ошибка:', err);
    res.json({ found: false, error: String(err.message || err) });
  }
});

const ordersCurrentlyProcessing = new Set();

async function cdekApiCall(method, endpoint, body) {
  const token = await getCdekToken();
  const options = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${CDEK_BASE_URL}${endpoint}`, options);
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!response.ok) {
    const err = new Error(`СДЭК API ${endpoint} ответил статусом ${response.status}: ${text}`);
    err.cdekResponse = json;
    throw err;
  }
  return json;
}

async function fetchOrderFromSheet(orderNumber) {
  const url = `${APPS_SCRIPT_URL}?action=order-lookup&orderNumber=${encodeURIComponent(orderNumber)}`;
  const response = await fetch(url);
  return await response.json();
}

async function writeTrackingToSheet(orderNumber, trackNumber) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ type: 'set-tracking', orderNumber, trackNumber })
  });
  return await response.json();
}

function htmlPage(title, bodyHtml) {
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>' + title + '</title>'
    + '<style>'
    + 'body{font-family:-apple-system,Arial,sans-serif; background:#F3F0EA; color:#2A1E15; padding:40px 20px; max-width:560px; margin:0 auto; line-height:1.6;}'
    + 'h1{font-size:22px; margin-bottom:16px;}'
    + '.card{background:#fff; border-radius:10px; padding:24px; box-shadow:0 2px 12px rgba(42,30,21,0.1);}'
    + '.ok{color:#2E7D32;} .err{color:#A83C3C;}'
    + 'a.btn{display:inline-block; margin-top:16px; background:#2A1E15; color:#fff; padding:12px 20px; border-radius:8px; text-decoration:none; font-weight:600;}'
    + '</style></head><body><div class="card">' + bodyHtml + '</div></body></html>';
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

app.get('/api/create-cdek-order', async (req, res) => {
  const orderNumber = String(req.query.orderNumber || '').trim();
  if (!orderNumber) {
    return res.status(400).send(htmlPage('Ошибка', '<h1 class="err">Не передан номер заказа</h1>'));
  }

  if (ordersCurrentlyProcessing.has(orderNumber)) {
    return res.send(htmlPage('Уже обрабатывается', '<h1>Этот заказ уже создаётся</h1><p>Кто-то (возможно, вы сами секунду назад) уже нажал эту ссылку — процесс ещё не завершился. Подождите немного и обновите страницу с историей заказа, не нажимайте ссылку повторно.</p>'));
  }
  ordersCurrentlyProcessing.add(orderNumber);

  try {
    const order = await fetchOrderFromSheet(orderNumber);
    if (!order.found) {
      return res.send(htmlPage('Заказ не найден', '<h1 class="err">Заказ не найден</h1><p>' + (order.error || 'Проверьте номер заказа.') + '</p>'));
    }
    if (order.trackNumber) {
      return res.send(htmlPage('Уже создано', '<h1>Отправка уже была создана ранее</h1><p>Трек-номер: <b>' + order.trackNumber + '</b></p>'));
    }
    const isDoor = String(order.delivery || '').indexOf('СДЭК до двери') !== -1;
    if (!isDoor && !order.cdekDeliveryPointCode) {
      return res.send(htmlPage('Не хватает данных', '<h1 class="err">У этого заказа не сохранён код ПВЗ СДЭК</h1><p>Заказ мог быть оформлен до подключения этой автоматизации — создайте отправку вручную в кабинете СДЭК.</p>'));
    }

    let destination;
    if (isDoor) {
      const fullDestination = String(order.deliveryDestination || '');
      const separatorIdx = fullDestination.indexOf(', ');
      const cityName = separatorIdx > 0 ? fullDestination.slice(0, separatorIdx) : '';
      const address = separatorIdx > 0 ? fullDestination.slice(separatorIdx + 2).trim() : '';
      const cityCode = cityName ? await findCityCode(cityName) : null;
      if (!cityCode || !address) {
        return res.send(htmlPage('Не хватает данных', '<h1 class="err">Не удалось определить город или адрес доставки</h1><p>Адрес в заказе: ' + (fullDestination || '—') + '. Создайте отправку вручную в кабинете СДЭК.</p>'));
      }
      destination = { to_location: { code: cityCode, address: address } };
    } else {
      destination = { delivery_point: order.cdekDeliveryPointCode };
    }

    const phoneDigits = String(order.phone || '').replace(/\D/g, '');
    const weightGrams = Number(order.weightGrams) || 500;
    let lengthCm = 20, widthCm = 15, heightCm = 10;
    if (order.dimensionsCm && typeof order.dimensionsCm === 'string' && order.dimensionsCm.indexOf('×') !== -1) {
      const parts = order.dimensionsCm.split('×').map(n => parseInt(n, 10));
      if (parts.length === 3 && parts.every(n => !isNaN(n))) { [lengthCm, widthCm, heightCm] = parts; }
    }

    const orderItems = order.items || [];
    const totalUnits = orderItems.reduce((s, i) => s + (Number(i.qty) || 1), 0) || 1;
    const fallbackUnitWeight = Math.max(1, Math.round(weightGrams / totalUnits));
    const cdekItems = orderItems.map((i, idx) => ({
      ware_key: String(i.id || idx),
      name: ((i.name || 'Товар') + (i.variant ? ' (' + i.variant + ')' : '')).slice(0, 255),
      payment: { value: 0 },
      cost: Number(i.price) || 0,
      weight: Math.max(1, Math.round(Number(i.unitWeightGrams) || fallbackUnitWeight)),
      amount: Number(i.qty) || 1
    }));
    const itemsWeightSum = cdekItems.reduce((s, i) => s + i.weight * i.amount, 0);
    const packageWeight = Math.max(weightGrams, itemsWeightSum);

    const createBody = {
      type: 1,
      number: orderNumber,
      tariff_code: isDoor ? CDEK_TARIFF_CODES.door : CDEK_TARIFF_CODES.pvz,
      shipment_point: CDEK_SHIPMENT_POINT,
      ...destination,
      sender: { name: 'Meus Domus' },
      recipient: {
        name: order.name || 'Покупатель Meus Domus',
        phones: [{ number: phoneDigits ? ('+' + phoneDigits) : '+70000000000' }]
      },
      packages: [{
        number: orderNumber,
        weight: packageWeight,
        length: lengthCm, width: widthCm, height: heightCm,
        items: cdekItems
      }]
    };

    console.log('[create-cdek-order] Создаём заказ ' + orderNumber + ':', JSON.stringify(createBody));
    const createResp = await cdekApiCall('POST', '/orders', createBody);
    console.log('[create-cdek-order] Ответ orders:', JSON.stringify(createResp));

    const orderUuid = createResp && createResp.entity && createResp.entity.uuid;
    if (!orderUuid) {
      return res.send(htmlPage('Ошибка создания', '<h1 class="err">СДЭК не создал заказ</h1><pre>' + JSON.stringify(createResp) + '</pre>'));
    }

    let cdekNumber = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(2000);
      const info = await cdekApiCall('GET', `/orders/${orderUuid}`);
      if (info && info.entity && info.entity.cdek_number) {
        cdekNumber = info.entity.cdek_number;
        break;
      }
      if (info && info.entity && info.entity.statuses && info.entity.statuses.some(s => s.code === 'INVALID')) {
        return res.send(htmlPage('Ошибка', '<h1 class="err">СДЭК отклонил заказ</h1><pre>' + JSON.stringify(info.entity.statuses) + '</pre>'));
      }
    }

    if (!cdekNumber) {
      return res.send(htmlPage('Создано, трек ожидается',
        '<h1>Заказ зарегистрирован у СДЭК</h1>'
        + '<p>UUID заказа: <b>' + orderUuid + '</b></p>'
        + '<p>Трек-номер ещё не присвоен СДЭК — это иногда занимает больше времени. Проверьте статус в личном кабинете СДЭК через несколько минут и впишите трек-номер в таблицу вручную, когда он появится.</p>'
      ));
    }

    let labelBase64 = null;
    try {
      const barcodeCreate = await cdekApiCall('POST', '/print/barcodes', {
        orders: [{ order_uuid: orderUuid }],
        format: 'A6'
      });
      const barcodeUuid = barcodeCreate && barcodeCreate.entity && barcodeCreate.entity.uuid;
      if (barcodeUuid) {
        for (let attempt = 0; attempt < 8; attempt++) {
          await sleep(2000);
          const statusResp = await cdekApiCall('GET', `/print/barcodes/${barcodeUuid}`);
          const statusCode = statusResp && statusResp.entity && statusResp.entity.statuses && statusResp.entity.statuses.slice(-1)[0] && statusResp.entity.statuses.slice(-1)[0].code;
          if (statusCode === 'READY' || (statusResp && statusResp.entity && statusResp.entity.url)) {
            const token = await getCdekToken();
            const pdfUrl = (statusResp.entity && statusResp.entity.url) || `${CDEK_BASE_URL}/print/barcodes/${barcodeUuid}.pdf`;
            const pdfResp = await fetch(pdfUrl, { headers: { Authorization: `Bearer ${token}` } });
            if (pdfResp.ok) {
              const arrayBuf = await pdfResp.arrayBuffer();
              labelBase64 = Buffer.from(arrayBuf).toString('base64');
            }
            break;
          }
        }
      }
    } catch (labelErr) {
      console.error('[create-cdek-order] Не удалось получить этикетку:', labelErr.message);
    }

    await writeTrackingToSheet(orderNumber, cdekNumber);

    let labelHtml = '<p>Этикетку не удалось получить автоматически — найдите заказ ' + cdekNumber + ' в личном кабинете СДЭК и распечатайте её оттуда.</p>';
    if (labelBase64) {
      labelHtml = '<a class="btn" href="data:application/pdf;base64,' + labelBase64 + '" download="cdek-' + cdekNumber + '.pdf">Скачать этикетку (PDF)</a>';
    }

    res.send(htmlPage('Готово',
      '<h1 class="ok">Отправка создана</h1>'
      + '<p>Трек-номер СДЭК: <b>' + cdekNumber + '</b></p>'
      + '<p>Трек-номер записан в таблицу — покупателю уже отправлено письмо с ним.</p>'
      + labelHtml
    ));
  } catch (err) {
    console.error('[create-cdek-order] Ошибка:', err);
    res.status(500).send(htmlPage('Ошибка', '<h1 class="err">Что-то пошло не так</h1><p>' + String(err.message || err) + '</p><p>Заказ ' + orderNumber + ' нужно будет создать вручную в кабинете СДЭК.</p>'));
  } finally {
    ordersCurrentlyProcessing.delete(orderNumber);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер пунктов выдачи и расчёта СДЭК запущен на порту ${PORT}`);
});
