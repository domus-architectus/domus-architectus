import React from 'react';

async function getShopId() {
  const token = process.env.PRINTIFY_API_TOKEN;

  // Стучимся в Printify, чтобы узнать список твоих магазинов
  const response = await fetch('https://api.printify.com/v1/shops.json', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  });

  if (!response.ok) return { error: 'Ошибка токена или доступа' };
  
  const shops = await response.json();
  return shops[0]; // Берем самый первый магазин в твоем аккаунте
}

export default async function FindMyIdPage() {
  const shopInfo = await getShopId();

  return (
    <div style={{ padding: '50px', textAlign: 'center', fontFamily: 'sans-serif' }}>
      <h1 style={{ color: '#111' }}>🔍 Поиск ID Магазина</h1>
      {shopInfo.error ? (
        <p style={{ color: 'red' }}>{shopInfo.error}</p>
      ) : (
        <div style={{ background: '#f5f5f5', padding: '20px', borderRadius: '8px', display: 'inline-block', marginTop: '20px' }}>
          <p style={{ fontSize: '1.2rem' }}>Название магазина: <strong>{shopInfo.title}</strong></p>
          <p style={{ fontSize: '1.5rem', color: '#0070f3' }}>
            Твой Shop ID: <strong style={{ fontSize: '2rem', borderBottom: '2px dashed' }}>{shopInfo.id}</strong>
          </p>
          <p style={{ color: '#666', fontSize: '0.9rem', marginTop: '10px' }}>
            Скопируй эти цифры и добавь их в Vercel как <code>PRINTIFY_SHOP_ID</code>
          </p>
        </div>
      )}
    </div>
  );
}