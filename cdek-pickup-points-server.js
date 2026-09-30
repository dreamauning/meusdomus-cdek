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

async function findCityCode(cityName) {
  const token = await getCdekToken();
  const url = `${CDEK_BASE_URL}/location/cities?country_codes=RU&city=${encodeURIComponent(cityName)}&size=20`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Не удалось найти город "${cityName}" (статус ${response.status})`);
  }
  const cities = await response.json();
  if (!Array.isArray(cities) || cities.length === 0) {
    return null;
  }

  const normalizedTarget = cityName.trim().toLowerCase();
  const exactMatch = cities.find((c) => (c.city || '').trim().toLowerCase() === normalizedTarget);
  if (exactMatch) return exactMatch.code;

  const byPopulation = cities.slice().sort((a, b) => (b.population || 0) - (a.population || 0));
  return byPopulation[0].code;
}

app.get('/api/cdek-points', async (req, res) => {
  try {
    const cityName = (req.query.city || '').trim();
    if (!cityName) {
      return res.status(400).json({ error: 'Укажите город в параметре city' });
    }

    const cityCode = await findCityCode(cityName);
    if (!cityCode) {
      return res.json([]);
    }

    const token = await getCdekToken();
    const pointsUrl = `${CDEK_BASE_URL}/deliverypoints?city_code=${cityCode}&type=PVZ`;
    const pointsResponse = await fetch(pointsUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!pointsResponse.ok) {
      const text = await pointsResponse.text();
      throw new Error(`СДЭК не отдал пункты выдачи (статус ${pointsResponse.status}): ${text}`);
    }

    const cdekPoints = await pointsResponse.json();

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

    const toCityCode = await findCityCode(cityName);
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
    if (!order.cdekDeliveryPointCode) {
      return res.send(htmlPage('Не хватает данных', '<h1 class="err">У этого заказа не сохранён код ПВЗ СДЭК</h1><p>Заказ мог быть оформлен до подключения этой автоматизации — создайте отправку вручную в кабинете СДЭК.</p>'));
    }

    const phoneDigits = String(order.phone || '').replace(/\D/g, '');
    const weightGrams = Number(order.weightGrams) || 500;
    let lengthCm = 20, widthCm = 15, heightCm = 10;
    if (order.dimensionsCm && typeof order.dimensionsCm === 'string' && order.dimensionsCm.indexOf('×') !== -1) {
      const parts = order.dimensionsCm.split('×').map(n => parseInt(n, 10));
      if (parts.length === 3 && parts.every(n => !isNaN(n))) { [lengthCm, widthCm, heightCm] = parts; }
    }
    const itemNames = (order.items || []).map(i => i.name).join(', ') || ('Заказ ' + orderNumber);

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
      tariff_code: 136,
      shipment_point: CDEK_SHIPMENT_POINT,
      delivery_point: order.cdekDeliveryPointCode,
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
