const { Octokit } = require("@octokit/rest");
const fetch = require("node-fetch");

// Конфигурация GitHub (замени на свои данные)
const GH_OWNER = "domus-architectus"; // Например: "arhantic"
const GH_REPO = "domus-architectus";  // Например: "domus-hub"
const GH_PATH = "data.json";

// Инициализация клиента GitHub
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Простой серверный парсер Ridero
async function parseRidero(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Не удалось загрузить страницу Ridero");
    const html = await res.text();

    // Быстрый поиск мета-тегов через регулярные выражения (работает без тяжелых библиотек парсинга)
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

    let title = titleMatch ? titleMatch[1] : "Новая книга";
    let description = descMatch ? descMatch[1] : "";
    let cover = imageMatch ? imageMatch[1] : "";

    if (cover && cover.startsWith("//")) cover = "https:" + cover;

    // Декодирование HTML-сущностей, если они есть
    title = title.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    description = description.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

    return { title, description, cover };
}

// Отправка сообщений в Telegram
async function sendTelegram(chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text: text };
    if (replyMarkup) body.reply_markup = replyMarkup;

    await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
}

// Хранилище сессий в памяти (для Serverless это временное решение, но для шага "ссылка -> категория" работает отлично)
// Если бот «забудет» ссылку из-за перезапуска инстанса Vercel, он просто попросит прислать её заново.
let tempSessions = {};

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        return res.status(200).send("ОК. Только POST запросы.");
    }

    try {
        const update = req.body;
        
        // 1. Обработка текстовых сообщений (прием ссылки)
        if (update.message && update.message.text) {
            const chatId = update.message.chat_id || update.message.chat.id;
            const text = update.message.text.trim();

            if (text.startsWith("https://ridero.ru/")) {
                tempSessions[chatId] = { url: text };
                
                // Выводим инлайн-кнопки выбора категории
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "📘 Прикладное руководство", callback_data: "cat_applied" },
                            { text: "📕 Художественная", callback_data: "cat_fiction" }
                        ],
                        [
                            { text: "🎵 Музыка / Аудио", callback_data: "cat_music" },
                            { text: "🎨 Мерч / Арт", callback_data: "cat_merch" }
                        ]
                    ]
                };
                
                await sendTelegram(chatId, "Ссылка принята. Выберите категорию для размещения на сайте:", keyboard);
            } else {
                await sendTelegram(chatId, "Приветствую, Архитектор. Чтобы добавить проект на сайт, отправьте прямую ссылку на книгу Ridero.");
            }
        }

        // 2. Обработка нажатий на инлайн-кнопки
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;

            if (data.startsWith("cat_") && tempSessions[chatId]) {
                const category = data.replace("cat_", "");
                const bookUrl = tempSessions[chatId].url;
                
                await sendTelegram(chatId, "🔄 Запускаю штурм Ridero, извлекаю метаданные...");

                // Парсим книгу
                const bookData = await parseRidero(bookUrl);
                
                // Формируем новый объект карточки
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

                // Скачиваем текущий data.json из GitHub
                let currentContent = { products: [] };
                let sha = null;

                try {
                    const ghRes = await octokit.repos.getContent({
                        owner: GH_OWNER,
                        repo: GH_REPO,
                        path: GH_PATH
                    });
                    
                    sha = ghRes.data.sha;
                    const base64Content = ghRes.data.content;
                    const stringContent = Buffer.from(base64Content, 'base64').toString('utf-8');
                    currentContent = JSON.parse(stringContent);
                } catch (e) {
                    console.log("data.json не найден или пуст, создаю новый.");
                }

                // Добавляем новую карточку на самый верх списка
                if (!currentContent.products) currentContent.products = [];
                currentContent.products.unshift(newProduct);

                // Превращаем обратно в строку и коммитим в GitHub
                const updatedString = JSON.stringify(currentContent, null, 2);
                const updatedBase64 = Buffer.from(updatedString).toString('base64');

                await octokit.repos.createOrUpdateFileContents({
                    owner: GH_OWNER,
                    repo: GH_REPO,
                    path: GH_PATH,
                    message: `Автоматическое добавление книги: ${bookData.title}`,
                    content: updatedBase64,
                    sha: sha
                });

                await sendTelegram(chatId, `✅ Успех! Карточка "${bookData.title}" добавлена на сайт в категорию [${category}]. Vercel пересобирает витрину.`);
                
                // Очищаем сессию
                delete tempSessions[chatId];
            } else if (!tempSessions[chatId]) {
                await sendTelegram(chatId, "❌ Ошибка сессии. Пожалуйста, отправьте ссылку на книгу заново.");
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