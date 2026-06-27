export default async function handler(req, res) {
  const token = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIzN2Q0YmQzMDM1ZmUxMWU5YTgwM2FiN2VlYjNjY2M5NyIsImp0aSI6IjhiMTljNmNlZTI5NDcyYjVkN2Q2NDYwMDcwZmNiODI1ZTVhZWFmNGVkNzZkN2NjMmRmNmYyNTEyMmFmZTdkYmI0YThjOWYxMDE4OTNiNGQwIiwiaWF0IjoxNzgyNTEzNzY4LjkxOTM3LCJuYmYiOjE3ODI1MTM3NjguOTE5MzcyLCJleHAiOjE4MTQwNDk3NjguOTEzMjQ5LCJzdWIiOiIyNzcxODc5OCIsInNjb3BlcyI6WyJzaG9wcy5yZWFkIiwiY2F0YWxvZy5yZWFkIiwib3JkZXJzLnJlYWQiLCJwcm9kdWN0cy5yZWFkIiwid2ViaG9va3MucmVhZCIsInVwbG9hZHMucmVhZCIsInByaW50X3Byb3ZpZGVycy5yZWFkIiwidXNlci5pbmZvIl19.V9sg9GFAh74VGJoRMbIAuTh4KfL63C9M20ZXPd-IQix5cdBPQTV3Z19b5oddVLORwARMn05ImCywjOQWJFRynJP7Qifqr7yzPS_vYNJFdk1LIPIGnOE8eEO9p8M4vw7cvZ86wJzv6FwY4WE6L3QJoPeok_IHwFf-auTOP8OwJ-nTXYaOIeZcF3nevc-AbJwlWUxJhigAiQW0aX_bp-QsOkVIhaAVRxy0tWjLUwJISIMRsTKbzoYdHf5DDXr7ntT5j-iNk_c1nSz4URQkvbWZnEV79vc6UAkixLIMxvAQaEE72gdSCPN5O_YeXanQdZ96LuY37K6xPzi2AZHllO1rT5Y00aKTX-Vcg-pR33Ag1RaYP8GxM1mXx659PgtkaRRWCHR8YwrIQEzAoQaOK3C2ed9uTXQhoyQWqVJ0f9a6JO-t43-SJNoKieT6RDAD-V6E9m5beCr4EsqUCc232xzDTJJG-W4nlG3biokfLxV4AyTtXlbVaL5vJJqhjg8ONLhrDgFVPqBV_nR0_k2V6xIxJfSXCxNr7WKAjcS081bqndhKPZZi3BWGTdS7oCpouGHDao68RElnCeX_fJvzwu8tGPsBiBT9POqWpeDYNuB2bZGPZSfKqdyh4SNFabqkwTzO4OItJRkyHvN6EzEQBliYWzeFJANDkadqdTFAGFaztD4'; '; 

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  try {
    // 1. Получаем список магазинов
    const shopRes = await fetch('https://api.printify.com/v1/shops.json', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!shopRes.ok) {
      return res.status(200).json({ data: [], error: 'Ошибка авторизации в Printify. Проверь токен.' });
    }

    const shops = await shopRes.json();
    if (!shops || shops.length === 0) {
      return res.status(200).json({ data: [], error: 'В аккаунте Printify не найдено ни одного магазина.' });
    }
    
    const shopId = shops[0].id;

    // 2. Получаем список товаров
    const prodRes = await fetch(`https://api.printify.com/v1/shops/${shopId}/products.json`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!prodRes.ok) {
      return res.status(200).json({ data: [], error: 'Не удалось загрузить товары из этого магазина.' });
    }

    const prodData = await prodRes.json();
    return res.status(200).json(prodData);

  } catch (error) {
    return res.status(200).json({ data: [], error: 'Системная ошибка: ' + error.message });
  }
}
