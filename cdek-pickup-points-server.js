/**
 * MEUS DOMUS — сервер для получения РЕАЛЬНЫХ пунктов выдачи СДЭК и расчёта
 * реальной стоимости доставки
 * ================================================================
 * ЗАЧЕМ ЭТОТ ФАЙЛ:
 * Ключи client_id / client_secret от СДЭК НЕЛЬЗЯ вставлять в код сайта —
 * их увидел бы любой, кто откроет исходный код страницы в браузере.
 * Секретный ключ живёт только здесь, на отдельном сервере.
 *
 * ==================== ЧТО ИЗМЕНИЛОСЬ В ЭТОЙ ВЕРСИИ ====================
 * НАЙДЕНА ВЕРОЯТНАЯ ПРИЧИНА заниженной цены на дальние расстояния (пример:
 * Хабаровск — сайт показывал 725 ₽, реальный СДЭК — от 2000 ₽):
 *
 * Официальная документация СДЭК (calculator/tariff) в примере запроса
 * передаёт для каждого пакета не только вес, но и ГАБАРИТЫ:
 *   "packages": [{ "height": 10, "length": 10, "weight": 4000, "width": 10 }]
 * Наш сервер до этой версии передавал ТОЛЬКО вес, без габаритов вообще.
 * Для лёгких, но объёмных товаров (например, полотенца) СДЭК считает
 * цену не только по фактическому весу, но и по так называемому
 * "объёмному весу" (габариты переведённые в условный вес) — если
 * габариты вообще не передать, расчёт может занижаться, особенно
 * заметно на дальние расстояния, где стоимость сильнее зависит именно
 * от объёма/веса груза.
 * Теперь сервер принимает габариты от сайта (params length/width/height,
 * в сантиметрах) и передаёт их в calculator/tariff вместе с весом.
 * Код города Москвы (44) — сверил с официальной документацией СДЭК,
 * подтверждён верно, это не было причиной ошибки.
 * Также добавлено подробное логирование сырого ответа СДЭК на каждый
 * расчёт — если разрыв в цене всё же останется после этого исправления,
 * в логах Render будет видно ТОЧНО, что именно вернул СДЭК и на основе
 * каких данных, вместо того чтобы гадать дальше.
 * ========================================================================
 *
 * КАК ЗАПУСТИТЬ (коротко, подробнее — в инструкции для вас):
 * 1. npm init -y && npm install express node-fetch@2 cors
 * 2. Впишите ниже CDEK_CLIENT_ID и CDEK_CLIENT_SECRET (из личного кабинета СДЭК)
 * 3. Разместите на любом недорогом хостинге с Node.js (Render, Vercel и т.д.)
 * 4. Полученный адрес сервера впишите в код сайта (Блок 1b)
 *
 * ПОДТВЕРЖДЕНО ЗАКАЗЧИКОМ: выданные ключи — БОЕВЫЕ (production).
 */

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());

// ===== ВАШИ ДАННЫЕ ОТ СДЭК =====
const CDEK_CLIENT_ID = '69njnL5edOoLVVJucGkHuP63nTCOkirQ';
const CDEK_CLIENT_SECRET = 'FvJZ9veCGdpasb01S5kVAPwnWJTAUdJU';

const CDEK_BASE_URL = 'https://api.cdek.ru/v2';

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

// ===== АДРЕС ОТПРАВИТЕЛЯ: МОСКВА =====
// Код 44 сверен с официальной документацией СДЭК (developers.cdek.ru) —
// подтверждён верно, во всех официальных примерах именно 44 = Москва.
const SENDER_CITY_CODE = 44;

const CDEK_TARIFF_CODES = {
  pvz: 136,  // "Посылка склад-склад" — подтверждено официальной документацией
  door: 137  // "Посылка склад-дверь"
};

// Разумные габариты по умолчанию (см), если сайт по какой-то причине не
// передал их — небольшая коробка, а не ноль (ноль граничит с ошибкой
// расчёта у самого СДЭК и точно не может завышать цену, только занижать).
const DEFAULT_PACKAGE_CM = { length: 20, width: 15, height: 10 };

