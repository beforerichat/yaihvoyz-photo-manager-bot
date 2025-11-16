import { config } from 'dotenv';
import { Telegraf } from 'telegraf';
import { createClient } from 'redis';
import logger from './logger.js';

config();


const NEG = ['👎', '💩', '🤮', '😢', '😱', '🤬'];
const POS = ['👍', '❤', '🔥', '😁', '✨', '👌', '🤗', '🥰'];

const SELECTED_CHAT_ID = process.env.SELECTED_CHAT_ID;
const DELETED_CHAT_ID = process.env.DELETED_CHAT_ID;




// Redis
const redis = createClient({
    socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
    },
    password: process.env.REDIS_PASS,
    database: 1
});
await redis.connect();
await redis.select(1);
logger.info('REDIS connected');

const bot = new Telegraf(process.env.BOT_TOKEN);
logger.info('BOT ready');

async function setReactionRedis(chatId, messageId, userId, value) {
    try {
        const key = `reaction:${chatId}:${messageId}:${userId}`;
        if (value === 0) {
            await redis.del(key);
        } else {
            await redis.set(key, value);
        }
    } catch (error) {
        logger.error('Error in setReactionRedis: ', error);
    }
}

async function getTotalRedis(chatId, messageId) {
    try {
        const pattern = `reaction:${chatId}:${messageId}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length === 0) return 0;

        const values = await redis.mGet(keys); // получаем все значения за один раз
        return values.reduce((sum, v) => sum + parseInt(v || 0), 0);
    } catch (error) {
        logger.error('Error in getTotalRedis: ', error);
    }
}

function getReactionValue(oldEmoji, newEmoji) {
    try {

        // сняли реакцию
        if (!newEmoji && oldEmoji) {
            return 0;
        }

        // поставили новую реакцию
        if (newEmoji) {
            if (NEG.includes(newEmoji)) return -1;
            if (POS.includes(newEmoji)) return +1;
        }

        return 0;
    } catch (error) {
        logger.error('Error in getReactionValue: ', error);
        return 0;
    }
}

async function getThreshold(chatId, ctx) {
    try {
        const count = await ctx.telegram.getChatMembersCount(chatId);
        const realUsers = count - 1; // минус бот
        // console.log('getThreshold: ', Math.floor(realUsers * 0.8));
        return Math.floor(realUsers * 0.8);
    } catch (error) {
        logger.error('Error in getReactionValue: ', error);
        return 100;
    }
}

bot.on("message_reaction", async (ctx) => {
    const data = ctx.update.message_reaction;

    const chatId = data.chat.id;
    const messageId = data.message_id;
    const userId = data.user.id;

    const oldEmoji = data.old_reaction?.[0]?.emoji;
    const newEmoji = data.new_reaction?.[0]?.emoji;

    const delta = getReactionValue(oldEmoji, newEmoji);
    
    await setReactionRedis(chatId, messageId, userId, delta > 0 ? 1 : delta < 0 ? -1 : 0);

    const total = await getTotalRedis(chatId, messageId);

    const threshold = await getThreshold(chatId, ctx);

    try {
        if (Math.abs(total) >= threshold) {
            if (total < 0) {
                try {
                    await ctx.telegram.forwardMessage(DELETED_CHAT_ID, chatId, messageId);
                    await ctx.telegram.deleteMessage(chatId, messageId);
                    await redis.del(`reactions:${chatId}:${messageId}`);
                } catch (e) { console.log("Error in bot.on message_reaction - Ошибка удаления:", e.message); }
            }
            if (total > 0) {
                try {
                    await ctx.telegram.forwardMessage(SELECTED_CHAT_ID, chatId, messageId);
                    await ctx.telegram.deleteMessage(chatId, messageId);
                    await redis.del(`reactions:${chatId}:${messageId}`);
                } catch (e) { console.log("Error in bot.on message_reaction - Ошибка пересылки:", e.message); }
            }
            // можно почистить все реакции после удаления/пересылки
            const keys = await redis.keys(`reaction:${chatId}:${messageId}:*`);
            if (keys.length) await redis.del(keys);
        }
    } catch (error) {
        logger.error('Error in bot.on message_reaction: ', error);
    }
});


bot.command('links', async (ctx) => {

    try {
        const buttons = [];
        const sel_invite = await ctx.telegram.exportChatInviteLink(SELECTED_CHAT_ID);
        buttons.push([
            {
                text: 'SELECTED',
                url: sel_invite
            }
        ]);
        const del_invite = await ctx.telegram.exportChatInviteLink(DELETED_CHAT_ID);
        buttons.push([
            {
                text: 'DELETED',
                url: del_invite
            }
        ]);
        

        await ctx.reply(
            '📌 Чаты, куда бот переносит фото:',
            {
                reply_markup: {
                    inline_keyboard: buttons
                }
            }
        );
    } catch (error) {
        logger.error('Error in bot.command links: ', error);
        return;
    }
});

await bot.launch({allowedUpdates: ['message', 'edited_message', 'message_reaction']})
.then(() => logger.info("Telegram bot запущен!"))
.catch(err => {
    logger.error("Ошибка запуска бота:");
    logger.error(err);
});


process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));