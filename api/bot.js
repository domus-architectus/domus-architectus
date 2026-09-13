const { Octokit } = require("@octokit/rest");
const fetch = require("node-fetch");
const { GoogleGenAI } = require("@google/genai");

// Конфигурация GitHub
const GH_OWNER = process.env.GH_OWNER || "domus-architectus"; 
const GH_REPO = process.env.GH_REPO || "domus-architectus";  
const GH_PATH = "data.json";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const apiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey: apiKey }) : null;

// Экранирование HTML для Telegram
function escapeHTML(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Нормализация названий
function normalizeTitle(title) {
    if (!title) return "";
    return title.toLowerCase()
        .replace(/[^a-zа-яё0-9]/g, "")
        .replace(/ё/g, "е")
        .trim();
}

// Парсер Ridero
async function parseRidero(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("Не удалось загрузить страницу Ridero");
        
        const buffer = await res.buffer();
        const html = buffer.toString('utf-8');

        const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
        const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
        const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

        let title = titleMatch ? titleMatch[1] : "Новая книга";
        let description = descMatch ? descMatch[1] : "";
        let cover = imageMatch ? imageMatch[1] : "";

        if (cover && cover.startsWith("//")) cover = "https:" + cover;

        title = title.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        description = description.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

        return { title, description, cover };
    } finally {
        clearTimeout(timeout);
    }
}

// Парсер Gumroad
async function parseGumroad(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            signal: controller.signal
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

        return { title, description, cover };
    } finally {
        clearTimeout(timeout);
    }
}

// Отправка сообщений Telegram (HTML)
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

