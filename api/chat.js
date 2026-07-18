const { GoogleGenAI } = require('@google/genai');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ text: 'Method Not Allowed' });
    }

    try {
        const { query, lang, context } = req.body;

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ text: 'API key is missing on the server.' });
        }

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const systemInstruction = `
            Ты — лаконичный и дисциплинированный ИИ-навигатор для сайта проекта "Domus Architectus" (автор: Архитектор Антикризис).
            Твоя цель — помогать пользователям ориентироваться по доступным продуктам (книги, аудио, мерч), используя предоставленный ниже контекст базы данных.
            
            Правила общения:
            1. Будь краток, конкретен и держи структуру. Никакой лишней "воды", длинных приветствий и размытых рассуждений.
            2. Отвечай строго на языке запроса пользователя (текущий язык интерфейса: ${lang || 'ru'}).
            3. Если пользователь спрашивает про конкретный продукт из базы, назови его, кратко опиши суть и ОБЯЗАТЕЛЬНО скажи: "Вы можете найти этот проект на Витрине ниже и перейти по ссылкам для ознакомления/покупки".
            4. В конце ответа ненавязчиво, но уверенно предложи подписаться на официальный Telegram-канал проекта (https://t.me/AntiKrizis_Strateg), чтобы оставаться в курсе обновлений и разборов.
            5. Если продукта нет в базе, вежливо ответь, что данного материала пока нет на витрине, и предложи следить за анонсами в Telegram.

            Текущая база данных продуктов (контекст):
            ${JSON.stringify(context || [])}
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: query,
            config: {
                systemInstruction: systemInstruction,
                maxOutputTokens: 300,
                temperature: 0.3
            }
        });

        const replyText = response.text || 'Не удалось сформировать ответ.';
        return res.status(200).json({ text: replyText });

    } catch (error) {
        console.error('AI Chat Error:', error);
        return res.status(500).json({ text: 'Ошибка обработки запроса нейросетью.' });
    }
};