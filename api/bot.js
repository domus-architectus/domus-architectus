const { Octokit } = require("@octokit/rest");
const fetch = require("node-fetch");

// Конфигурация GitHub
const GH_OWNER = "domus-architectus"; 
const GH_REPO = "domus-architectus";  
const GH_PATH = "data.json";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

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

// НОВЫЙ ПАРСЕР GUMROAD (работает на регулярках, без внешних библиотек)
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

    let title = titleMatch ? titleMatch[1] : "Новый медиа-проект";
    let description = descMatch ? descMatch[1] : "";
    let cover = imageMatch ? imageMatch[1] : "";

    // Чистим мусор в тайтле, если прилетел хвост от площадки
    title = title.replace(" | Gumroad", "").trim();

    return { title, description, cover };
}

// Отправка сообщений в Telegram
async function sendTelegram(chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text: text };
    
    if (replyMarkup) {
        body.reply_markup = JSON.stringify(replyMarkup);
    }

    await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
}

// Временное хранилище сессий для связки Ridero + Gumroad
let gumroadSessions = {};

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        return res.status(200).send("ОК. Только POST запросы.");
    }

    try {
        const update = req.body;
        
        // ОБРАБОТКА ССЫЛОК И ТЕКСТА
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            // Проверка: Ждем ли мы ссылку на Gumroad как доп. шаг для книги Ridero?
            if (gumroadSessions[chatId]) {
                const session = gumroadSessions[chatId];
                let gumroadUrl = null;

                if (text.includes("gumroad.com")) {
                    gumroadUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                }

                await sendTelegram(chatId, "🔄 Запускаю штурм Ridero и сборку карточки книги...");
                await finalizeProductCreation(chatId, { type: 'ridero', slug: session.bookSlug, category: session.category, extraGumroad: gumroadUrl });
                
                delete gumroadSessions[chatId];
                return res.status(200).send("ОК");
            }

            // ПЕРЕХВАТ ПРЯМОЙ ССЫЛКИ GUMROAD (Музыка или Мерч напрямую)
            if (text.includes("gumroad.com")) {
                const cleanUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                
                // Передаем слаг/ссылку через callback_data (ограничение TG — 64 символа, поэтому кодируем платформу)
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "🎵 Музыка / Аудио", callback_data: `gmr_music|${cleanUrl}` },
                            { text: "🎨 Мерч / Арт", callback_data: `gmr_merch|${cleanUrl}` }
                        ]
                    ]
                };
                
                await sendTelegram(chatId, "Прямая ссылка Gumroad принята. Выберите категорию для размещения:", keyboard);
                return res.status(200).send("ОК");
            }

            // ПЕРЕХВАТ ССЫЛКИ RIDERO
            if (text.includes("ridero.ru")) {
                const cleanUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                const urlParts = cleanUrl.replace(/\/$/, "").split("/");
                const bookSlug = urlParts[urlParts.length - 1];

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "📘 Прикладное руководство", callback_data: `rid_applied|${bookSlug}` },
                            { text: "📕 Художественная", callback_data: `rid_fiction|${bookSlug}` }
                        ]
                    ]
                };
                
                await sendTelegram(chatId, "Ссылка Ridero принята. Выберите категорию:", keyboard);
                return res.status(200).send("ОК");
            }

            // Стандартный ответ
            await sendTelegram(chatId, "Приветствую, Архитектор. Чтобы добавить проект на сайт, отправьте прямую ссылку на книгу Ridero или товар Gumroad (для музыки/мерча).");
        }

        // ОБРАБОТКА НАЖАТИЙ КНОПОК (ИНЛАЙН)
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;

            // Логика кнопки Ridero (Запрашиваем Gumroad вторым шагом)
            if (data.startsWith("rid_")) {
                const [catData, bookSlug] = data.split("|");
                const category = catData.replace("rid_", "");

                gumroadSessions[chatId] = { bookSlug, category };

                const keyboard = {
                    inline_keyboard: [
                        [{ text: "⏩ Пропустить Gumroad", callback_data: `skip_gum|${category}|${bookSlug}` }]
                    ]
                };

                await sendTelegram(chatId, "Категория выбрана. Теперь отправьте ссылку на этот товар в Gumroad (или нажмите Пропустить):", keyboard);
            }
            
            // Логика кнопки Ridero: Пропуск Gumroad
            if (data.startsWith("skip_gum|")) {
                const [, category, bookSlug] = data.split("|");
                await sendTelegram(chatId, "🔄 Пропускаем Gumroad. Запускаю сборку книги...");
                await finalizeProductCreation(chatId, { type: 'ridero', slug: bookSlug, category: category, extraGumroad: null });
                delete gumroadSessions[chatId];
            }

            // Логика прямой кнопки Gumroad (Сразу публикация музыки или мерча)
            if (data.startsWith("gmr_")) {
                const [catData, fullUrl] = data.split("|");
                const category = catData.replace("gmr_", "");

                await sendTelegram(chatId, "🔄 Запускаю прямой тактический парсинг Gumroad и сборку карточки...");
                await finalizeProductCreation(chatId, { type: 'gumroad', url: fullUrl, category: category });
            }
        }

    } catch (error) {
        console.error("Ошибка в работе бота:", error);
        if (req.body && (req.body.message || req.body.callback_query)) {
            const chatId = req.body.message ? req.body.message.chat.id : req.body.callback_query.message.chat.id;
            await sendTelegram(chatId, `🚨 Произошел сбой: ${error.message}`);
        }
    }

    res.status(200).send("ОК");
};

// ЕДИНАЯ ФУНКЦИЯ ЗАПИСИ ДАННЫХ В GITHUB
async function finalizeProductCreation(chatId, config) {
    let newProduct = {};

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
    } 
    else if (config.type === 'gumroad') {
        const data = await parseGumroad(config.url);
        newProduct = {
            category: config.category,
            title: data.title,
            description: data.description,
            cover: data.cover,
            links: { 
                ridero: "", // Пусто, чтобы фронтенд скрыл кнопку Ridero
                gumroad: config.url 
            }
        };
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

    await sendTelegram(chatId, `✅ Успех! Проект "${newProduct.title}" успешно выведен на витрину сайта в категорию [${config.category}].`);
}
