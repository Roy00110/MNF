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
    matchLimit: { type: Number, default: 10 },
    referrals: { type: Number, default: 0 },
    lastClaimed: { type: Date, default: null },
    webStatus: { type: String, default: 'idle' },
    webPartnerId: { type: Number, default: null },
    webSocketId: { type: String, default: null },
    hasReceivedReferralBonus: { type: Boolean, default: false } // ডুপ্লিকেট বোনাস ঠেকাতে
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
        const startPayload = ctx.payload; // এটা রেফারার আইডি
        let user = await User.findOne({ userId });

        // ১. যদি ইউজার নতুন হয় (ডাটাবেসে নেই)
        if (!user) {
            let hasReferrer = false;

            // রেফারেল চেক
            if (startPayload && !isNaN(startPayload) && Number(startPayload) !== userId) {
                const referrer = await User.findOne({ userId: Number(startPayload) });
                if (referrer) {
                    await User.updateOne({ userId: referrer.userId }, { $inc: { matchLimit: 20, referrals: 1 } });
                    bot.telegram.sendMessage(referrer.userId, `🎉 Someone joined via your link! You received +20 matches.`).catch(e => {});
                    hasReferrer = true;
                }
            }

            // নতুন ইউজার তৈরি
            user = new User({ 
                userId, 
                firstName: ctx.from.first_name, 
                matchLimit: 10, 
                hasReceivedReferralBonus: hasReferrer // বোনাস পেয়েছে কি না সেভ রাখা
            });
            await user.save();
        }

        // ২. সাবস্ক্রিপশন চেক (ইউজার ডাটাবেসে সেভ হওয়ার পর চেক করা ভালো)
        if (!(await isSubscribed(userId))) {
            const buttons = CHANNELS.map(c => [Markup.button.url(`Join ${c}`, `https://t.me/${c.replace('@', '')}`)]);
            return ctx.reply(`⚠️ <b>Access Denied!</b>\nYou must join our channels to use this bot.`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('✅ I have Joined', 'check_sub')]])
            });
        }

        // ৩. ওয়েলকাম মেসেজ (বাকি অংশ আগের মতোই থাকবে)
        const welcomeMsg = `👋 <b>Welcome to MatchMe 💌</b>\n\n` +
                           `🎁 <b>Your Balance:</b> ${userId === ADMIN_ID ? 'Unlimited' : user.matchLimit + ' Matches'} left.\n\n` +
                           `🚀 <b>Connect with random people instantly!</b>\n` +
                           `👉 <a href="https://t.me/MakefriendsglobalBot/Letschat">✨ Start Chatting Now ✨</a>`;
        
        ctx.reply(welcomeMsg, {
            parse_mode: 'HTML',
            ...Markup.keyboard([
                ['🔍 Find Partner'], 
                ['👤 My Status', '👫 Refer & Earn'], 
                ['📱 Random video chat app'],
                ['❌ Stop Chat']
            ]).resize()
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
        ctx.reply(`🔎 Searching for a partner...`, Markup.keyboard([['❌ Stop Search'], ['👤 My Status', '👫 Refer & Earn'], ['📱 Random video chat app']]).resize());

        const partner = await User.findOne({ userId: { $ne: userId }, status: 'searching' });
        if (partner) {
            if (!isAdmin) await User.updateOne({ userId }, { $inc: { matchLimit: -1 } });
            if (partner.userId !== ADMIN_ID) await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });
            await User.updateOne({ userId }, { status: 'chatting', partnerId: partner.userId });
            await User.updateOne({ userId: partner.userId }, { status: 'chatting', partnerId: userId });
            const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['📱 Random video chat app'], ['❌ Stop Chat']]).resize();
            ctx.reply('✅ Partner found! Start chatting...', menu);
            bot.telegram.sendMessage(partner.userId, '✅ Partner found! Start chatting...', menu).catch(e => {});
        }
    } catch (err) { console.error("Match Error:", err); }
});

