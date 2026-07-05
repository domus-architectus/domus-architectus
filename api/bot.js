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

// ПАРСЕР RIDERO
async function parseRidero(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Не удалось загрузить страницу Ridero");
    const html = await res.text();

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

// НОВЫЙ ПАРСЕР GUMROAD
async function parseGumroad(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    if (!res.ok) throw new Error("Не удалось загрузить страницу Gumroad");
    const html = await res.text();

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/) || html.match(/<meta name="description" content="([^"]+)"/);
    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

    let title = titleMatch ? titleMatch[1] : "Новый media-проект";
    let description = descMatch ? descMatch[1] : "";
    let cover = imageMatch ? imageMatch[1] : "";

    title = title.replace(" | Gumroad", "").trim();

    return { title, description, cover };
}

// Отправка сообщений в Telegram
async function sendTelegram(chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text: text, parse_mode: "HTML" }; 
    
    if (replyMarkup) {
        body.reply_markup = typeof replyMarkup === "string" ? replyMarkup : JSON.stringify(replyMarkup);
    }

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

            // Если сессия ожидает ссылку Gumroad для Ridero (Шаг 2)
            if (gumroadSessions[chatId] && gumroadSessions[chatId].bookSlug && gumroadSessions[chatId].category && !gumroadSessions[chatId].awaitingGumroad) {
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

            // Прямая ссылка на Gumroad
            if (text.includes("gumroad.com")) {
                const cleanUrl = (text.match(/(https?:\/\/[^\s]+)/)?.[0] || text).split("?")[0].trim();
                gumroadSessions[chatId] = { gumroadUrl: cleanUrl };

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "🎵 Музыка / Аудио", callback_data: "gmr_music" },
                            { text: "🎨 Мерч / Арт", callback_data: "gmr_merch" }
                        ]
                    ]
                };
                
                await sendTelegram(chatId, "Прямая ссылка Gumroad принята. Выберите категорию для размещения:", keyboard);
                return res.status(200).send("ОК");
            }

            // Ссылка на Ridero
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

            await sendTelegram(chatId, "Приветствую, Архитектор. Чтобы добавить проект на сайт, отправьте прямую ссылку на книгу Ridero или товар Gumroad.");
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

            if (data.startsWith("gmr_")) {
                const category = data.replace("gmr_", ""); 
                
                if (!gumroadSessions[chatId] || !gumroadSessions[chatId].gumroadUrl) {
                    throw new Error("Сессия Gumroad не найдена. Отправьте ссылку заново.");
                }

                const fullUrl = gumroadSessions[chatId].gumroadUrl;
                delete gumroadSessions[chatId]; 

                await sendTelegram(chatId, "🔄 Запускаю прямой тактический парсинг Gumroad и сборку карточки...");
                await finalizeProductCreation(chatId, { type: 'gumroad', url: fullUrl, category: category });
                return res.status(200).send("ОК");
            }
        }

    } catch (error) {
        console.error("Ошибка в работе бота:", error);
        if (req.body && (req.body.message || req.body.callback_query)) {
            const chatId = req.body.message ? req.body.message.chat.id : req.body.callback_query.message.chat.id;
            const safeError = error.message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            await sendTelegram(chatId, `🚨 Произошел сбой: ${safeError}`);
        }
    }

    res.status(200).send("ОК");
};

