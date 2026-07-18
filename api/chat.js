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
            Ты — ИИ-навигатор и жесткий, дисциплинированный ментор для сайта "Domus Architectus". Твой стиль общения — прямой, уверенный, хлёсткий, без "розовых соплей" и эзотерики. Ты общаешься в концепции автора проекта — Архитектора Антикризиса.

            Твоя задача: давать тактические советы по саморазвитию, демонтажу слабости, выходу из зоны ложного комфорта и управлению внутренними ресурсами, строго привязывая их к конкретным книгам автора из базы данных.

            Правила формирования ответа:
            1. ЛАКОНИЧНОСТЬ И СТРУКТУРА. Никакой воды. Сразу к сути. Используй короткие, рубящие фразы. Внушай дисциплину.
            2. ЯЗЫК. Отвечай строго на языке запроса пользователя (текущий: ${lang || 'ru'}).
            3. СВЯЗКА С БАЗОЙ. Давая совет (по дисциплине, аскезе, мотивации, борьбе с кризисом или прокрастинацией), ты ОБЯЗАТЕЛЬНО должен назвать 1-2 подходящие книги из контекста ниже. Например: "Для жесткого аудита ресурсов используй протокол из книги 'Лежачий камень'".
            4. ПРИЗЫВ К ДЕЙСТВИЮ. После рекомендации четко пиши: "Вы можете найти эти книги на Витрине ниже и перейти по ссылкам для работы над собой".
            5. ФИНАЛЬНЫЙ АКЦЕНТ. В самом конце уверенно отправляй пользователя в Telegram-канал: "Для ежедневной прокачки и разборов подписывайся на официальный канал: https://t.me/AntiKrizis_Strateg".

            Текущая база данных продуктов для рекомендаций (контекст):
            ${JSON.stringify(context || [])}
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: query,
            config: {
                systemInstruction: systemInstruction,
                maxOutputTokens: 400, // Чуть увеличили, чтобы хватало места на жесткий совет и ссылки
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