bot.hears('📱 Random video chat app', async (ctx) => {
    const videoChatMsg = `✨ <b>CONNECT INSTANTLY VIA VIDEO CHAT</b> ✨\n\n` +
        `Ready to meet new people globally? Get started with our premium video chat app. Experience high-quality video calls and seamless connections for free! 🎥🌍\n\n` +
        `📥 <b>OFFICIAL DOWNLOAD LINK:</b>\n` +
        `👉 <a href="https://1024terabox.com/s/1wCQFn0fXbrLKkUjufnkCMg"><b>Download & Install App Now</b></a>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👥 <b>JOIN OUR OFFICIAL COMMUNITY:</b>\n` +
        `Connect with others in our group: <a href="https://t.me/friends_chatting_group01">Friends Chatting Group</a>\n\n` +
        `🛡️ <i>Fast, Secure, and 100% Free to use.</i>`;
    ctx.replyWithHTML(videoChatMsg, { disable_web_page_preview: true });
});

bot.action(/verify_/, async (ctx) => {
    try {
        const user = await User.findOne({ userId: ctx.from.id });
        const today = new Date().setHours(0, 0, 0, 0);
        if (user.lastClaimed && new Date(user.lastClaimed).getTime() === today) {
            return ctx.answerCbQuery('❌ Already claimed today!', { show_alert: true });
        }
        await User.updateOne({ userId: ctx.from.id }, { $inc: { matchLimit: 5 }, $set: { lastClaimed: new Date(today) } });
        ctx.answerCbQuery('✅ 5 Matches Added!');
        ctx.editMessageText('🎉 <b>Bonus Added!</b> You got +5 matches.', { parse_mode: 'HTML' });
    } catch (err) { console.error("Verify Error:", err); }
});

bot.on('text', async (ctx, next) => {
    try {
        const text = ctx.message.text;
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID;

        // ১. গ্রুপ অটো-ডিলিট (১ ঘণ্টার পুরনো মেসেজ)
        if (ctx.chat.type !== 'private') {
            const hourAgo = Math.floor(Date.now() / 1000) - 3600;
            if (ctx.message.date < hourAgo) return ctx.deleteMessage().catch(e => {});
        }

        // ২. গালি ফিল্টার
        if (BAD_WORDS.some(w => text.toLowerCase().includes(w))) {
            await ctx.deleteMessage().catch(e => {});
            return ctx.reply(`🚫 Bad language is not allowed! Message deleted.`).then(m => setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(e=>{}), 5000));
        }

        // ৩. ফোর্স সাবস্ক্রাইব চেক (প্রাইভেট চ্যাটের জন্য)
        if (ctx.chat.type === 'private' && !(await isSubscribed(userId))) {
            const buttons = CHANNELS.map(c => [Markup.button.url(`Join ${c}`, `https://t.me/${c.replace('@', '')}`)]);
            return ctx.reply(`⚠️ Join our channels to chat!`, {
                parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons)
            });
        }

        const user = await User.findOne({ userId });
        if (!user) return;

        // --- ব্রডকাস্ট লজিক ---
        if (text.startsWith('/broadcast ') && isAdmin) {
            const msg = text.replace('/broadcast ', '').trim();
            const allUsers = await User.find({});
            for (const u of allUsers) {
                bot.telegram.sendMessage(u.userId, msg, { parse_mode: 'HTML' }).catch(e => {});
            }
            return ctx.reply(`✅ Broadcast sent to ${allUsers.length} users.`);
        }

        if (['🔍 Find Partner', '👤 My Status', '👫 Refer & Earn', '❌ Stop Chat', '❌ Stop Search', '/start', '📱 Random video chat app'].includes(text)) return next();
        
        if (ctx.chat.type === 'private' && !isAdmin) {
            const filter = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(t\.me\/[^\s]+)|(@[^\s]+)/gi;
            if (filter.test(text)) return ctx.reply('⚠️ Links and @usernames are blocked!');
        }

        if (user.status === 'chatting' && user.partnerId) {
            bot.telegram.sendMessage(user.partnerId, text).catch(e => ctx.reply('⚠️ Partner left.'));
        }
    } catch (err) { console.error("Text Error:", err); }
});