// ЕДИНАЯ ФУНКЦИЯ ЗАПИСИ ДАННЫХ В GITHUB И АНОНСА ЧЕРЕЗ ИИ
async function finalizeProductCreation(chatId, config) {
    let newProduct = {};
    let targetLinkForPromo = ""; 

    if (config.type === 'ridero') {
        const bookUrl = `https://ridero.ru/books/${config.slug}/`;
        const data = await parseRidero(bookUrl);
        newProduct = {
            category: config.category,
            title: data.title,
            description: data.description,
            cover: data.cover,
            links: { ridero: bookUrl }
        };
        if (config.extraGumroad) {
            newProduct.links.gumroad = config.extraGumroad;
        }
        targetLinkForPromo = bookUrl;
    } 
    else if (config.type === 'gumroad') {
        const data = await parseGumroad(config.url);
        newProduct = {
            category: config.category,
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

    // 1. Пушим изменения на GitHub
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
    currentContent.products.unshift(newProduct);

    const updatedString = JSON.stringify(currentContent, null, 2);
    const updatedBase64 = Buffer.from(updatedString).toString('base64');

    await octokit.repos.createOrUpdateFileContents({
        owner: GH_OWNER,
        repo: GH_REPO,
        path: GH_PATH,
        message: `Автокоммит: добавлен проект через бота "${newProduct.title}"`,
        content: updatedBase64,
        sha: sha
    });

    await sendTelegram(chatId, `✅ Успех! Проект "${newProduct.title}" на витрине сайта.\n\n🔄 Перехожу к фазе ИИ: генерация промо-поста для канала...`);

    // 2. БЛОК ИИ: ОЧИСТКА АННОТАЦИИ И ИНФОРМИРОВАНИЕ
    try {
        const systemInstruction = 
            "Ты — информационный ассистент. Твоя единственная задача — выдать строгое новостное сообщение о выходе новой книги. " +
            "Стиль — сухой, деловой, спартанский, без воды, без рекламы, без маркетинговых призывов. " +
            "СТРУКТУРА СООБЩЕНИЯ: " +
            "Строка 1: Сообщить о публикации новой книги, указав её название. " +
            "Строка 2: Написать фразу 'Суть проекта и аннотация материала:' и далее разместить текст предоставленной аннотации. " +
            "Строка 3: Ссылка на проект. " +
            "КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО: " +
            "1. Использовать любые эмодзи, капслок, звездочки разметки '**', списки, дефисы. Текст должен идти сплошными абзацами. " +
            "2. Использовать юридически опасные термины (фамилии авторов, термин 'octave'). " +
            "3. Задавать вопросы читателю ('Устали от...', 'Хотите узнать...'). " +
            "4. Писать рекламные призывы ('успей купить', 'заказывайте прямо сейчас').";

        const cleanDesc = newProduct.description.replace(/\*/g, "").replace(/[\-\•]\s+/g, "").replace(/\n+/g, " ").trim();
        const prompt = `Сформируй информационный пост. Книга: "${newProduct.title}". Аннотация: ${cleanDesc}. Ссылка: ${targetLinkForPromo}`;

        const aiResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            systemInstruction: systemInstruction,
            temperature: 0.1 // Минимальная температура для исключения отсебятины
        });

        let generatedPost = aiResponse.text
            .replace(/\*\*/g, "")
            .replace(/\*/g, "")
            .replace(/#/g, "")
            .replace(/`/g, "")
            .replace(/[🚀💡📖✨📚👉📢⚠️🚨✅]/g, "") // Вырезаем эмодзи на корню
            .trim();

        // Дополнительная строка со ссылкой, если модель забыла вставить
        if (!generatedPost.includes(targetLinkForPromo)) {
            generatedPost += `\n\nОфициальная страница проекта: ${targetLinkForPromo}`;
        }

        // 3. ЗАЛП В ТГ-КАНАЛ
        if (process.env.TELEGRAM_CHANNEL_ID) {
            await sendTelegram(process.env.TELEGRAM_CHANNEL_ID, generatedPost);
            await sendTelegram(chatId, `📢 Системное уведомление: Информационный пост отправлен в канал ${process.env.TELEGRAM_CHANNEL_ID}`);
        } else {
            await sendTelegram(chatId, `💡 Канал не настроен, вот пост для ручного размещения:\n\n${generatedPost}`);
        }

    } catch (aiError) {
        console.error("Ошибка ИИ или отправки в канал:", aiError);
        const safeAiError = aiError.message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await sendTelegram(chatId, `⚠️ Продукт на сайте, но произошел сбой ИИ-модуля при публикации в канал: ${safeAiError}`);
    }
}
