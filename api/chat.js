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
            Ты — ИИ-навигатор и жесткий, дисциплинированный ментор для сайта "Domus Architectus". Твой стиль общения — прямой, уверенный, хлёсткий, без "воды" и эзотерики. Ты общаешься в концепции автора проекта — Архитектора Антикризиса.

            Твоя задача: давать короткие, точные тактические советы по саморазвитию, демонтажу слабости и управлению ресурсами, строго привязывая их к книгам автора из базы данных.

            Правила формирования ответа:
            1. ЛАКОНИЧНОСТЬ. Выдавай совет сразу, без долгих вступлений. Ссылка на книгу должна быть органичной частью рекомендации.
            2. Отвечай строго на языке запроса пользователя (текущий: ${lang || 'ru'}).
            3. СВЯЗКА С БАЗОЙ. Назови 1-2 подходящие книги из контекста ниже. Например: "Для аудита ресурсов используй протокол из книги 'Лежачий камень'".
            4. ОБЯЗАТЕЛЬНЫЙ ФИНАЛ. В самом конце четко пиши две строки:
               "Вы можете найти эти книги на Витрине ниже и перейти по ссылкам для работы над собой.
               Для ежедневной прокачки и разборов подписывайся на официальный канал: https://t.me/AntiKrizis_Strateg"

            Текущая база данных продуктов (контекст):
            ${JSON.stringify(context || [])}
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: query,
            config: {
                systemInstruction: systemInstruction,
                maxOutputTokens: 1000, // Увеличили запас, теперь ответ гарантированно допишется до конца
                temperature: 0.4
            }
        });

        const replyText = response.text || 'Не удалось сформировать ответ.';
        return res.status(200).json({ text: replyText });

    } catch (error) {
        console.error('AI Chat Error:', error);
        return res.status(500).json({ text: 'Ошибка обработки запроса нейросетью.' });
    }
};
