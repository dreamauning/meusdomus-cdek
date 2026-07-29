/**
 * MEUS DOMUS — сервер для получения РЕАЛЬНЫХ пунктов выдачи СДЭК
 * ================================================================
 * ЗАЧЕМ ЭТОТ ФАЙЛ:
 * Ключи client_id / client_secret от СДЭК НЕЛЬЗЯ вставлять в код сайта —
 * их увидел бы любой, кто откроет исходный код страницы в браузере
 * (Инструменты разработчика → Просмотр кода). Секретный ключ живёт
 * только здесь, на отдельном сервере, и никогда не попадает в браузер
 * покупателя. Это тот же самый принцип, что и в файле "Скрипт для
 * приёма оплаты Тинькофф" — просто другая служба.
 *
 * ЧТО ДЕЛАЕТ ЭТОТ СЕРВЕР:
 * 1. Авторизуется в СДЭК по вашим ключам (OAuth2) и получает токен доступа
 * 2. По названию города находит код города в справочнике СДЭК
 * 3. Запрашивает у СДЭК реальный список пунктов выдачи именно этого города
 * 4. Отдаёт сайту готовый список в том же формате, что сайт уже понимает
 *    (id, city, address, lat, lng) — на самом сайте (Tilda) МЕНЯТЬ НИЧЕГО
 *    НЕ ПРИДЁТСЯ, кроме одной строчки с адресом этого сервера
 *
 * КАК ЗАПУСТИТЬ (коротко, подробнее — в инструкции для вас):
 * 1. npm init -y && npm install express node-fetch@2 cors
 * 2. Впишите ниже CDEK_CLIENT_ID и CDEK_CLIENT_SECRET (из личного кабинета СДЭК)
 * 3. Разместите на любом недорогом хостинге с Node.js (Render, Vercel,
 *    Yandex Cloud Functions — у всех есть бесплатный/дешёвый тариф)
 * 4. Полученный адрес сервера впишите в код сайта (Блок 1b), в переменную,
 *    которая указывает, откуда брать реальные пункты выдачи
 *
 * ПОДТВЕРЖДЕНО ЗАКАЗЧИКОМ: выданные ключи — БОЕВЫЕ (production), не тестовые.
 * Поэтому ниже сразу используется боевой адрес api.cdek.ru — переключать
 * на тестовую среду не требуется.
 */

const express = require('express');
const fetch = require('node-fetch'); // если Node.js 18+ — можно использовать встроенный fetch и убрать эту строку
const cors = require('cors');

const app = express();
app.use(cors()); // разрешаем сайту на другом домене обращаться к этому серверу

// ===== ВАШИ ДАННЫЕ ОТ СДЭК =====
const CDEK_CLIENT_ID = 'ВСТАВЬТЕ_Account_ЗДЕСЬ';
const CDEK_CLIENT_SECRET = 'ВСТАВЬТЕ_Secure_password_ЗДЕСЬ';

// боевой адрес СДЭК (ключи подтверждены как боевые — см. примечание выше)
const CDEK_BASE_URL = 'https://api.cdek.ru/v2';

// ===== ТОКЕН ДОСТУПА: получаем и кэшируем, чтобы не запрашивать на каждый чих =====
let cachedToken = null;
let tokenExpiresAt = 0;

async function getCdekToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken; // токен ещё живой — переиспользуем
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
  // обновляем токен на 60 секунд раньше реального истечения — про запас
  tokenExpiresAt = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ===== ПОИСК КОДА ГОРОДА ПО НАЗВАНИЮ =====
