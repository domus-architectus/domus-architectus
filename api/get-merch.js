export default async function handler(req, res) {
  const token = ''; 

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
