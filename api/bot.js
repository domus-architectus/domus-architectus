const { Octokit } = require("@octokit/rest");
const fetch = require("node-fetch");
const { GoogleGenAI } = require("@google/genai"); 

// Конфигурация GitHub
const GH_OWNER = "domus-architectus"; 
const GH_REPO = "domus-architectus";  
const GH_PATH = "data.json";

// Инициализация API
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const apiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey }); 

// Хелпер для безопасного экранирования HTML-символов под требования Telegram
function escapeHTML(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace/>/g, "&gt;");
}

// Нормализация названий для точного сравнения без учета регистра и спецсимволов
function normalizeTitle(title) {
    if (!title) return "";
    return title.toLowerCase()
        .replace(/[^a-zа-яё0-9]/g, "")
        .replace(/ё/g, "е")
        .trim();
}

// ОЧИСТКА ОПИСАНИЯ RIDERO ОТ ТЕХНИЧЕСКОЙ ИНОРМАЦИИ
function cleanRideroDescription(rawText) {
    if (!rawText) return "";
    
    let clean = String(rawText)
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');

    // Вырезаем технический шум Ridero
    clean = clean
        .replace(/ISBN\s*:?\s*[\d\-]+/gi, '')
        .replace(/Возрастное\s+ограничение\s*:?\s*\d+\+/gi, '')
        .replace(/\b(0|6|12|16|18)\+\b/g, '')
        .replace(/Объем\s*:?\s*\d+\s*(стр|страниц|стр\.)/gi, '')
        .replace(/\b\d+\s*(стр|страниц|стр\.)\b/gi, '')
        .replace(/Издательские\s+решения/gi, '')
        .replace(/Содержит\s+(нецензурную|ненормативную)\s+лексику\.?/gi, '')
        .replace(/Содержит\s+иллюстрации\.?/gi, '')
        .replace(/Формат\s*:?\s*[\w\d\s\.\,]+/gi, '')
        .replace(/Правообладатель.*$/gi, '')
        .replace(/©.*$/gi, '');

    // Форматирование пробелов и абзацев
    return clean
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

// ПАРСЕР RIDERO С ЧИСТКОЙ ОПИСАНИЯ
async function parseRidero(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Не удалось загрузить страницу Ridero");
    
    const buffer = await res.buffer();
    const html = buffer.toString('utf-8');

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

    let title = titleMatch ? titleMatch[1] : "Новая книга";
    let rawDesc = descMatch ? descMatch[1] : "";
    let cover = imageMatch ? imageMatch[1] : "";

    if (cover && cover.startsWith("//")) cover = "https:" + cover;

    title = title.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const description = cleanRideroDescription(rawDesc);

    return { title, description, cover };
}

// ПАРСЕР GUMROAD
async function parseGumroad(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    if (!res.ok) throw new Error("Не удалось загрузить страницу Gumroad");
    
    const buffer = await res.buffer();
    const html = buffer.toString('utf-8');

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/) || html.match(/<meta name="description" content="([^"]+)"/);
    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

    let title = titleMatch ? titleMatch[1] : "Новый media-проект";
    let description = descMatch ? descMatch[1] : "";
    let cover = imageMatch ? imageMatch[1] : "";

    title = title.replace(" | Gumroad", "").trim();
    description = description.replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

    return { title, description, cover };
}

// КЛАВИАТУРЫ ДЛЯ ТЕЛЕГРАМ
function getFormatKeyboard(includeBind = false) {
    const buttons = [
        [
            { text: "📘 Прикладное руководство", callback_data: "fmt_applied" },
            { text: "📕 Художественная", callback_data: "fmt_fiction" }
        ],
        [
            { text: "🎵 Музыка / Аудио", callback_data: "fmt_music" },
            { text: "🎨 Мерч / Арт", callback_data: "fmt_merch" }
        ]
    ];
    if (includeBind) {
        buttons.push([{ text: "🔗 Вписать в карточку Ridero", callback_data: "gmr_bind" }]);
    }
    return { inline_keyboard: buttons };
}

function getLevelKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: "01. Состояние (STATE)", callback_data: "lvl_STATE" },
                { text: "02. Мышление (MIND)", callback_data: "lvl_MIND" }
            ],
            [
                { text: "03. Воля (WILL)", callback_data: "lvl_WILL" },
                { text: "04. Действие (ACTION)", callback_data: "lvl_ACTION" }
            ],
            [
                { text: "05. Структура (STRUCTURE)", callback_data: "lvl_STRUCTURE" },
                { text: "06. Взаимодействие (RELATION)", callback_data: "lvl_RELATION" }
            ],
            [
                { text: "07. Автономия (AUTONOMY)", callback_data: "lvl_AUTONOMY" },
                { text: "08. Адаптация (ADAPTATION)", callback_data: "lvl_ADAPTATION" }
            ],
            [
                { text: "🌐 Общий / Вне уровней (ALL)", callback_data: "lvl_ALL" }
            ]
        ]
    };
}

// Отправка сообщений в Telegram
async function sendTelegram(chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    
    let cleanText = String(text)
        .normalize('NFC')
        .replace(/\u00A0/g, ' ') 
        .replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

    cleanText = Buffer.from(cleanText, 'utf-8').toString('utf-8');

    const body = { 
        chat_id: chatId, 
        text: cleanText, 
        parse_mode: "HTML" 
    }; 
    
    if (replyMarkup) {
        body.reply_markup = typeof replyMarkup === "string" ? replyMarkup : JSON.stringify(replyMarkup);
    }

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Telegram API Error: ${errText}`);
    }
}

// Хранилище сессий пользователей
let userSessions = {};

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        return res.status(200).send("ОК. Только POST запросы.");
    }

    try {
        const update = req.body;

        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            const lowerText = text.toLowerCase();

            // ХЕНДЛЕР УДАЛЕНИЯ КАРТОЧКИ
            if (text.startsWith('/delete') || lowerText.startsWith('удалить')) {
                const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
                if (!urlMatch) {
                    await sendTelegram(chatId, "🚨 Ошибка: Не обнаружена ссылка для удаления. Укажите команду и ссылку через пробел.");
                    return res.status(200).send("ОК");
                }
                const cleanUrl = urlMatch[0].split("?")[0].trim();
                await sendTelegram(chatId, `⏳ Запускаю процедуру ликвидации карточки по ссылке:\n${cleanUrl}...`);
                await finalizeProductDeletion(chatId, cleanUrl);
                return res.status(200).send("ОК");
            }

            // Дозаливка (связывание) Gumroad-ссылки с существующей статьей Ridero
            if (userSessions[chatId] && userSessions[chatId].awaitingRideroBinding) {
                if (text.includes("ridero.ru")) {
                    const cleanRideroUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0]?.split("?")[0] || text;
                    const urlParts = cleanRideroUrl.replace(/\/$/, "").split("/");
                    const bookSlug = urlParts[urlParts.length - 1];
                    const fullUrl = userSessions[chatId].url;

                    await sendTelegram(chatId, "🔄 Связующая ссылка Ridero получена. Интегрирую Gumroad внутрь имеющейся карточки...");
                    await finalizeProductCreation(chatId, { type: 'gumroad_bind', url: fullUrl, rideroSlug: bookSlug });
                    delete userSessions[chatId];
                    return res.status(200).send("ОК");
                } else {
                    await sendTelegram(chatId, "⚠️ Отправьте корректную ссылку на Ridero для связывания.");
                    return res.status(200).send("ОК");
                }
            }

            // Прямой перехват маркеров формата ("музыка [ссылка]", "мерч [ссылка]")
            if (text.includes("gumroad.com") && (lowerText.includes("музыка") || lowerText.includes("аудио") || lowerText.includes("мерч") || lowerText.includes("арт"))) {
                const cleanUrl = (text.match(/(https?:\/\/[^\s]+)/)?.[0] || text).split("?")[0].trim();
                const targetFormat = (lowerText.includes("музыка") || lowerText.includes("аудио")) ? "music" : "merch";

                userSessions[chatId] = { type: 'gumroad', url: cleanUrl, format: targetFormat };
                await sendTelegram(chatId, `⚡ Формат определен: <b>${targetFormat}</b>. Теперь выберите уровень системы:`, getLevelKeyboard());
                return res.status(200).send("ОК");
            }

            // Обработка ссылок Gumroad
            if (text.includes("gumroad.com")) {
                const cleanUrl = (text.match(/(https?:\/\/[^\s]+)/)?.[0] || text).split("?")[0].trim();
                userSessions[chatId] = { type: 'gumroad', url: cleanUrl };
                await sendTelegram(chatId, "Ссылка Gumroad принята.\n\n<b>Шаг 1 из 2:</b> Выберите формат материала или связывание с Ridero:", getFormatKeyboard(true));
                return res.status(200).send("ОК");
            }

            // Обработка ссылок Ridero
            if (text.includes("ridero.ru")) {
                const cleanUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                const urlParts = cleanUrl.split("?")[0].replace(/\/$/, "").split("/");
                const bookSlug = urlParts[urlParts.length - 1];

                userSessions[chatId] = { type: 'ridero', url: cleanUrl, slug: bookSlug };
                await sendTelegram(chatId, "Ссылка Ridero принята.\n\n<b>Шаг 1 из 2:</b> Выберите формат проекта:", getFormatKeyboard(false));
                return res.status(200).send("ОК");
            }

            await sendTelegram(chatId, "Приветствую, Архитектор. Чтобы добавить материал на сайт, отправьте ссылку на Ridero или Gumroad.\nДля удаления введите: `удалить [ссылка]`.");
        }

        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;

            if (!userSessions[chatId]) {
                await sendTelegram(chatId, "⚠️ Сессия истекла. Пожалуйста, отправьте ссылку на материал заново.");
                return res.status(200).send("ОК");
            }

            // Кнопка привязки к книги Ridero
            if (data === "gmr_bind") {
                userSessions[chatId].awaitingRideroBinding = true;
                await sendTelegram(chatId, "🔗 Отправьте ссылку Ridero на книгу, в которую нужно вписать эту ссылку Gumroad:");
                return res.status(200).send("ОК");
            }

            // Обработка выбора ФОРМАТА (Шаг 1)
            if (data.startsWith("fmt_")) {
                const selectedFormat = data.replace("fmt_", "");
                userSessions[chatId].format = selectedFormat;

                await sendTelegram(chatId, `Формат зафиксирован: <b>${selectedFormat}</b>.\n\n<b>Шаг 2 из 2:</b> Укажите уровень системы (01–08) для размещения на витрине:`, getLevelKeyboard());
                return res.status(200).send("ОК");
            }

            // Обработка выбора УРОВНЯ СИСТЕМЫ (Шаг 2)
            if (data.startsWith("lvl_")) {
                const selectedLevel = data.replace("lvl_", "");
                userSessions[chatId].level = selectedLevel;

                const session = { ...userSessions[chatId] };
                delete userSessions[chatId]; 

                await sendTelegram(chatId, `🔄 Параметры приняты [Формат: ${session.format} | Уровень: ${session.level}]. Публикую материал на витрине...`);
                await finalizeProductCreation(chatId, session);
                return res.status(200).send("ОК");
            }
        }

    } catch (error) {
        console.error("Ошибка в работе бота:", error);
        if (req.body && (req.body.message || req.body.callback_query)) {
            const chatId = req.body.message ? req.body.message.chat.id : req.body.callback_query.message.chat.id;
            const safeError = escapeHTML(error.message);
            await sendTelegram(chatId, `🚨 Произошел сбой: ${safeError}`);
        }
    }

    res.status(200).send("ОК");
};

// ЕДИНАЯ ФУНКЦИЯ СОХРАНЕНИЯ В DATA.JSON
async function finalizeProductCreation(chatId, config) {
    let incomingProduct = {};
    let targetLinkForPromo = ""; 
    let bindingRideroSlug = config.rideroSlug || null;

    if (config.type === 'ridero') {
        const bookUrl = `https://ridero.ru/books/${config.slug}/`;
        const data = await parseRidero(bookUrl);
        incomingProduct = {
            format: config.format || "applied",
            level: config.level || "ALL",
            category: config.format || "applied", // Совместимость
            title: data.title,
            titleRu: data.title,
            description: data.description,
            descRu: data.description,
            cover: data.cover,
            links: { 
                ridero: bookUrl,
                gumroad: config.extraGumroad || ""
            }
        };
        targetLinkForPromo = bookUrl;
    } 
    else if (config.type === 'gumroad' || config.type === 'gumroad_bind') {
        const data = await parseGumroad(config.url);
        incomingProduct = {
            format: config.format || "applied",
            level: config.level || "ALL",
            category: config.format || "applied", 
            title: data.title,
            titleRu: data.title,
            description: data.description,
            descRu: data.description,
            cover: data.cover,
            links: { 
                ridero: "", 
                gumroad: config.url 
            }
        };
        targetLinkForPromo = config.url;
    }

    // Выгрузка текущего data.json
    let currentContent = { products: [] };
    let sha = null;

    try {
        const ghRes = await octokit.repos.getContent({
            owner: GH_OWNER,
            repo: GH_REPO,
            path: GH_PATH
        });
        sha = ghRes.data.sha;
        const stringContent = Buffer.from(ghRes.data.content, 'base64').toString('utf-8');
        currentContent = JSON.parse(stringContent);
    } catch (e) {
        console.log("data.json не найден, инициализируем базу.");
    }

    if (!currentContent.products) currentContent.products = [];

    let existingProductIndex = -1;
    let isUpdated = false;

    // Сшивка по Ridero слагу
    if (config.type === 'gumroad_bind' && bindingRideroSlug) {
        const targetRideroSegment = `/books/${bindingRideroSlug}`.toLowerCase();
        existingProductIndex = currentContent.products.findIndex(p => 
            p.links && p.links.ridero && p.links.ridero.toLowerCase().includes(targetRideroSegment)
        );
    } else {
        const targetNormTitle = normalizeTitle(incomingProduct.title);
        existingProductIndex = currentContent.products.findIndex(p => normalizeTitle(p.title || p.titleRu) === targetNormTitle);
    }

    if (existingProductIndex !== -1) {
        let existingProduct = currentContent.products[existingProductIndex];
        if (!existingProduct.links) existingProduct.links = { ridero: "", gumroad: "" };
        
        if (incomingProduct.links.gumroad) {
            existingProduct.links.gumroad = incomingProduct.links.gumroad;
        }
        
        incomingProduct = existingProduct; 
        currentContent.products[existingProductIndex] = existingProduct;
        isUpdated = true;
    } else {
        if (config.type === 'gumroad_bind') {
            throw new Error(`Книга "${bindingRideroSlug}" не найдена в базе сайта. Сначала добавьте ее по ссылке Ridero.`);
        }
        currentContent.products.unshift(incomingProduct);
    }

    // Сохранение на GitHub
    const updatedString = JSON.stringify(currentContent, null, 2);
    const updatedBase64 = Buffer.from(updatedString).toString('base64');

    const commitMessage = isUpdated 
        ? `Обновление ссылок: "${incomingProduct.title || incomingProduct.titleRu}"`
        : `Добавлен проект: "${incomingProduct.title || incomingProduct.titleRu}" [${incomingProduct.level}]`;

    await octokit.repos.createOrUpdateFileContents({
        owner: GH_OWNER,
        repo: GH_REPO,
        path: GH_PATH,
        message: commitMessage,
        content: updatedBase64,
        sha: sha
    });

    const statusMessage = isUpdated
        ? `✅ Ссылка Gumroad успешно вписана в карточку книги "${escapeHTML(incomingProduct.title || incomingProduct.titleRu)}".`
        : `✅ Новая карточка "${escapeHTML(incomingProduct.title || incomingProduct.titleRu)}" опубликована на сайте.`;

    await sendTelegram(chatId, `${statusMessage}\n\n🤖 Генерирую промо-пост через ИИ...`);

    // БЛОК ИИ-ПОСТА
    try {
        const systemInstruction = 
            "Ты — строгий информационный робот. Твоя задача — переписать аннотацию в виде сухого информационного сообщения.\n" +
            "Категорически запрещено: обращаться к читателям, писать вводные фразы, использовать списки, эмодзи, капслок, восклицательные знаки, призывы к покупкам.\n" +
            "СТРУКТУРА:\n" +
            "Вышел новый проект НАЗВАНИЕ.\n" +
            "Суть проекта и аннотация материала: ТЕКСТ АННОТАЦИИ ОДНИМ СПЛОШНЫМ АБЗАЦЕМ.\n" +
            "Ссылка на проект: ССЫЛКА.";

        const cleanDesc = (incomingProduct.description || incomingProduct.descRu || "")
            .replace(/[*#`]/g, "")
            .replace(/[\-\•]\s+/g, "")
            .replace(/\n+/g, " ")
            .trim();

        const prompt = `Сформируй сухой пост. Проект: "${incomingProduct.title || incomingProduct.titleRu}". Аннотация: ${cleanDesc}. Ссылка: ${targetLinkForPromo}`;

        const aiResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.0 
            }
        });

        let generatedPost = aiResponse.text ? aiResponse.text.trim() : "";

        if (!generatedPost || generatedPost.includes("Отличный выбор")) {
            generatedPost = `Вышел новый проект: "${incomingProduct.title || incomingProduct.titleRu}"\n\nСуть проекта и аннотация материала: ${cleanDesc}\n\nОфициальная страница проекта: ${targetLinkForPromo}`;
        } else {
            generatedPost = generatedPost
                .replace(/[*#`—\-]/g, "")
                .replace(/[🚀💡📖✨📚👉📢⚠️🚨✅]/g, "")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
        }

        if (!generatedPost.includes(targetLinkForPromo)) {
            generatedPost += `\n\nОфициальная страница проекта: ${targetLinkForPromo}`;
        }

        const finalHtmlPost = escapeHTML(generatedPost)
            .replace(/&lt;a href=\"(.*?)\"&gt;(.*?)&lt;\/a&gt;/g, '<a href="$1">$2</a>'); 

        if (process.env.TELEGRAM_CHANNEL_ID) {
            await sendTelegram(process.env.TELEGRAM_CHANNEL_ID, finalHtmlPost);
            await sendTelegram(chatId, `📢 Информационный пост отправлен в канал ${process.env.TELEGRAM_CHANNEL_ID}`);
        } else {
            await sendTelegram(chatId, `💡 Пост для размещения:\n\n${finalHtmlPost}`);
        }

    } catch (aiError) {
        console.error("Ошибка ИИ:", aiError);
        await sendTelegram(chatId, `⚠️ Продукт сохранён, но при генерации поста возник сбой: ${escapeHTML(aiError.message)}`);
    }
}

// УДАЛЕНИЕ КАРТОЧКИ
async function finalizeProductDeletion(chatId, targetUrl) {
    let currentContent = { products: [] };
    let sha = null;

    try {
        const ghRes = await octokit.repos.getContent({
            owner: GH_OWNER,
            repo: GH_REPO,
            path: GH_PATH
        });
        sha = ghRes.data.sha;
        const stringContent = Buffer.from(ghRes.data.content, 'base64').toString('utf-8');
        currentContent = JSON.parse(stringContent);
    } catch (e) {
        throw new Error("Не удалось загрузить data.json с GitHub.");
    }

    if (!currentContent.products || currentContent.products.length === 0) {
        await sendTelegram(chatId, "⚠️ База данных пуста.");
        return;
    }

    const normalizedTargetUrl = targetUrl.toLowerCase().replace(/\/$/, "");

    const targetIndex = currentContent.products.findIndex(p => {
        const rideroLink = p.links && p.links.ridero ? p.links.ridero.toLowerCase().replace(/\/$/, "") : "";
        const gumroadLink = p.links && p.links.gumroad ? p.links.gumroad.toLowerCase().replace(/\/$/, "") : "";
        return rideroLink === normalizedTargetUrl || gumroadLink === normalizedTargetUrl;
    });

    if (targetIndex === -1) {
        await sendTelegram(chatId, `❌ Карточка с такой ссылкой не найдена.`);
        return;
    }

    const deletedTitle = currentContent.products[targetIndex].title || currentContent.products[targetIndex].titleRu;
    currentContent.products.splice(targetIndex, 1);

    const updatedString = JSON.stringify(currentContent, null, 2);
    const updatedBase64 = Buffer.from(updatedString).toString('base64');

    await octokit.repos.createOrUpdateFileContents({
        owner: GH_OWNER,
        repo: GH_REPO,
        path: GH_PATH,
        message: `Удален проект: "${deletedTitle}"`,
        content: updatedBase64,
        sha: sha
    });

    await sendTelegram(chatId, `🗑️ Карточка проекта "${escapeHTML(deletedTitle)}" полностью удалена с сайта.`);
}
