const fetch = require("node-fetch");

module.exports = async (req, res) => {
    // 1. Выводим входящие данные в логи Vercel для диагностики
    console.log("INCOMING UPDATE:", JSON.stringify(req.body));

    if (req.method !== 'POST') {
        return res.status(200).json({ status: "DOMUS ARCHITECTUS BOT OPERATIONAL" });
    }

    try {
        const update = req.body;
        const token = process.env.TELEGRAM_TOKEN;

        if (!token) {
            console.error("ОШИБКА: TELEGRAM_TOKEN отсутствует в Environment Variables");
            return res.status(200).json({ error: "Missing TELEGRAM_TOKEN" });
        }

        // Извлекаем ID чата и текст сообщения
        const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
        const incomingText = update?.message?.text || update?.callback_query?.data;

        if (chatId) {
            // КРИТИЧЕСКИ ВАЖНО: await перед fetch!
            // Без await Vercel завершит процесс за 6ms и не отправит запрос в Telegram
            const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `// DOMUS ARCHITECTUS SYSTEM RESPONSE\n\nПринят запрос: "${incomingText || 'Действие'}"\nСистема функционирует штатно.`
                })
            });

            const resData = await response.json();
            console.log("TELEGRAM API RESPONSE:", JSON.stringify(resData));
        } else {
            console.log("chatId не найден в объекте update");
        }

        return res.status(200).json({ status: "ok" });

    } catch (error) {
        console.error("RUNTIME ERROR:", error.stack || error);
        return res.status(200).json({ error: error.message });
    }
};