app.get('/api/cdek-calculate', async (req, res) => {
  try {
    const cityName = (req.query.city || '').trim();
    const weightGrams = parseInt(req.query.weight, 10) || 500;
    const deliveryType = (req.query.deliveryType === 'door') ? 'door' : 'pvz';
    const tariffCode = CDEK_TARIFF_CODES[deliveryType];

    // ГАБАРИТЫ — см. пояснение вверху файла, почему это важно добавили.
    // Если сайт не прислал (например, ещё не обновлён) — используем
    // разумные значения по умолчанию, а не ноль.
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

    // Логируем каждый запрос и ответ — если цена снова окажется странной,
    // в Render → Logs будет видно ТОЧНО, что мы отправили и что вернул
    // СДЭК, вместо повторных догадок.
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

    // ВАЖНО, НАЙДЕНА НАСТОЯЩАЯ ПРИЧИНА расхождения с личным кабинетом:
    // ответ СДЭК содержит ДВА разных числа — delivery_sum (чистый тариф,
    // без доплат) и total_sum (delivery_sum + обязательные доп. услуги,
    // например упаковка) — именно total_sum совпадает с тем, что реально
    // спишется и что показывает личный кабинет партнёра. Раньше здесь
    // читался delivery_sum — заниженная база без доплат. Если по какой-то
    // причине total_sum не пришёл (старый формат ответа, разовый сбой) —
    // используем delivery_sum как запасной вариант, чтобы не сломать
    // расчёт совсем, но обычный, ожидаемый случай — именно total_sum.
    const finalSum = (typeof calc.total_sum === 'number') ? calc.total_sum : calc.delivery_sum;

    if (typeof finalSum !== 'number') {
      // СДЭК ответил 200, но без реальной суммы — например, тариф
      // недоступен для этого направления. Честно говорим сайту, что не
      // получилось, чтобы он остался на приблизительной оценке, а не
      // показал 0 ₽ или мусорное значение.
      console.error(`[cdek-calculate] СДЭК не вернул ни total_sum, ни delivery_sum для города "${cityName}": ${rawText}`);
      return res.json({ found: false, error: 'Тариф недоступен для этого направления' });
    }

    // ===== НАЦЕНКА НА ДОСТАВКУ (запас магазину) =====
    // По просьбе заказчика: сайт показывает покупателю не голую
    // себестоимость доставки от СДЭК, а с небольшой наценкой сверху —
    // так магазин не работает "в ноль" при малейшей погрешности расчёта
    // (габариты, объёмный вес и т.п. никогда не будут посчитаны идеально
    // точно для абсолютно любой комбинации товаров в корзине).
    // Наценка сделана ПРОЦЕНТОМ, а не фиксированной суммой — фиксированная
    // добавка искажала бы пропорции: та же сумма и на дешёвую доставку по
    // Москве, и на дорогую на Дальний Восток, что несправедливо и не имеет
    // экономического смысла. 5% выбраны как понятное круглое число.
    const CDEK_MARKUP_PERCENT = 5;
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

// Тот же адрес Google-скрипта, что используют сайт и сервер Ozon — нужен,
// чтобы прочитать данные заказа и потом записать обратно настоящий
// трек-номер СДЭК.
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyAKLI96MAXo4-6iOBSNjw9sX0xVQ2d35ZuGeDZmXSEljYUMCCDUaRgSPZy3TOQQYjB/exec';

// Защита от повторного создания, если менеджер нажмёт ссылку дважды подряд,
// не дожидаясь ответа (весь процесс с ожиданием трек-номера занимает до
// 20+ секунд — вполне реальный сценарий для нетерпеливого клика). Это
// простая защита "в памяти" именно этого сервера — не переживает
// перезапуск, но для такого сценария (клик почти сразу же второй раз)
// этого достаточно; настоящую защиту от дублей всё равно даёт проверка
// order.trackNumber чуть ниже, эта же — просто более быстрый барьер.
const ordersCurrentlyProcessing = new Set();

// Координаты склада (2-я Фрезерная улица, 14) — те же, что использовались
// при разовой настройке Ozon, для поиска ближайшего СВОЕГО пункта отгрузки.
const WAREHOUSE_LAT = 55.739514;
const WAREHOUSE_LNG = 37.746526;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ===== РАЗОВАЯ НАСТРОЙКА: СВОЙ ПУНКТ ОТГРУЗКИ (shipment_point) =====
// Для тарифа "Посылка склад-склад" (136, доставка до ПВЗ) СДЭК ожидает
// знать, ЧЕРЕЗ КАКОЙ ИМЕННО ваш пункт отгрузки идёт передача посылки —
// аналогично тому, как это было нужно для Ozon. Без этого шага создание
// заказа работать не будет вообще — сервер честно откажется, а не
// сломается посередине (см. переменную CDEK_SHIPMENT_POINT ниже).
const CDEK_SHIPMENT_POINT = null; // ← впишите сюда код ПВЗ после разовой настройки

app.get('/api/setup/find-cdek-shipment-point', async (req, res) => {
  try {
    const cityCode = await findCityCode('Москва');
    if (!cityCode) {
      return res.status(500).json({ error: 'Не удалось найти код города Москва' });
    }
    const token = await getCdekToken();
    const pointsUrl = `${CDEK_BASE_URL}/deliverypoints?city_code=${cityCode}&type=PVZ`;
    const pointsResponse = await fetch(pointsUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!pointsResponse.ok) {
      const text = await pointsResponse.text();
      return res.status(500).json({ error: `СДЭК не отдал пункты (статус ${pointsResponse.status}): ${text}` });
    }
    const points = await pointsResponse.json();
    const withDistance = (points || []).map(p => ({
      code: p.code,
      name: p.name,
      address: p.location && p.location.address_full,
      distanceKm: haversineKm(WAREHOUSE_LAT, WAREHOUSE_LNG, p.location && p.location.latitude, p.location && p.location.longitude)
    })).sort((a, b) => a.distanceKm - b.distanceKm);

    res.json({ nearest: withDistance.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ===== ОБЩИЙ ПОМОЩНИК ДЛЯ АВТОРИЗОВАННЫХ ЗАПРОСОВ К СДЭК =====
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

/* ==================== АВТОМАТИЧЕСКОЕ СОЗДАНИЕ НАСТОЯЩЕЙ ОТПРАВКИ СДЭК ====
 * Полный аналог того, что уже сделано для Ozon — менеджер нажимает ссылку
 * в Telegram, сервер сам регистрирует заказ у СДЭК, дожидается присвоения
 * трек-номера, заказывает печать этикетки со штрихкодом и записывает
 * трек-номер обратно в таблицу (это само по себе запускает письмо
 * покупателю — та же цепочка, что и у обычного ручного ввода).
 * Пока реализовано ТОЛЬКО для "СДЭК до ПВЗ" (тариф 136) — для "СДЭК до
 * двери" нужна отдельная проверка курьерского забора, которую отдельно
 * не изучали; такие заказы пока оформляются вручную, как раньше.
 * ============================================================================ */
app.get('/api/create-cdek-order', async (req, res) => {
  const orderNumber = String(req.query.orderNumber || '').trim();
  if (!orderNumber) {
    return res.status(400).send(htmlPage('Ошибка', '<h1 class="err">Не передан номер заказа</h1>'));
  }

  if (!CDEK_SHIPMENT_POINT) {
    console.error('[create-cdek-order] CDEK_SHIPMENT_POINT не настроен — см. инструкцию по разовой настройке');
    return res.send(htmlPage('Не настроено', '<h1 class="err">Свой пункт отгрузки СДЭК ещё не настроен на сервере</h1><p>Нужна разовая настройка, обратитесь к разработчику.</p>'));
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

    const createBody = {
      type: 1, // "интернет-магазин"
      number: orderNumber,
      tariff_code: 136, // "Посылка склад-склад" — до ПВЗ
      shipment_point: CDEK_SHIPMENT_POINT,
      delivery_point: order.cdekDeliveryPointCode,
      sender: { name: 'Meus Domus' },
      recipient: {
        name: order.name || 'Покупатель Meus Domus',
        phones: [{ number: phoneDigits ? ('+' + phoneDigits) : '+70000000000' }]
      },
      packages: [{
        number: orderNumber,
        weight: weightGrams,
        length: lengthCm, width: widthCm, height: heightCm,
        items: (order.items || []).map((i, idx) => ({
          ware_key: String(i.id || idx),
          name: (i.name || 'Товар').slice(0, 255),
          payment: { value: 0 }, // наложенный платёж не берём — оплата уже прошла на сайте
          cost: Number(i.price) || 0,
          weight: Math.round(weightGrams / Math.max((order.items || []).length, 1)),
          amount: Number(i.qty) || 1
        }))
      }]
    };

    console.log('[create-cdek-order] Создаём заказ ' + orderNumber + ':', JSON.stringify(createBody));
    const createResp = await cdekApiCall('POST', '/orders', createBody);
    console.log('[create-cdek-order] Ответ orders:', JSON.stringify(createResp));

    const orderUuid = createResp && createResp.entity && createResp.entity.uuid;
    if (!orderUuid) {
      return res.send(htmlPage('Ошибка создания', '<h1 class="err">СДЭК не создал заказ</h1><pre>' + JSON.stringify(createResp) + '</pre>'));
    }

    // СДЭК обрабатывает заказ асинхронно — трек-номер (cdek_number)
    // появляется не мгновенно. Ждём до ~20 секунд, опрашивая статус.
    let cdekNumber = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(2000);
      const info = await cdekApiCall('GET', `/orders/${orderUuid}`);
      if (info && info.entity && info.entity.cdek_number) {
        cdekNumber = info.entity.cdek_number;
        break;
      }
      // Если СДЭК уже сообщил об ошибке по заказу — не ждём зря все 20 секунд
      if (info && info.entity && info.entity.statuses && info.entity.statuses.some(s => s.code === 'INVALID')) {
        return res.send(htmlPage('Ошибка', '<h1 class="err">СДЭК отклонил заказ</h1><pre>' + JSON.stringify(info.entity.statuses) + '</pre>'));
      }
    }

    if (!cdekNumber) {
      // Не дождались — заказ всё равно создан на стороне СДЭК (uuid есть),
      // просто трек-номер ещё не присвоен. Сообщаем менеджеру честно, не
      // теряя сам факт создания заказа.
      return res.send(htmlPage('Создано, трек ожидается',
        '<h1>Заказ зарегистрирован у СДЭК</h1>'
        + '<p>UUID заказа: <b>' + orderUuid + '</b></p>'
        + '<p>Трек-номер ещё не присвоен СДЭК — это иногда занимает больше времени. Проверьте статус в личном кабинете СДЭК через несколько минут и впишите трек-номер в таблицу вручную, когда он появится.</p>'
      ));
    }

    // Заказываем печать этикетки со штрихкодом — тоже асинхронный процесс
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
      // не критично — сам заказ и трек-номер уже готовы, продолжаем без этикетки
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
