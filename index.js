const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const path = require('path'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI; 
const ADMIN_ID = Number(process.env.ADMIN_ID); 

// --- নতুন কনফিগারেশন ---
const CHANNELS = ['@androidmodapkfile', '@yes4all']; 
const BAD_WORDS = ['sex', 'fuck', 'porn']; 
const GROUP_ID = -1002461999862; 

const bot = new Telegraf(BOT_TOKEN);

// Database Connection
mongoose.connect(MONGO_URI).then(() => console.log('✅ Connected to MongoDB')).catch(err => console.log('❌ DB Error:', err));

// User Model
const User = mongoose.model('User', new mongoose.Schema({
    userId: { type: Number, unique: true },
    firstName: String,
    partnerId: { type: Number, default: null },
    status: { type: String, default: 'idle' },
    matchLimit: { type: Number, default: 1000 },
    referrals: { type: Number, default: 0 },
    lastClaimed: { type: Date, default: null },
    webStatus: { type: String, default: 'idle' },
    webPartnerId: { type: Number, default: null },
    webSocketId: { type: String, default: null },
    hasReceivedReferralBonus: { type: Boolean, default: false }
}));

// --- সাবস্ক্রিপশন চেক ফাংশন ---
async function isSubscribed(userId) {
    if (userId === ADMIN_ID) return true;
    for (const channel of CHANNELS) {
        try {
            const member = await bot.telegram.getChatMember(channel, userId);
            if (['left', 'kicked'].includes(member.status)) return false;
        } catch (e) { return false; }
    }
    return true;
}

// --- ওয়েবসাইট সার্ভার ও সকেট লজিক ---
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
   socket.on('join', async (userId) => {
        if (!userId) return;
        await User.findOneAndUpdate(
            { userId: Number(userId) }, 
            { webSocketId: socket.id, webStatus: 'idle', webPartnerId: null }, 
            { upsert: true }
        );
    });

    socket.on('find_partner_web', async (userId) => {
        try {
            const user = await User.findOne({ userId: Number(userId) });
            const isAdmin = user.userId === ADMIN_ID;
            if (!isAdmin && user.matchLimit <= 0) {
                const refLink = `https://t.me/${bot.botInfo.username}?start=${user.userId}`;
                bot.telegram.sendMessage(user.userId, `❌ <b>Your match limit is over!</b>\n\nInvite friends to get more matches.\n🔗 ${refLink}`, { parse_mode: 'HTML' }).catch(e => {});
                return io.to(socket.id).emit('limit_over');
            }
            await User.updateOne({ userId: Number(userId) }, { webStatus: 'searching', webSocketId: socket.id });
            const partner = await User.findOne({ userId: { $ne: Number(userId) }, webStatus: 'searching', webSocketId: { $ne: null } });
            if (partner && partner.webSocketId) {
                if (!isAdmin) await User.updateOne({ userId: user.userId }, { $inc: { matchLimit: -1 } });
                if (partner.userId !== ADMIN_ID) await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });
                await User.updateOne({ userId: user.userId }, { webStatus: 'chatting', webPartnerId: partner.userId });
                await User.updateOne({ userId: partner.userId }, { webStatus: 'chatting', webPartnerId: user.userId });
                io.to(socket.id).emit('match_found');
                io.to(partner.webSocketId).emit('match_found');
            }
        } catch (err) { console.error("Web Match Error:", err); }
    });

    socket.on('send_msg', async (data) => {
        const { senderId, text, image } = data; 
        const user = await User.findOne({ userId: Number(senderId) });
        if (user && user.webPartnerId) {
            const partner = await User.findOne({ userId: user.webPartnerId });
            if (partner && partner.webSocketId) {
                io.to(partner.webSocketId).emit('receive_msg', { text: text || null, image: image || null });
            }
        }
    });

    socket.on('disconnect', async () => {
        const user = await User.findOne({ webSocketId: socket.id });
        if (user) {
            if (user.webPartnerId) {
                const partner = await User.findOne({ userId: user.webPartnerId });
                if (partner && partner.webSocketId) io.to(partner.webSocketId).emit('chat_ended');
                await User.updateOne({ userId: user.webPartnerId || 0 }, { webStatus: 'idle', webPartnerId: null });
            }
            await User.updateOne({ userId: user.userId }, { webSocketId: null, webStatus: 'idle', webPartnerId: null });
        }
    });
});

// --- টেলিগ্রাম বট লজিক ---

