const { GoogleGenAI } = require("@google/genai");
const { Octokit } = require("@octokit/rest");

module.exports = async (req, res) => {
    // 1. Проверка метода запроса
    if (req.method !== 'POST') {
        return res.status(200).json({ status: "DOMUS ARCHITECTUS BOT API OPERATIONAL" });
    }

    try {
        // 2. Безопасное чтение ключей из окружения
        const tgToken = process.env.TELEGRAM_TOKEN;
        const ghToken = process.env.GITHUB_TOKEN;
        const geminiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;

        if (!tgToken) {
            console.error("CRITICAL: TELEGRAM_TOKEN отсутствует в Environment Variables");
            return res.status(200).json({ error: "Missing TELEGRAM_TOKEN" });
        }

        // 3. Инициализация клиентов внутри запроса (изоляция ошибок)
        const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : null;
        const octokit = ghToken ? new Octokit({ auth: ghToken }) : null;

        const update = req.body;
        if (!update || (!update.message && !update.callback_query)) {
            return res.status(200).json({ status: "No update message" });
        }

        // --- ЛОГИКА ОБРАБОТКИ КОМАНД И СООБЩЕНИЙ ---
        // (Ваш основной код обработки update.message / update.callback_query)

        // Всегда возвращаем 200 OK для Telegram
        return res.status(200).json({ status: "ok" });

    } catch (error) {
        // Перехватываем ошибки исполнения, чтобы Telegram не зацикливал отправку
        console.error("RUNTIME ERROR IN BOT HANDLER:", error.stack || error);
        return res.status(200).json({ error: error.message });
    }
};