async function findCityCode(cityName) {
  const token = await getCdekToken();
  // Берём НЕСКОЛЬКО кандидатов (не один!) и сами выбираем точное совпадение —
  // раньше брался слепо первый результат (size=1), а СДЭК мог вернуть на первом
  // месте не совсем тот населённый пункт (например, другую область с похожим
  // названием), из-за чего показывались реальные, но не те пункты выдачи.
  const url = `${CDEK_BASE_URL}/location/cities?country_codes=RU&city=${encodeURIComponent(cityName)}&size=20`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Не удалось найти город "${cityName}" (статус ${response.status})`);
  }
  const cities = await response.json();
  if (!Array.isArray(cities) || cities.length === 0) {
    return null; // город не найден в справочнике СДЭК
  }

  const normalizedTarget = cityName.trim().toLowerCase();
  // 1) сначала ищем ТОЧНОЕ совпадение названия города
  const exactMatch = cities.find((c) => (c.city || '').trim().toLowerCase() === normalizedTarget);
  if (exactMatch) return exactMatch.code;

  // 2) если точного нет — берём город с наибольшим населением (обычно это и есть
  // основной, всем известный город, а не мелкий тёзка в другой области)
  const byPopulation = cities.slice().sort((a, b) => (b.population || 0) - (a.population || 0));
  return byPopulation[0].code;
}

// ===== ГЛАВНЫЙ ЭНДПОИНТ: РЕАЛЬНЫЕ ПУНКТЫ ВЫДАЧИ ПО ГОРОДУ =====
// Сайт будет обращаться сюда так же, как сейчас обращается к тестовому
// набору данных — только теперь в ответе настоящие адреса СДЭК.
app.get('/api/cdek-points', async (req, res) => {
  try {
    const cityName = (req.query.city || '').trim();
    if (!cityName) {
      return res.status(400).json({ error: 'Укажите город в параметре city' });
    }

    const cityCode = await findCityCode(cityName);
    if (!cityCode) {
      return res.json([]); // город не найден у СДЭК — честно возвращаем пустой список
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

    // приводим формат СДЭК к формату, который уже понимает сайт
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

// ===== АДРЕС ОТПРАВИТЕЛЯ: МОСКВА (подтверждено заказчиком) =====
const SENDER_CITY_CODE = 44; // 44 = Москва

// ===== ДВА ТАРИФА — ПОДТВЕРЖДЕНО ЗАКАЗЧИКОМ =====
// Все заказы физически привозятся на ПВЗ СДЭК и передаются оттуда, поэтому:
//   - если клиент забирает заказ САМ на ПВЗ в своём городе — тариф "склад-склад" (136), дешевле
//   - если клиент хочет курьерскую доставку до своей двери — тариф "склад-дверь" (137), дороже
const CDEK_TARIFF_CODES = {
  pvz: 136,  // склад-склад — клиент получает в ПВЗ
  door: 137  // склад-дверь — курьер привозит по адресу клиента
};

// ===== РЕАЛЬНЫЙ РАСЧЁТ СТОИМОСТИ ДОСТАВКИ =====
// Сайт присылает город, суммарный вес корзины (граммы) и тип получения:
// deliveryType=pvz (дешевле, до пункта выдачи) или deliveryType=door (дороже, до двери).
app.get('/api/cdek-calculate', async (req, res) => {
  try {
    const cityName = (req.query.city || '').trim();
    const weightGrams = parseInt(req.query.weight, 10) || 500; // если вес не передан — разумное значение по умолчанию
    const deliveryType = (req.query.deliveryType === 'door') ? 'door' : 'pvz'; // по умолчанию — более дешёвый вариант (ПВЗ)
    const tariffCode = CDEK_TARIFF_CODES[deliveryType];

    if (!cityName) {
      return res.status(400).json({ error: 'Укажите город в параметре city' });
    }

    const toCityCode = await findCityCode(cityName);
    if (!toCityCode) {
      // город не найден у СДЭК — честно сообщаем сайту, чтобы он показал
      // клиенту прежнюю (приблизительную) стоимость, а не ошибку
      return res.json({ found: false });
    }

    const token = await getCdekToken();
    const calcResponse = await fetch(`${CDEK_BASE_URL}/calculator/tariff`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tariff_code: tariffCode,
        from_location: { code: SENDER_CITY_CODE },
        to_location: { code: toCityCode },
        packages: [{ weight: weightGrams }]
      })
    });

    if (!calcResponse.ok) {
      const text = await calcResponse.text();
      throw new Error(`СДЭК не смог посчитать тариф (статус ${calcResponse.status}): ${text}`);
    }

    const calc = await calcResponse.json();

    res.json({
      found: true,
      deliveryType: deliveryType,
      tariffCode: tariffCode,
      cost: calc.delivery_sum,          // стоимость доставки, руб
      periodMinDays: calc.period_min,   // срок доставки, дней (минимум)
      periodMaxDays: calc.period_max    // срок доставки, дней (максимум)
    });
  } catch (err) {
    console.error(err);
    // при любой ошибке — НЕ ломаем оформление заказа у покупателя, а честно
    // говорим сайту "не получилось посчитать точно", чтобы он тихо остался
    // на приблизительной стоимости по зоне (как сейчас)
    res.json({ found: false, error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер пунктов выдачи СДЭК запущен на порту ${PORT}`);
});