bot.start(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const startPayload = ctx.payload;

        if (!(await isSubscribed(userId))) {
            const buttons = CHANNELS.map(c => [Markup.button.url(`Join ${c}`, `https://t.me/${c.replace('@', '')}`)]);
            return ctx.reply(`⚠️ <b>Access Denied!</b>\nYou must join our channels to use this bot.`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('✅ I have Joined', 'check_sub')]])
            });
        }

        let user = await User.findOne({ userId });

        if (!user || (user && !user.hasReceivedReferralBonus)) {
            if (startPayload && !isNaN(startPayload) && Number(startPayload) !== userId) {
                const referrer = await User.findOne({ userId: Number(startPayload) });
                if (referrer) {
                    await User.updateOne({ userId: referrer.userId }, { $inc: { matchLimit: 200, referrals: 1 } });
                    bot.telegram.sendMessage(referrer.userId, `🎉 Someone joined via your link! You received +200 matches.`).catch(e => {});
                }
            }
        }

        if (!user) {
            user = new User({ userId, firstName: ctx.from.first_name, matchLimit: 1000, hasReceivedReferralBonus: !!startPayload });
            await user.save();
        } else if (startPayload && !user.hasReceivedReferralBonus) {
            await User.updateOne({ userId }, { hasReceivedReferralBonus: true });
        }
        
        const welcomeMsg = `👋 <b>Welcome to MatchMe 💌</b>\n\n🎁 <b>Your Balance:</b> ${userId === ADMIN_ID ? 'Unlimited' : user.matchLimit + ' Matches'} left.\n\n🚀 <b>Connect with random people instantly!</b>\n👉 <a href="https://t.me/MakefriendsglobalBot/Letschat">✨ Start Chatting Now ✨</a>\n\n<i>Open our Mini App to find your perfect match!</i>`;
        
        ctx.reply(welcomeMsg, {
            parse_mode: 'HTML',
            disable_web_page_preview: false,
            ...Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['📱 Random video chat app'], ['❌ Stop Chat']]).resize()
        });
    } catch (err) { console.error("Start Error:", err); }
});

bot.action('check_sub', async (ctx) => {
    if (await isSubscribed(ctx.from.id)) {
        await ctx.deleteMessage().catch(e=>{});
        ctx.reply("✅ Verified! Type /start to begin.");
    } else {
        ctx.answerCbQuery("❌ You haven't joined all channels!", { show_alert: true });
    }
});

bot.hears('🔍 Find Partner', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const user = await User.findOne({ userId });
        const isAdmin = userId === ADMIN_ID;

        if (!isAdmin && user.matchLimit <= 0) {
            return ctx.reply('❌ <b>Your match limit is over!</b>\n\nClick the link below to visit, then click <b>Verify</b> to get 5 matches:', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Open Link 1', 'https://otieu.com/4/9382477'), Markup.button.callback('✅ Verify 1', 'verify_1')],
                    [Markup.button.url('🔗 Open Link 2', 'https://www.profitableratecpm.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'), Markup.button.callback('✅ Verify 2', 'verify_2')]
                ])
            });
        }

        if (user.status === 'chatting') return ctx.reply('❌ Already in a chat!');
        await User.updateOne({ userId }, { status: 'searching' });
        ctx.reply(`🔎 Searching...`, Markup.keyboard([['❌ Stop Search'], ['👤 My Status', '👫 Refer & Earn'], ['📱 Random video chat app']]).resize());

        const partner = await User.findOne({ userId: { $ne: userId }, status: 'searching' });
        if (partner) {
            if (!isAdmin) await User.updateOne({ userId }, { $inc: { matchLimit: -1 } });
            if (partner.userId !== ADMIN_ID) await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });
            await User.updateOne({ userId }, { status: 'chatting', partnerId: partner.userId });
            await User.updateOne({ userId: partner.userId }, { status: 'chatting', partnerId: userId });
            const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['📱 Random video chat app'], ['❌ Stop Chat']]).resize();
            ctx.reply('✅ Partner found!', menu);
            bot.telegram.sendMessage(partner.userId, '✅ Partner found!', menu).catch(e => {});
        }
    } catch (err) { console.error("Match Error:", err); }
});

