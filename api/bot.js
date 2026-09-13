const fetch = require("node-fetch");
const { GoogleGenAI } = require("@google/genai");
const { Octokit } = require("@octokit/rest");

// Хранилище сессий (работает в рамках активных инстансов)
const userSessions = {};

// Очистка описаний Ridero от служебного мусора
function cleanRideroDescription(text) {
    if (!text) return "";
    return text
        .replace(/Издательские решения.*?ISBN.*?\n?/gi, '')
        .replace(/Создано в интеллектуальной издательской системе Ridero/gi, '')
        .replace(/Возрастное ограничение:.*$/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Отправка сообщений в Telegram с обязательным await
async function sendMessage(token, chatId, text, replyMarkup = null) {
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: "Markdown"
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (e) {
        console.error("Ошибка sendMessage:", e);
    }
}

// Извлечение Open Graph метатегов
async function fetchOgData(url) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await res.text();

        const getTag = (prop) => {
            const match = html.match(new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')) ||
                          html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i'));
            return match ? match[1] : null;
        };

        return {
            title: getTag('og:title') || '',
            description: getTag('og:description') || '',
            image: getTag('og:image') || ''
        };
    } catch (e) {
        console.error("Ошибка парсинга OG-тегов:", e);
        return { title: '', description: '', image: '' };
    }
}

// Обработка текста через Gemini API
async function generatePostWithGemini(geminiKey, title, description, link) {
    if (!geminiKey) return `*${title}*\n\n${description}\n\n[Ссылка на материал](${link})`;

    try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const prompt = `Ты — Редактор экосистемы DOMUS ARCHITECTUS. 
Напиши краткий, структурированный анонс для Telegram-канала на основе данных книги/материала.
Стиль: сухой, точный, практичный, архитектурная логика, без воды и мотивационной патетики.

Данные:
Название: ${title}
Описание: ${description}
Ссылка: ${link}

Формат ответа (Markdown):
*НАЗВАНИЕ*
Короткая суть (1-2 предложения).

[Изучить материал](${link})`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        return response.text;
    } catch (e) {
        console.error("Ошибка Gemini API:", e);
        return `*${title}*\n\n${description}\n\n[Изучить материал](${link})`;
    }
}

// Обновление data.json в GitHub
async function updateGithubData(ghToken, newProduct) {
    if (!ghToken) throw new Error("GITHUB_TOKEN не задан");

    const octokit = new Octokit({ auth: ghToken });
    const owner = "STARIN87"; // Имя владельца репозитория
    const repo = "arhantic";   // Название репозитория
    const path = "data.json";

    let sha = null;
    let currentContent = { products: [] };

    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path });
        sha = data.sha;
        const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
        currentContent = JSON.parse(decoded);
    } catch (e) {
        console.log("data.json не найден или пуст, создаётся новая база.");
    }

    if (!currentContent.products) currentContent.products = [];

    // Привязка ссылки Gumroad к существующей карточке Ridero
    if (newProduct.links?.gumroad) {
        const slug = newProduct.links.gumroad.split('/').pop().split('?')[0];
        const existing = currentContent.products.find(p => 
            (p.links?.ridero && p.links.ridero.includes(slug)) ||
            (p.links?.gumroad && p.links.gumroad.includes(slug))
        );

        if (existing) {
            existing.links.gumroad = newProduct.links.gumroad;
            if (newProduct.level) existing.level = newProduct.level;
            if (newProduct.format) existing.format = newProduct.format;
        } else {
            currentContent.products.push(newProduct);
        }
    } else {
        currentContent.products.push(newProduct);
    }

    const updatedBase64 = Buffer.from(JSON.stringify(currentContent, null, 2)).toString('base64');

    await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message: `bot: авто-обновление каталога (${newProduct.titleRu || newProduct.title})`,
        content: updatedBase64,
        sha
    });
}

