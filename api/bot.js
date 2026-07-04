const { Octokit } = require("@octokit/rest");
const fetch = require("node-fetch");

// Конфигурация GitHub
const GH_OWNER = "domus-architectus"; 
const GH_REPO = "domus-architectus";  
const GH_PATH = "data.json";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Парсер Ridero
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

// Временное хранилище для шага Gumroad (только для текстового ожидания)
let gumroadSessions = {};

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        return res.status(200).send("ОК. Только POST запросы.");
    }

    try {
        const update = req.body;
        
        // ШАГ 1: Прием ссылки на Ridero
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            // Проверяем, не ждем ли мы сейчас ссылку на Gumroad от этого пользователя
            if (gumroadSessions[chatId]) {
                const session = gumroadSessions[chatId];
                let gumroadUrl = null;

                if (text.includes("gumroad.com")) {
                    gumroadUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                }

                await sendTelegram(chatId, "🔄 Запускаю штурм Ridero и сборку карточки...");
                
                // Вызываем финальную сборку публикации
                await finalizeProductCreation(chatId, session.bookSlug, session.category, gumroadUrl);
                
                delete gumroadSessions[chatId];
                return res.status(200).send("ОК");
            }

            // Стандартный перехват ссылки Ridero
            if (text.includes("ridero.ru")) {
                const cleanUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                const urlParts = cleanUrl.replace(/\/$/, "").split("/");
                const bookSlug = urlParts[urlParts.length - 1];

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "📘 Прикладное руководство", callback_data: `cat_applied|${bookSlug}` },
                            { text: "📕 Художественная", callback_data: `cat_fiction|${bookSlug}` }
                        ],
                        [
                            { text: "🎵 Музыка / Аудио", callback_data: `cat_music|${bookSlug}` },
                            { text: "🎨 Мерч / Арт", callback_data: `cat_merch|${bookSlug}` }
                        ]
                    ]
                };
                
                await sendTelegram(chatId, "Ссылка принята. Выберите категорию для размещения на сайте:", keyboard);
            } else {
                await sendTelegram(chatId, "Приветствую, Архитектор. Чтобы добавить проект на сайт, отправьте прямую ссылку на книгу Ridero.");
            }
        }

        // ШАГ 2: Обработка выбора категории и запрос ссылки на Gumroad
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;

            if (data.startsWith("cat_")) {
                const [catData, bookSlug] = data.split("|");
                const category = catData.replace("cat_", "");

                // Переводим пользователя в режим ожидания ссылки Gumroad
                gumroadSessions[chatId] = { bookSlug, category };

                const keyboard = {
                    inline_keyboard: [
                        [{ text: "⏩ Пропустить Gumroad", callback_data: `skip_gum|${category}|${bookSlug}` }]
                    ]
                };

                await sendTelegram(chatId, "Категория выбрана. Теперь отправьте ссылку на этот товар в Gumroad.\n\nЕсли международная продажа не планируется, нажмите кнопку ниже:", keyboard);
            }
            
            // ШАГ 3: Если пользователь решил пропустить Gumroad
            if (data.startsWith("skip_gum|")) {
                const [, category, bookSlug] = data.split("|");
                
                await sendTelegram(chatId, "🔄 Понял. Пропускаем Gumroad. Запускаю сборку карточки...");
                await finalizeProductCreation(chatId, bookSlug, category, null);
                
                delete gumroadSessions[chatId];
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

// Функция фиксации данных и отправки коммита в GitHub
async function finalizeProductCreation(chatId, bookSlug, category, gumroadUrl) {
    const bookUrl = `https://ridero.ru/books/${bookSlug}/`;
    const bookData = await parseRidero(bookUrl);
    
    const newProduct = {
        category: category,
        title: bookData.title,
        description: bookData.description,
        cover: bookData.cover,
        links: {
            ridero: bookUrl
        }
    };

    // Если ссылка на Gumroad передана — добавляем её в структуру данных
    if (gumroadUrl) {
        newProduct.links.gumroad = gumroadUrl;
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
        console.log("Файл data.json не найден, создаём структуру с нуля.");
    }

    if (!currentContent.products) currentContent.products = [];
    currentContent.products.unshift(newProduct);

    const updatedString = JSON.stringify(currentContent, null, 2);
    const updatedBase64 = Buffer.from(updatedString).toString('base64');

    await octokit.repos.createOrUpdateFileContents({
        owner: GH_OWNER,
        repo: GH_REPO,
        path: GH_PATH,
        message: `Автокоммит: добавлен проект "${bookData.title}"`,
        content: updatedBase64,
        sha: sha
    });

    let successMessage = `✅ Успех! Карточка "${bookData.title}" добавлена на сайт в категорию [${category}].`;
    if (gumroadUrl) {
        successMessage += `\n🔗 Интеграция с Gumroad активна.`;
    }
    
    await sendTelegram(chatId, successMessage);
}