let userSessions = {};

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        return res.status(200).send("DOMUS ARCHITECTUS BOT OPERATIONAL");
    }

    try {
        const update = req.body;
        if (!update) return res.status(200).send("ОК");

        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            const lowerText = text.toLowerCase();

            // 1. ХЕНДЛЕР УДАЛЕНИЯ
            if (text.startsWith('/delete') || lowerText.startsWith('удалить')) {
                const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
                if (!urlMatch) {
                    await sendTelegram(chatId, "🚨 Ошибка: Укажите ссылку для удаления через пробел.");
                    return res.status(200).send("ОК");
                }
                
                const cleanUrl = urlMatch[0].split("?")[0].trim();
                await sendTelegram(chatId, `⏳ Запускаю ликвидацию карточки:\n${cleanUrl}...`);
                await finalizeProductDeletion(chatId, cleanUrl);
                return res.status(200).send("ОК");
            }

            // 2. СВЯЗЫВАНИЕ GUMROAD С RIDERO
            if (userSessions[chatId] && userSessions[chatId].gumroadUrl && userSessions[chatId].awaitingRideroBinding) {
                if (text.includes("ridero.ru")) {
                    const cleanRideroUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0]?.split("?")[0] || text;
                    const urlParts = cleanRideroUrl.replace(/\/$/, "").split("/");
                    const bookSlug = urlParts[urlParts.length - 1];
                    const fullUrl = userSessions[chatId].gumroadUrl;

                    await sendTelegram(chatId, "🔄 Найдена связующая ссылка Ridero. Интегрирую в карточку...");
                    await finalizeProductCreation(chatId, { type: 'gumroad_bind', url: fullUrl, rideroSlug: bookSlug });
                    
                    delete userSessions[chatId];
                    return res.status(200).send("ОК");
                } else {
                    await sendTelegram(chatId, "⚠️ Отправьте корректную ссылку на Ridero для связывания.");
                    return res.status(200).send("ОК");
                }
            }

            // 3. ТЕКСТОВЫЙ ПЕРЕХВАТЧИК
            if (text.includes("gumroad.com") && (lowerText.includes("музыка") || lowerText.includes("аудио") || lowerText.includes("мерч") || lowerText.includes("арт"))) {
                const cleanUrl = (text.match(/(https?:\/\/[^\s]+)/)?.[0] || text).split("?")[0].trim();
                const targetCategory = (lowerText.includes("музыка") || lowerText.includes("аудио")) ? "music" : "merch";

                await sendTelegram(chatId, `⚡ Маркер обнаружен. Парсинг Gumroad (${targetCategory})...`);
                await finalizeProductCreation(chatId, { type: 'gumroad', url: cleanUrl, category: targetCategory });
                if (userSessions[chatId]) delete userSessions[chatId];
                return res.status(200).send("ОК");
            }

            // 4. ССЫЛКА GUMROAD
            if (text.includes("gumroad.com")) {
                const cleanUrl = (text.match(/(https?:\/\/[^\s]+)/)?.[0] || text).split("?")[0].trim();
                userSessions[chatId] = { gumroadUrl: cleanUrl };

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "🎵 Музыка / Аудио", callback_data: "gmr_music" },
                            { text: "🎨 Мерч / Арт", callback_data: "gmr_merch" },
                            { text: "📘 Вписать в книгу Ridero", callback_data: "gmr_book" }
                        ]
                    ]
                };
                
                await sendTelegram(chatId, "Ссылка Gumroad принята. Выберите тип контента:", keyboard);
                return res.status(200).send("ОК");
            }

            // 5. ССЫЛКА RIDERO
            if (text.includes("ridero.ru")) {
                const cleanUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                const urlParts = cleanUrl.split("?")[0].replace(/\/$/, "").split("/");
                const bookSlug = urlParts[urlParts.length - 1];

                userSessions[chatId] = { bookSlug: bookSlug };

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "📘 Прикладное руководство", callback_data: "rid_applied" },
                            { text: "📕 Художественная", callback_data: "rid_fiction" }
                        ]
                    ]
                };
                
                await sendTelegram(chatId, "Ссылка Ridero принята. Выберите категорию:", keyboard);
                return res.status(200).send("ОК");
            }

            await sendTelegram(chatId, "Приветствую. Отправьте ссылку на Ridero или Gumroad. Для удаления карточки введите: `удалить [ссылка]`.");
        }

        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;

            if (data === "rid_applied" || data === "rid_fiction") {
                if (!userSessions[chatId] || !userSessions[chatId].bookSlug) {
                    throw new Error("Сессия Ridero не найдена. Отправьте ссылку заново.");
                }

                const category = data.replace("rid_", "");
                const bookSlug = userSessions[chatId].bookSlug;
                delete userSessions[chatId]; 

                await sendTelegram(chatId, "🔄 Категория определена. Публикую книгу на витрине...");
                await finalizeProductCreation(chatId, { type: 'ridero', slug: bookSlug, category: category });
                return res.status(200).send("ОК");
            }

            if (data === "gmr_book") {
                if (!userSessions[chatId] || !userSessions[chatId].gumroadUrl) {
                    throw new Error("Сессия Gumroad не найдена.");
                }
                userSessions[chatId].awaitingRideroBinding = true;
                await sendTelegram(chatId, "🔗 Отправьте боту ссылку Ridero на книгу, в которую нужно вписать Gumroad:");
                return res.status(200).send("ОК");
            }

            if (data.startsWith("gmr_")) {
                const category = data.replace("gmr_", ""); 
                if (!userSessions[chatId] || !userSessions[chatId].gumroadUrl) {
                    throw new Error("Сессия Gumroad не найдена. Отправьте ссылку заново.");
                }

                const fullUrl = userSessions[chatId].gumroadUrl;
                delete userSessions[chatId]; 

                await sendTelegram(chatId, `🔄 Парсинг Gumroad (${category})...`);
                await finalizeProductCreation(chatId, { type: 'gumroad', url: fullUrl, category: category });
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

// СОХРАНЕНИЕ И ИИ-ГЕНЕРАЦИЯ
async function finalizeProductCreation(chatId, config) {
    let incomingProduct = {};
    let targetLinkForPromo = ""; 
    let bindingRideroSlug = config.rideroSlug || null;

    if (config.type === 'ridero') {
        const bookUrl = `https://ridero.ru/books/${config.slug}/`;
        const data = await parseRidero(bookUrl);
        incomingProduct = {
            format: config.category || "applied",
            level: "STATE",
            category: config.category,
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
            format: config.category || "applied",
            level: "STATE",
            category: config.category || "applied", 
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
        console.log("data.json не найден, создаем структуру с нуля.");
    }

    if (!currentContent.products) currentContent.products = [];

    let existingProductIndex = -1;
    let isUpdated = false;

    if (config.type === 'gumroad_bind' && bindingRideroSlug) {
        const targetRideroSegment = `/books/${bindingRideroSlug}`.toLowerCase();
        existingProductIndex = currentContent.products.findIndex(p => 
            p.links && p.links.ridero && p.links.ridero.toLowerCase().includes(targetRideroSegment)
        );
    } else {
        const targetNormTitle = normalizeTitle(incomingProduct.title);
        existingProductIndex = currentContent.products.findIndex(p => normalizeTitle(p.title) === targetNormTitle);
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
            throw new Error(`Книга со слагом "${bindingRideroSlug}" не найдена в базе сайта. Сначала добавьте её через ссылку Ridero.`);
        }
        currentContent.products.unshift(incomingProduct);
    }

    const updatedString = JSON.stringify(currentContent, null, 2);
    const updatedBase64 = Buffer.from(updatedString).toString('base64');

    const commitMessage = isUpdated 
        ? `bot: обновлены ссылки для "${incomingProduct.title}"`
        : `bot: добавлен проект "${incomingProduct.title}"`;

    await octokit.repos.createOrUpdateFileContents({
        owner: GH_OWNER,
        repo: GH_REPO,
        path: GH_PATH,
        message: commitMessage,
        content: updatedBase64,
        sha: sha
    });

    const statusMessage = isUpdated
        ? `✅ Успешно! Ссылка Gumroad привязана к карточке "${escapeHTML(incomingProduct.title)}".`
        : `✅ Успех! Новый проект "${escapeHTML(incomingProduct.title)}" добавлен на сайт.`;

    await sendTelegram(chatId, `${statusMessage}\n\n🔄 Генерация анонса...`);

    // ИИ-генерация текста
    try {
        if (!ai) throw new Error("GEMINI_API_KEY не установлен.");

        const systemInstruction = 
            "Ты — строгий информационный робот-автомат. Твоя единственная задача — переписать аннотацию в виде сухого новостного сообщения.\n" +
            "Категорически запрещено: общаться с пользователем, писать вводные фразы, использовать списки, дефисы, любые эмодзи, капслок, восклицательные знаки и вопросы.\n" +
            "Запрещено использовать призывы к покупке.\n" +
            "СТРУКТУРА ВЫХОДА:\n" +
            "Вышел новый проект НАЗВАНИЕ.\n" +
            "Суть проекта и аннотация материала: ТЕКСТ АННОТАЦИИ ОДНИМ СПЛОШНЫМ АБЗАЦЕМ БЕЗ ЗНАЧКОВ.\n" +
            "Ссылка на проект: ССЫЛКА.";

        const cleanDesc = (incomingProduct.description || "")
            .replace(/[*#`]/g, "")
            .replace(/[\-\•]\s+/g, "")
            .replace(/\n+/g, " ")
            .trim();

        const prompt = `Сформируй сухой информационный текст. Проект: "${incomingProduct.title}". Аннотация: ${cleanDesc}. Ссылка: ${targetLinkForPromo}`;

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
            generatedPost = `Вышел новый проект: "${incomingProduct.title}"\n\nСуть проекта и аннотация материала: ${cleanDesc}\n\nОфициальная страница проекта: ${targetLinkForPromo}`;
        }

        const finalHtmlPost = escapeHTML(generatedPost);

        if (process.env.TELEGRAM_CHANNEL_ID) {
            await sendTelegram(process.env.TELEGRAM_CHANNEL_ID, finalHtmlPost);
            await sendTelegram(chatId, `📢 Опубликовано в канале ${process.env.TELEGRAM_CHANNEL_ID}`);
        } else {
            await sendTelegram(chatId, `💡 Текст для канала:\n\n${finalHtmlPost}`);
        }

    } catch (aiError) {
        console.error("Ошибка ИИ:", aiError);
        await sendTelegram(chatId, `⚠️ Продукт сохранён на сайте, но пост в канал не сгенерирован: ${escapeHTML(aiError.message)}`);
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
        throw new Error("Не удалось загрузить data.json с GitHub для удаления.");
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

    const deletedProductTitle = currentContent.products[targetIndex].title;
    currentContent.products.splice(targetIndex, 1);

    const updatedString = JSON.stringify(currentContent, null, 2);
    const updatedBase64 = Buffer.from(updatedString).toString('base64');

    await octokit.repos.createOrUpdateFileContents({
        owner: GH_OWNER,
        repo: GH_REPO,
        path: GH_PATH,
        message: `bot: удален проект "${deletedProductTitle}"`,
        content: updatedBase64,
        sha: sha
    });

    await sendTelegram(chatId, `🗑️ Карточка проекта "${escapeHTML(deletedProductTitle)}" полностью удалена.`);
}