// --- ব্রডকাস্ট এবং টেক্সট হ্যান্ডলার (Fixed) ---
bot.on('text', async (ctx, next) => {
    try {
        const text = ctx.message.text;
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID; // ফিক্সড: এখন এই ফাংশনের ভেতরেই আছে

        // গালি ও লিংক ফিল্টার
        if (BAD_WORDS.some(w => text.toLowerCase().includes(w))) {
            await ctx.deleteMessage().catch(e => {});
            return ctx.reply(`🚫 Bad language is not allowed!`).then(m => setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(e=>{}), 5000));
        }

        // ব্রডকাস্ট লজিক
        if (text.startsWith('/broadcast') && isAdmin) {
            const rawContent = text.replace('/broadcast', '').trim();
            const allUsers = await User.find({});
            let extraData = { parse_mode: 'HTML' };
            let finalMessage = rawContent;

            const parts = rawContent.split('|').map(p => p.trim());
            if (parts.length === 3) {
                finalMessage = parts[0];
                extraData.reply_markup = { inline_keyboard: [[{ text: parts[1], url: parts[2] }]] };
            }

            ctx.reply(`📢 Broadcast started to ${allUsers.length} users...`);
            let s = 0; let f = 0;

            for (const u of allUsers) {
                try {
                    if (ctx.message.reply_to_message) {
                        await bot.telegram.copyMessage(u.userId, ctx.chat.id, ctx.message.reply_to_message.message_id, extraData);
                    } else if (finalMessage) {
                        await bot.telegram.sendMessage(u.userId, finalMessage, extraData);
                    }
                    s++;
                } catch (e) { f++; }
                await new Promise(r => setTimeout(r, 50));
            }
            return ctx.reply(`✅ Broadcast Finished! Success: ${s}, Fail: ${f}`);
        }

        // ফোর্স সাব চেক
        if (ctx.chat.type === 'private' && !(await isSubscribed(userId))) {
            const buttons = CHANNELS.map(c => [Markup.button.url(`Join ${c}`, `https://t.me/${c.replace('@', '')}`)]);
            return ctx.reply(`⚠️ Join channels!`, Markup.inlineKeyboard(buttons));
        }

        const user = await User.findOne({ userId });
        if (!user || ['🔍 Find Partner', '👤 My Status', '👫 Refer & Earn', '❌ Stop Chat', '❌ Stop Search', '/start', '📱 Random video chat app'].includes(text)) return next();

        // মেসেজ ট্রান্সফার
        if (user.status === 'chatting' && user.partnerId) {
            bot.telegram.sendMessage(user.partnerId, text).catch(e => ctx.reply('⚠️ Partner left.'));
        }
    } catch (err) { console.error("Text Error:", err); }
});

bot.on(['photo', 'video', 'sticker', 'voice', 'audio'], async (ctx) => {
    try {
        const userId = ctx.from.id;
        const user = await User.findOne({ userId });
        const caption = ctx.message.caption || "";

        if (userId === ADMIN_ID && caption.startsWith('/broadcast')) {
            const allUsers = await User.find({});
            const cleanCap = caption.replace('/broadcast', '').trim();
            ctx.reply(`📢 Media Broadcast...`);
            for (const u of allUsers) {
                await bot.telegram.copyMessage(u.userId, ctx.chat.id, ctx.message.message_id, { caption: cleanCap, parse_mode: 'HTML' }).catch(e => {});
                await new Promise(r => setTimeout(r, 50));
            }
            return ctx.reply('✅ Sent.');
        }

        if (user && user.status === 'chatting' && user.partnerId) {
            return ctx.copyMessage(user.partnerId).catch(e => ctx.reply('⚠️ Partner left.'));
        }
    } catch (err) { console.error("Media Error:", err); }
});

bot.hears('👤 My Status', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    ctx.replyWithHTML(`👤 <b>Profile:</b>\nMatches: ${ctx.from.id === ADMIN_ID ? 'Unlimited' : user.matchLimit}\nReferrals: ${user.referrals || 0}`);
});

bot.hears('👫 Refer & Earn', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    ctx.replyWithHTML(`👫 <b>Refer & Earn</b>\nLink: https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}\nReferrals: ${user.referrals || 0}`);
});

bot.hears(['❌ Stop Chat', '❌ Stop Search'], async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['📱 Random video chat app'], ['❌ Stop Chat']]).resize();
    if (user && user.partnerId) {
        await User.updateOne({ userId: user.partnerId }, { status: 'idle', partnerId: null });
        bot.telegram.sendMessage(user.partnerId, '❌ Partner ended.', menu).catch(e => {});
    }
    await User.updateOne({ userId: ctx.from.id }, { status: 'idle', partnerId: null });
    ctx.reply('❌ Stopped.', menu);
});

bot.hears('📱 Random video chat app', (ctx) => ctx.reply("🎥 Premium Video Chat: https://1024terabox.com/s/1wCQFn0fXbrLKkUjufnkCMg"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Live on port ${PORT}`);
    let lastMsgId = null;
    setInterval(async () => {
        try {
            if (lastMsgId) await bot.telegram.deleteMessage(GROUP_ID, lastMsgId).catch(e => {});
            const sent = await bot.telegram.sendPhoto(GROUP_ID, 'https://raw.githubusercontent.com/Roy00110/MNF/refs/heads/main/public/photo_2025-08-21_01-36-01.jpg', {
                caption: `✨ <b>Secret Meet App</b>\n🚀 Start chatting now!`,
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.url('🚀 Launch App', 'https://t.me/MakefriendsglobalBot/Letschat')]])
            });
            lastMsgId = sent.message_id;
        } catch (e) {}
    }, 500000);
    bot.launch();
});
