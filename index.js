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

const bot = new Telegraf(BOT_TOKEN);

// --- কনফিগারেশন ---
const REQUIRED_CHANNELS = ['@androidmodapkfile', '@yes4all']; 
const badWords = ['nude', 'sex', 'chut', 'chuda', 'porn', 'fuck', 'magi', 'khanki']; 

// Database Connection
mongoose.connect(MONGO_URI).then(() => console.log('✅ Connected to MongoDB')).catch(err => console.log('❌ DB Error:', err));

// User Model
const User = mongoose.model('User', new mongoose.Schema({
    userId: { type: Number, unique: true },
    firstName: String,
    partnerId: { type: Number, default: null },
    status: { type: String, default: 'idle' },
    matchLimit: { type: Number, default: 10 },
    referrals: { type: Number, default: 0 },
    lastClaimed: { type: Date, default: null },
    webStatus: { type: String, default: 'idle' },
    webPartnerId: { type: Number, default: null },
    webSocketId: { type: String, default: null }
}));

// --- চ্যাট ফিল্টার, চ্যানেল চেক এবং অটো ডিলিট লজিক (আপনার রিকোয়েস্ট অনুযায়ী) ---
bot.use(async (ctx, next) => {
    try {
        if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
            const userId = ctx.from.id;
            const text = (ctx.message && (ctx.message.text || ctx.message.caption)) || "";

            // ১. অশ্লীল শব্দ ডিলিট
            const hasBadWord = badWords.some(word => text.toLowerCase().includes(word));
            if (hasBadWord) return await ctx.deleteMessage().catch(e => {});

            // ২. চ্যানেল সাবস্ক্রিপশন চেক
            let isSubscribed = true;
            for (const channel of REQUIRED_CHANNELS) {
                try {
                    const member = await ctx.telegram.getChatMember(channel, userId);
                    if (!['member', 'administrator', 'creator'].includes(member.status)) {
                        isSubscribed = false;
                        break;
                    }
                } catch (e) { isSubscribed = false; }
            }

            if (!isSubscribed) {
                await ctx.deleteMessage().catch(e => {});
                const mention = `<a href="tg://user?id=${userId}">${ctx.from.firstName}</a>`;
                const warningMsg = `⚠️ ${mention}, <b>You must need to join our both channel to chat in this group!</b>\n\nPlease join the channels below and try again.`;
                const buttons = REQUIRED_CHANNELS.map(ch => [Markup.button.url(`📢 Join ${ch}`, `https://t.me/${ch.replace('@','')}`)]);
                
                return ctx.replyWithHTML(warningMsg, Markup.inlineKeyboard(buttons)).then(sent => {
                    setTimeout(() => ctx.deleteMessage(sent.message_id).catch(e => {}), 15000);
                });
            }

            // ৩. ১ ঘণ্টা (৩৬০০ সেকেন্ড) পর মেসেজ অটো ডিলিট
            if (ctx.message) {
                const msgId = ctx.message.message_id;
                const chatId = ctx.chat.id;
                setTimeout(() => ctx.telegram.deleteMessage(chatId, msgId).catch(e => {}), 3600000);
            }
        }
    } catch (e) {}
    return next();
});

// --- ওয়েবসাইট ও সকেট লজিক (আপনার অরিজিনাল লজিক) ---
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    socket.on('join', async (userId) => {
        if (!userId) return;
        await User.findOneAndUpdate({ userId: Number(userId) }, { webSocketId: socket.id, webStatus: 'idle', webPartnerId: null }, { upsert: true });
    });

    socket.on('leave_chat', async (userId) => {
        const user = await User.findOne({ userId: Number(userId) });
        if (user && user.webPartnerId) {
            const partner = await User.findOne({ userId: user.webPartnerId });
            if (partner && partner.webSocketId) io.to(partner.webSocketId).emit('chat_ended');
            await User.updateOne({ userId: user.userId }, { webStatus: 'idle', webPartnerId: null });
            await User.updateOne({ userId: partner.userId }, { webStatus: 'idle', webPartnerId: null });
        }
    });

    socket.on('find_partner_web', async (userId) => {
        try {
            const user = await User.findOne({ userId: Number(userId) });
            const isAdmin = user.userId === ADMIN_ID;
            if (!isAdmin && user.matchLimit <= 0) return io.to(socket.id).emit('limit_over');
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
        } catch (err) {}
    });

    socket.on('send_msg', async (data) => {
        const { senderId, text, image } = data; 
        try {
            const user = await User.findOne({ userId: Number(senderId) });
            if (user && user.webPartnerId) {
                const partner = await User.findOne({ userId: user.webPartnerId });
                if (partner && partner.webSocketId) io.to(partner.webSocketId).emit('receive_msg', { text: text || null, image: image || null });
            }
        } catch (err) {}
    });

    socket.on('disconnect', async () => {
        try {
            const user = await User.findOne({ webSocketId: socket.id });
            if (user) {
                if (user.webPartnerId) {
                    const partner = await User.findOne({ userId: user.webPartnerId });
                    if (partner && partner.webSocketId) {
                        io.to(partner.webSocketId).emit('chat_ended');
                        await User.updateOne({ userId: partner.userId }, { webStatus: 'idle', webPartnerId: null });
                    }
                }
                await User.updateOne({ userId: user.userId }, { webSocketId: null, webStatus: 'idle', webPartnerId: null });
            }
        } catch (err) {}
    });
});

