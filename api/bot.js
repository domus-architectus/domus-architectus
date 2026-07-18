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
        .replace(/>/g, "&gt;");
}

// Нормализация названий для точного сравнения без учета регистра и спецсимволов
function normalizeTitle(title) {
    if (!title) return "";
    return title.toLowerCase()
        .replace(/[^a-zа-яё0-9]/g, "")
        .replace(/ё/g, "е")
        .trim();
}

// ПАРСЕР RIDERO с жестким декодированием буфера
async function parseRidero(url) {
    const res = await fetch(url);
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
}

// ПАРСЕР GUMROAD с жестким декодированием буфера
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

    return { title, description, cover };
}

// Отправка сообщений в Telegram с жесткой нормализацией UTF-8
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

// Временное хранилище сессий
let gumroadSessions = {};

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

            // ХЕНДЛЕР УДАЛЕНИЯ КАРТОЧКИ ПО ССЫЛКЕ
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

            // Сценарий 1: Пользователь прислал Gumroad-ссылку в ответ на запрос к книге Ridero
            if (gumroadSessions[chatId] && gumroadSessions[chatId].bookSlug && gumroadSessions[chatId].category && gumroadSessions[chatId].awaitingGumroad) {
                const session = gumroadSessions[chatId];
                let gumroadUrl = null;

                if (text.includes("gumroad.com")) {
                    gumroadUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0]?.split("?")[0] || text;
                }

                await sendTelegram(chatId, "🔄 Запускаю штурм Ridero и сборку карточки книги...");
                await finalizeProductCreation(chatId, { type: 'ridero', slug: session.bookSlug, category: session.category, extraGumroad: gumroadUrl });
                
                delete gumroadSessions[chatId];
                return res.status(200).send("ОК");
            }

            // Сценарий 1.5: Дозаливка (связывание) Gumroad-ссылки с конкретной Ridero книгой
            if (gumroadSessions[chatId] && gumroadSessions[chatId].gumroadUrl && gumroadSessions[chatId].awaitingRideroBinding) {
                if (text.includes("ridero.ru")) {
                    const cleanRideroUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0]?.split("?")[0] || text;
                    const urlParts = cleanRideroUrl.replace(/\/$/, "").split("/");
                    const bookSlug = urlParts[urlParts.length - 1];
                    const fullUrl = gumroadSessions[chatId].gumroadUrl;

                    await sendTelegram(chatId, "🔄 Найдена связующая ссылка Ridero. Начинаю процедуру интеграции в существующую карточку...");
                    await finalizeProductCreation(chatId, { type: 'gumroad_bind', url: fullUrl, rideroSlug: bookSlug });
                    
                    delete gumroadSessions[chatId];
                    return res.status(200).send("ОК");
                } else {
                    await sendTelegram(chatId, "⚠️ Отправьте корректную ссылку на Ridero для связывания, либо отправьте Gumroad заново для выбора другой категории.");
                    return res.status(200).send("ОК");
                }
            }

            // УМНЫЙ ТЕКСТОВЫЙ ПЕРЕХВАТЧИК (Для обхода кнопок при вводе вроде: "музыка [ссылка]")
            if (text.includes("gumroad.com") && (lowerText.includes("музыка") || lowerText.includes("аудио") || lowerText.includes("мерч") || lowerText.includes("арт"))) {
                const cleanUrl = (text.match(/(https?:\/\/[^\s]+)/)?.[0] || text).split("?")[0].trim();
                const targetCategory = (lowerText.includes("музыка") || lowerText.includes("аудио")) ? "music" : "merch";

                await sendTelegram(chatId, `⚡ Обнаружен текстовый маркер. Запускаю парсинг Gumroad для категории: ${targetCategory}...`);
                await finalizeProductCreation(chatId, { type: 'gumroad', url: cleanUrl, category: targetCategory });
                if (gumroadSessions[chatId]) delete gumroadSessions[chatId];
                return res.status(200).send("ОК");
            }

            // Сценарий 2: Первичная прямая ссылка Gumroad (Мерч, Музыка или Дозаливка книги)
            if (text.includes("gumroad.com")) {
                const cleanUrl = (text.match(/(https?:\/\/[^\s]+)/)?.[0] || text).split("?")[0].trim();
                gumroadSessions[chatId] = { gumroadUrl: cleanUrl };

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "🎵 Музыка / Аудио", callback_data: "gmr_music" },
                            { text: "🎨 Мерч / Арт", callback_data: "gmr_merch" },
                            { text: "📘 Вписать в книгу Ridero", callback_data: "gmr_book" }
                        ]
                    ]
                };
                
                await sendTelegram(chatId, "Прямая ссылка Gumroad принята. Выберите тип контента или привязку к книге:", keyboard);
                return res.status(200).send("ОК");
            }

            // Сценарий 3: Ссылка Ridero (всегда книга)
            if (text.includes("ridero.ru")) {
                const cleanUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                const urlParts = cleanUrl.split("?")[0].replace(/\/$/, "").split("/");
                const bookSlug = urlParts[urlParts.length - 1];

                gumroadSessions[chatId] = { bookSlug: bookSlug };

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

            await sendTelegram(chatId, "Приветствую, Архитектор. Чтобы добавить проект на сайт или привязать ссылки, отправьте прямую ссылку на книгу Ridero или товар Gumroad. Для удаления карточки введите: `удалить [ссылка]`.");
        }

        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;

            if (data === "rid_applied" || data === "rid_fiction") {
                if (!gumroadSessions[chatId] || !gumroadSessions[chatId].bookSlug) {
                    throw new Error("Сессия Ridero не найдена. Отправьте ссылку заново.");
                }

                const category = data.replace("rid_", "");
                gumroadSessions[chatId].category = category;
                gumroadSessions[chatId].awaitingGumroad = true; 

                const keyboard = {
                    inline_keyboard: [
                        [{ text: "⏩ Пропустить Gumroad", callback_data: "skip_gumroad" }]
                    ]
                };

                await sendTelegram(chatId, "Категория выбрана. Теперь отправьте ссылку на этот товар в Gumroad (или нажмите Пропустить):", keyboard);
                return res.status(200).send("ОК");
            }
            
            if (data === "skip_gumroad") {
                if (!gumroadSessions[chatId] || !gumroadSessions[chatId].bookSlug || !gumroadSessions[chatId].category) {
                    throw new Error("Недостаточно данных в сессии для сборки.");
                }

                const { bookSlug, category } = gumroadSessions[chatId];
                delete gumroadSessions[chatId]; 

                await sendTelegram(chatId, "🔄 Пропускаем Gumroad. Запускаю сборку книги...");
                await finalizeProductCreation(chatId, { type: 'ridero', slug: bookSlug, category: category, extraGumroad: null });
                return res.status(200).send("ОК");
            }

            // Нажата кнопка привязать к книге Ridero
            if (data === "gmr_book") {
                if (!gumroadSessions[chatId] || !gumroadSessions[chatId].gumroadUrl) {
                    throw new Error("Сессия Gumroad не найдена.");
                }
                gumroadSessions[chatId].awaitingRideroBinding = true;
                await sendTelegram(chatId, "🔗 Отлично. Теперь отправьте боту ссылку Ridero на книгу, в которую нужно вписать эту ссылку Gumroad:");
                return res.status(200).send("ОК");
            }

            // Обработка музыки и мерча
            if (data.startsWith("gmr_")) {
                const category = data.replace("gmr_", ""); 
                
                if (!gumroadSessions[chatId] || !gumroadSessions[chatId].gumroadUrl) {
                    throw new Error("Сессия Gumroad не найдена. Отправьте ссылку заново.");
                }

                const fullUrl = gumroadSessions[chatId].gumroadUrl;
                delete gumroadSessions[chatId]; 

                await sendTelegram(chatId, `🔄 Запускаю тактический парсинг Gumroad для категории: ${category}...`);
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

// ЕДИНАЯ ФУНКЦИЯ ЗАПИСИ И НАСТРОЙКИ UPSERT-ЛОГИКИ
async function finalizeProductCreation(chatId, config) {
    let incomingProduct = {};
    let targetLinkForPromo = ""; 
    let bindingRideroSlug = config.rideroSlug || null;

    // Парсим входящие данные в зависимости от источника
    if (config.type === 'ridero') {
        const bookUrl = `https://ridero.ru/books/${config.slug}/`;
        const data = await parseRidero(bookUrl);
        incomingProduct = {
            category: config.category,
            title: data.title,
            description: data.description,
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
            category: config.category || "applied", 
            title: data.title,
            description: data.description,
            cover: data.cover,
            links: { 
                ridero: "", 
                gumroad: config.url 
            }
        };
        targetLinkForPromo = config.url;
    }

    // 1. Выгрузка текущей базы данных с GitHub
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

    // ТОЧНАЯ СШИВКА С КНИГОЙ (По прямому указанию слаге Ridero)
    if (config.type === 'gumroad_bind' && bindingRideroSlug) {
        const targetRideroSegment = `/books/${bindingRideroSlug}`.toLowerCase();
        existingProductIndex = currentContent.products.findIndex(p => 
            p.links && p.links.ridero && p.links.ridero.toLowerCase().includes(targetRideroSegment)
        );
    } else {
        // Стандартный поиск дубликата по нормализованному названию (для Ridero, Музыки и Мерча)
        const targetNormTitle = normalizeTitle(incomingProduct.title);
        existingProductIndex = currentContent.products.findIndex(p => normalizeTitle(p.title) === targetNormTitle);
    }

    if (existingProductIndex !== -1) {
        // Карточка найдена! Выполняем точечный PATCH ссылки
        let existingProduct = currentContent.products[existingProductIndex];
        
        if (!existingProduct.links) existingProduct.links = { ridero: "", gumroad: "" };
        
        // Вшиваем ссылку Gumroad, ничего лишнего не затирая
        if (incomingProduct.links.gumroad) {
            existingProduct.links.gumroad = incomingProduct.links.gumroad;
        }
        
        // Если привязывали из режима дозаливки, сохраняем исходную категорию книги
        incomingProduct = existingProduct; 
        currentContent.products[existingProductIndex] = existingProduct;
        isUpdated = true;
    } else {
        // Если карточки нет в базе (и это не был режим принудительной связки) — добавляем
        if (config.type === 'gumroad_bind') {
            throw new Error(`Книга со слагом "${bindingRideroSlug}" не найдена в базе сайта. Сначала добавьте её через ссылку Ridero.`);
        }
        currentContent.products.unshift(incomingProduct);
    }

    // Сохранение обновленной базы на GitHub
    const updatedString = JSON.stringify(currentContent, null, 2);
    const updatedBase64 = Buffer.from(updatedString).toString('base64');

    const commitMessage = isUpdated 
        ? `Автокоммит: обновлены ссылки для "${incomingProduct.title}"`
        : `Автокоммит: добавлен проект "${incomingProduct.title}"`;

    await octokit.repos.createOrUpdateFileContents({
        owner: GH_OWNER,
        repo: GH_REPO,
        path: GH_PATH,
        message: commitMessage,
        content: updatedBase64,
        sha: sha
    });

    const statusMessage = isUpdated
        ? `✅ Успешно вписано! Ссылка Gumroad привязана внутрь карточки книги "${escapeHTML(incomingProduct.title)}".`
        : `✅ Успех! Новый проект "${escapeHTML(incomingProduct.title)}" добавлен на витрину сайта.`;

    await sendTelegram(chatId, `${statusMessage}\n\n🔄 Перехожу к фазе ИИ: генерация промо-поста...`);

    // 2. БЛОК ИИ: ГЕНЕРАЦИЯ ИНФОРМАЦИОННОГО ПОСТА
    try {
        const systemInstruction = 
            "Ты — строгий информационный робот-автомат. Твоя единственная задача — переписать аннотацию в виде сухого новостного сообщения.\n" +
            "Категорически запрещено: общаться с пользователем, писать вводные фразы вроде 'Вот ваш пост', использовать списки, дефисы, любые эмодзи, капслок, восклицательные знаки и вопросы.\n" +
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

        if (!generatedPost || generatedPost.includes("Отличный выбор") || generatedPost.includes("вариант информационного поста")) {
            generatedPost = `Вышел новый проект: "${incomingProduct.title}"\n\nСуть проекта и аннотация материала: ${cleanDesc}\n\nОфициальная страница проекта: ${targetLinkForPromo}`;
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

        // 3. ЗАЛП В ТГ-КАНАЛ
        if (process.env.TELEGRAM_CHANNEL_ID) {
            await sendTelegram(process.env.TELEGRAM_CHANNEL_ID, finalHtmlPost);
            await sendTelegram(chatId, `📢 Системное уведомление: Информационный пост отправлен в канал ${process.env.TELEGRAM_CHANNEL_ID}`);
        } else {
            await sendTelegram(chatId, `💡 Канал не настроен, вот пост для ручного размещения:\n\n${finalHtmlPost}`);
        }

    } catch (aiError) {
        console.error("Ошибка ИИ или отправки в канал:", aiError);
        const safeAiError = escapeHTML(aiError.message);
        await sendTelegram(chatId, `⚠️ Продукт обработан, но произошел сбой ИИ-модуля при публикации: ${safeAiError}`);
    }
}

// ФУНКЦИЯ УДАЛЕНИЯ КАРТОЧКИ ИЗ БАЗЫ НА GITHUB
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
        throw new Error("Не удалось загрузить базу данных data.json с GitHub для удаления.");
    }

    if (!currentContent.products || currentContent.products.length === 0) {
        await sendTelegram(chatId, "⚠️ База данных пуста. Удалять нечего.");
        return;
    }

    const normalizedTargetUrl = targetUrl.toLowerCase().replace(/\/$/, "");

    // Поиск по любому совпадению в ссылках
    const targetIndex = currentContent.products.findIndex(p => {
        const rideroLink = p.links && p.links.ridero ? p.links.ridero.toLowerCase().replace(/\/$/, "") : "";
        const gumroadLink = p.links && p.links.gumroad ? p.links.gumroad.toLowerCase().replace(/\/$/, "") : "";
        
        return rideroLink === normalizedTargetUrl || gumroadLink === normalizedTargetUrl;
    });

    if (targetIndex === -1) {
        await sendTelegram(chatId, `❌ Карточка с такой ссылкой не найдена на витрине сайта. Проверьте корректность URL.`);
        return;
    }

    const deletedProductTitle = currentContent.products[targetIndex].title;

    // Вырезаем элемент
    currentContent.products.splice(targetIndex, 1);

    const updatedString = JSON.stringify(currentContent, null, 2);
    const updatedBase64 = Buffer.from(updatedString).toString('base64');

    await octokit.repos.createOrUpdateFileContents({
        owner: GH_OWNER,
        repo: GH_REPO,
        path: GH_PATH,
        message: `Автокоммит: удален проект через бота "${deletedProductTitle}"`,
        content: updatedBase64,
        sha: sha
    });

    await sendTelegram(chatId, `🗑️ Операция завершена. Карточка проекта "${escapeHTML(deletedProductTitle)}" полностью удалена с витрины сайта.`);
}
