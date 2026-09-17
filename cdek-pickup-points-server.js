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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер пунктов выдачи и расчёта СДЭК запущен на порту ${PORT}`);
});