// --- টেলিগ্রাম কমান্ডস (সব আপনার দেওয়া টেক্সট অনুযায়ী) ---
bot.start(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const startPayload = ctx.payload;
        let user = await User.findOne({ userId });

        if (!user) {
            user = new User({ userId, firstName: ctx.from.first_name, matchLimit: 10 });
            if (startPayload && Number(startPayload) !== userId) {
                const referrer = await User.findOne({ userId: Number(startPayload) });
                if (referrer) {
                    await User.updateOne({ userId: referrer.userId }, { $inc: { matchLimit: 20, referrals: 1 } });
                    bot.telegram.sendMessage(referrer.userId, `🎉 Someone joined via your link! You received +20 matches.`).catch(e => {});
                }
            }
            await user.save();
        }
        
        ctx.replyWithHTML(`👋 <b>Welcome to MatchMe 💌</b>\n\n🎁 <b>Your Balance:</b> ${userId === ADMIN_ID ? 'Unlimited' : user.matchLimit + ' Matches'} left.\n👉 <a href="https://t.me/MakefriendsglobalBot/Letschat">✨ Start Chatting Now ✨</a>`, 
        Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize());
    } catch (err) {}
});

bot.hears('🔍 Find Partner', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const user = await User.findOne({ userId });
        if (userId !== ADMIN_ID && user.matchLimit <= 0) {
            return ctx.reply('❌ <b>Your match limit is over!</b>', { parse_mode: 'HTML' });
        }
        await User.updateOne({ userId }, { status: 'searching' });
        ctx.reply(`🔎 Searching for a partner...`, Markup.keyboard([['❌ Stop Search'], ['👤 My Status', '👫 Refer & Earn']]).resize());
        const partner = await User.findOne({ userId: { $ne: userId }, status: 'searching' });
        if (partner) {
            await User.updateOne({ userId }, { status: 'chatting', partnerId: partner.userId });
            await User.updateOne({ userId: partner.userId }, { status: 'chatting', partnerId: userId });
            ctx.reply('✅ Partner found! Start chatting...');
            bot.telegram.sendMessage(partner.userId, '✅ Partner found! Start chatting...');
        }
    } catch (err) {}
});

bot.hears('👫 Refer & Earn', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    const refLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
    ctx.replyWithHTML(`👫 <b>Referral Program</b>\n\n🎁 Reward: +20 Matches per referral.\n🔗 Link: ${refLink}\n📊 Total Referrals: ${user.referrals || 0}`);
});

bot.hears('👤 My Status', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    ctx.replyWithHTML(`👤 <b>Profile:</b>\nMatches Left: ${ctx.from.id === ADMIN_ID ? 'Unlimited' : user.matchLimit}\nReferrals: ${user.referrals || 0}`);
});

// --- মেসেজ পাসিং এবং ব্রডকাস্ট ---
bot.on('text', async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith('/broadcast ') && ctx.from.id === ADMIN_ID) {
        const msg = text.replace('/broadcast ', '').trim();
        const allUsers = await User.find({});
        ctx.reply(`📢 Broadcast started to ${allUsers.length} users...`);
        for (const u of allUsers) {
            bot.telegram.sendMessage(u.userId, msg, { parse_mode: 'HTML' }).catch(e => {});
            await new Promise(r => setTimeout(r, 50));
        }
        return;
    }
    const user = await User.findOne({ userId: ctx.from.id });
    if (user && user.status === 'chatting' && user.partnerId) {
        bot.telegram.sendMessage(user.partnerId, text).catch(e => {});
    }
    return next();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server Live on port ${PORT}`);
    const GROUP_ID = -1002461999862; 
    setInterval(async () => {
        const photoUrl = 'https://raw.githubusercontent.com/Roy00110/MNF/refs/heads/main/public/photo_2025-08-21_01-36-01.jpg'; 
        bot.telegram.sendPhoto(GROUP_ID, photoUrl, {
            caption: `✨ <b>Connect Anonymously & Chat Live!</b> ✨`, 
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.url('🚀 Launch Mini App', 'https://t.me/MakefriendsglobalBot/Letschat')]])
        }).then(m => setTimeout(() => bot.telegram.deleteMessage(GROUP_ID, m.message_id).catch(e=>{}), 450000)).catch(e=>{});
    }, 500000); 
    bot.launch();
});