// Основной Serverless Handler Vercel
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(200).json({ status: "DOMUS ARCHITECTUS BOT RUNNING" });
    }

    try {
        const tgToken = process.env.TELEGRAM_TOKEN;
        const ghToken = process.env.GITHUB_TOKEN;
        const geminiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
        const channelId = process.env.TELEGRAM_CHANNEL_ID;

        const update = req.body;
        if (!update) return res.status(200).json({ status: "Empty body" });

        // Обработка Callback Query (Нажатия на кнопки)
        if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            const data = cb.data;

            if (!userSessions[chatId]) userSessions[chatId] = {};

            if (data.startsWith('lvl_')) {
                userSessions[chatId].level = data.replace('lvl_', '');
                
                const formatKeyboard = {
                    inline_keyboard: [
                        [{ text: "📘 Прикладная система", callback_data: "fmt_applied" }],
                        [{ text: "📕 Художественная проза", callback_data: "fmt_fiction" }],
                        [{ text: "🎵 Аудио / Музыка", callback_data: "fmt_music" }],
                        [{ text: "🎨 Мерч / Арт", callback_data: "fmt_merch" }]
                    ]
                };
                await sendMessage(tgToken, chatId, "Уровень зафиксирован. Выберите формат материала:", formatKeyboard);
            } 
            else if (data.startsWith('fmt_')) {
                userSessions[chatId].format = data.replace('fmt_', '');
                userSessions[chatId].awaitingUrl = true;
                
                await sendMessage(tgToken, chatId, "Контур системы настроен. Отправьте ссылку на материал (Ridero / Gumroad):");
            }

            return res.status(200).json({ status: "ok" });
        }

        // Обработка текстовых сообщений
        if (update.message && update.message.text) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const text = msg.text.trim();

            if (text === '/start' || text === '/help') {
                userSessions[chatId] = {};
                const levelKeyboard = {
                    inline_keyboard: [
                        [{ text: "01. STATE (Состояние)", callback_data: "lvl_STATE" }],
                        [{ text: "02. MIND (Мышление)", callback_data: "lvl_MIND" }],
                        [{ text: "03. WILL (Воля)", callback_data: "lvl_WILL" }],
                        [{ text: "04. ACTION (Действие)", callback_data: "lvl_ACTION" }],
                        [{ text: "05. STRUCTURE (Структура)", callback_data: "lvl_STRUCTURE" }],
                        [{ text: "06. RELATION (Взаимодействие)", callback_data: "lvl_RELATION" }],
                        [{ text: "07. AUTONOMY (Автономия)", callback_data: "lvl_AUTONOMY" }],
                        [{ text: "08. ADAPTATION (Адаптация)", callback_data: "lvl_ADAPTATION" }]
                    ]
                };
                await sendMessage(tgToken, chatId, "// DOMUS ARCHITECTUS BOT\n\nВыберите уровень системы для привязки материала:", levelKeyboard);
                return res.status(200).json({ status: "ok" });
            }

            // Обработка входящей ссылки
            if (text.startsWith('http://') || text.startsWith('https://')) {
                const session = userSessions[chatId] || { level: "STATE", format: "applied" };
                
                await sendMessage(tgToken, chatId, "⏳ Извлечение метаданных и генерация анонса...");

                const ogData = await fetchOgData(text);
                const cleanedDesc = cleanRideroDescription(ogData.description);
                
                const isRidero = text.includes('ridero.ru');
                const isGumroad = text.includes('gumroad.com');

                const product = {
                    format: session.format || "applied",
                    level: session.level || "STATE",
                    category: session.format || "applied",
                    title: ogData.title || "Без названия",
                    titleRu: ogData.title || "Без названия",
                    description: cleanedDesc,
                    descRu: cleanedDesc,
                    cover: ogData.image || "",
                    links: {
                        ridero: isRidero ? text : "",
                        gumroad: isGumroad ? text : ""
                    }
                };

                // 1. Обновляем GitHub data.json
                await updateGithubData(ghToken, product);

                // 2. Генерируем анонс через Gemini
                const postContent = await generatePostWithGemini(geminiKey, product.title, product.description, text);

                // 3. Отправляем анонс в Telegram-канал (если задан)
                if (channelId) {
                    await sendMessage(tgToken, channelId, postContent);
                }

                await sendMessage(tgToken, chatId, `✅ Материал успешно добавлен в базу и опубликован!\n\n*Заголовок:* ${product.title}\n*Уровень:* ${product.level}\n*Формат:* ${product.format}`);
                
                userSessions[chatId] = {};
            } else {
                await sendMessage(tgToken, chatId, "Отправьте корректную URL-ссылку или нажмите /start для сброса.");
            }
        }

        return res.status(200).json({ status: "ok" });

    } catch (error) {
        console.error("RUNTIME ERROR:", error.stack || error);
        return res.status(200).json({ error: error.message });
    }
};
