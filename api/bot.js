const fetch = require("node-fetch");
const { GoogleGenAI } = require("@google/genai");
const { Octokit } = require("@octokit/rest");

const userSessions = {};

function cleanRideroDescription(text) {
    if (!text) return "";
    return text
        .replace(/Издательские решения.*?ISBN.*?\n?/gi, '')
        .replace(/Создано в интеллектуальной издательской системе Ridero/gi, '')
        .replace(/Возрастное ограничение:.*$/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function sendMessage(token, chatId, text, replyMarkup = null) {
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: "Markdown"
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error("Ошибка sendMessage:", e);
    }
}

// Извлечение OG-тегов с жестким таймаутом в 4 секунды
async function fetchOgData(url) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        const res = await fetch(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: controller.signal
        });
        clearTimeout(timeout);

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
        console.error("Таймаут или ошибка парсинга OG-тегов:", e.message);
        return { title: '', description: '', image: '' };
    }
}

// Быстрая генерация анонса Gemini
async function generatePostWithGemini(geminiKey, title, description, link) {
    if (!geminiKey) return `*${title}*\n\n${description}\n\n[Ссылка на материал](${link})`;

    try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const prompt = `Ты — Редактор DOMUS ARCHITECTUS. Напиши краткий анонс для Telegram-канала на основе данных.
Стиль: сухой, точный, архитектурный.
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
        console.error("Ошибка Gemini API:", e.message);
        return `*${title}*\n\n${description}\n\n[Изучить материал](${link})`;
    }
}

// Безопасное обновление GitHub data.json
async function updateGithubData(ghToken, newProduct) {
    if (!ghToken) return;

    const octokit = new Octokit({ auth: ghToken });
    const owner = "STARIN87";
    const repo = "arhantic";
    const path = "data.json";

    let sha = null;
    let currentContent = { products: [] };

    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path });
        sha = data.sha;
        const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
        currentContent = JSON.parse(decoded);
    } catch (e) {
        console.log("Создаем новый data.json");
    }

    if (!currentContent.products) currentContent.products = [];

    // Привязка Gumroad к существующему карточке Ridero
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
        message: `bot: обновление каталога (${newProduct.titleRu || newProduct.title})`,
        content: updatedBase64,
        sha
    });
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(200).json({ status: "DOMUS ARCHITECTUS BOT OPERATIONAL" });
    }

    try {
        const tgToken = process.env.TELEGRAM_TOKEN;
        const ghToken = process.env.GITHUB_TOKEN;
        const geminiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
        const channelId = process.env.TELEGRAM_CHANNEL_ID;

        const update = req.body;
        if (!update) return res.status(200).json({ status: "Empty body" });

        // Обработка кнопок
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
                await sendMessage(tgToken, chatId, "Контур системы настроен. Отправьте ссылку на материал:");
            }

            return res.status(200).json({ status: "ok" });
        }

        // Обработка текстовых сообщений и ссылок
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

            if (text.startsWith('http://') || text.startsWith('https://')) {
                const session = userSessions[chatId] || { level: "STATE", format: "applied" };

                // Извлечение метаданных
                const ogData = await fetchOgData(text);
                const cleanedDesc = cleanRideroDescription(ogData.description);
                const fallbackTitle = text.split('/').pop().replace(/-/g, ' ') || "Материал системы";

                const product = {
                    format: session.format || "applied",
                    level: session.level || "STATE",
                    category: session.format || "applied",
                    title: ogData.title || fallbackTitle,
                    titleRu: ogData.title || fallbackTitle,
                    description: cleanedDesc,
                    descRu: cleanedDesc,
                    cover: ogData.image || "",
                    links: {
                        ridero: text.includes('ridero.ru') ? text : "",
                        gumroad: text.includes('gumroad.com') ? text : ""
                    }
                };

                // Запись в GitHub
                try {
                    await updateGithubData(ghToken, product);
                } catch (e) {
                    console.error("Ошибка записи в GitHub:", e.message);
                }

                // Генерация поста
                const postContent = await generatePostWithGemini(geminiKey, product.title, product.description, text);

                // Постинг в канал
                if (channelId) {
                    await sendMessage(tgToken, channelId, postContent);
                }

                // Ответ пользователю
                await sendMessage(tgToken, chatId, `✅ *Материал успешно обработан!*\n\n*Заголовок:* ${product.title}\n*Уровень:* ${product.level}\n*Формат:* ${product.format}`);
                
                userSessions[chatId] = {};
            } else {
                await sendMessage(tgToken, chatId, "Отправьте URL-ссылку или нажмите /start для сброса.");
            }
        }

        return res.status(200).json({ status: "ok" });

    } catch (error) {
        console.error("RUNTIME ERROR:", error.stack || error);
        return res.status(200).json({ error: error.message });
    }
};