bot.on(['photo', 'video', 'sticker', 'voice', 'audio'], async (ctx) => {
    try {
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID;
        const user = await User.findOne({ userId });
        const caption = ctx.message.caption || "";

        if (isAdmin && caption.startsWith('/broadcast')) {
            const allUsers = await User.find({});
            const cleanCaption = caption.replace('/broadcast', '').trim();
            for (const u of allUsers) {
                ctx.copyMessage(u.userId, { caption: cleanCaption, parse_mode: 'HTML' }).catch(e => {});
            }
            return ctx.reply('✅ Media broadcast sent.');
        }

        if (user && user.status === 'chatting' && user.partnerId) {
            return ctx.copyMessage(user.partnerId).catch(e => ctx.reply('⚠️ Partner left.'));
        }
        ctx.reply('⚠️ Only text messages are allowed here! To send photos use mini app: https://t.me/MakefriendsglobalBot/Letschat');
    } catch (err) { console.error("Media Error:", err); }
});

bot.hears('👫 Refer & Earn', async (ctx) => {
    try {
        const user = await User.findOne({ userId: ctx.from.id });
        const refLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
        ctx.replyWithHTML(`👫 <b>Referral Program</b>\n\n🎁 Reward: +20 Matches per referral.\n🔗 Link: ${refLink}\n📊 Total Referrals: ${user.referrals || 0}`);
    } catch (err) { console.error("Referral Error:", err); }
});

bot.hears('👤 My Status', async (ctx) => {
    try {
        const user = await User.findOne({ userId: ctx.from.id });
        ctx.replyWithHTML(`👤 <b>Profile:</b>\nMatches Left: ${ctx.from.id === ADMIN_ID ? 'Unlimited' : user.matchLimit}\nReferrals: ${user.referrals || 0}`);
    } catch (err) { console.error("Status Error:", err); }
});

bot.hears(['❌ Stop Chat', '❌ Stop Search'], async (ctx) => {
    try {
        const user = await User.findOne({ userId: ctx.from.id });
        const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['📱 Random video chat app'], ['❌ Stop Chat']]).resize();
        if (user && user.partnerId) {
            await User.updateOne({ userId: user.partnerId }, { status: 'idle', partnerId: null });
            bot.telegram.sendMessage(user.partnerId, '❌ Partner ended the chat.', menu).catch(e => {});
        }
        await User.updateOne({ userId: ctx.from.id }, { status: 'idle', partnerId: null });
        ctx.reply('❌ Stopped.', menu);
    } catch (err) { console.error("Stop Error:", err); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server Live on port ${PORT}`);
    let lastAutoMsgId = null;

    async function sendAutoPromo() {
        try {
            if (lastAutoMsgId) await bot.telegram.deleteMessage(GROUP_ID, lastAutoMsgId).catch(e => {});
            const photoUrl = 'https://raw.githubusercontent.com/Roy00110/MNF/refs/heads/main/public/photo_2025-08-21_01-36-01.jpg'; 
            const promoMsg = `✨ <b>Connect Anonymously & Chat Live!</b> ✨\n\n` +
                             `Looking for someone to talk to? Meet random people instantly with our <b>Secret Meet</b> Mini App. No registration required! 🎭\n\n` +
                             `✅ <b>100% Private & Anonymous</b>\n` +
                             `✅ <b>Real-time Photo Sharing</b>\n` +
                             `✅ <b>Fast Matching</b>\n\n` +
                             `🚀 <b>Start your conversation now:</b>`;

            const sentMsg = await bot.telegram.sendPhoto(GROUP_ID, photoUrl, {
                caption: promoMsg,
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.url('🚀 Launch Mini App', 'https://t.me/MakefriendsglobalBot/Letschat')]])
            });
            lastAutoMsgId = sentMsg.message_id;
        } catch (err) {}
    }

    setInterval(sendAutoPromo, 500000); 
    sendAutoPromo();
    bot.launch();
});
