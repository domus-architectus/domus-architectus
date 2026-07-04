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

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        return res.status(200).send("ОК. Только POST запросы.");
    }

    try {
        const update = req.body;
        
        // 1. Приём ссылки
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text.includes("ridero.ru")) {
                const cleanUrl = text.match(/(https?:\/\/[^\s]+)/)?.[0] || text;
                
                // Выделяем название книги из ссылки (например, "drevnyaya_sila_blagodarnosti")
                const urlParts = cleanUrl.replace(/\/$/, "").split("/");
                const bookSlug = urlParts[urlParts.length - 1];

                // Зашиваем слаг книги прямо в callback_data кнопок через разделитель "|"
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

        // 2. Обработка нажатий инлайн-кнопок
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;

            if (data.startsWith("cat_")) {
                // Разбираем категорию и слаг книги из нажатой кнопки
                const [catData, bookSlug] = data.split("|");
                const category = catData.replace("cat_", "");
                const bookUrl = `https://ridero.ru/books/${bookSlug}/`;
                
                await sendTelegram(chatId, "🔄 Запускаю штурм Ridero, извлекаю метаданные...");

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

                await sendTelegram(chatId, `Парсинг завершен: "${bookData.title}". Обновляю базу данных на GitHub...`);

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
                    message: `Автокоммит: добавлена книга "${bookData.title}"`,
                    content: updatedBase64,
                    sha: sha
                });

                await sendTelegram(chatId, `✅ Успех! Карточка "${bookData.title}" добавлена на сайт в категорию [${category}]. Vercel пересобирает витрину.`);
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
