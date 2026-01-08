const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const path = require('path'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI; 
const ADMIN_ID = Number(process.env.ADMIN_ID); 
const CHANNELS = ['@androidmodapkfile', '@yes4all']; 
const BAD_WORDS = ['sex', 'fuck', 'porn']; 
const GROUP_ID = -1002461999862; 

const bot = new Telegraf(BOT_TOKEN);

// --- Database Connection ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ [DB] Connected to MongoDB Successfully'))
    .catch(err => console.log('❌ [DB] Error:', err));

// --- User Model (Updated with missing fields) ---
const User = mongoose.model('User', new mongoose.Schema({
    userId: { type: Number, unique: true },
    firstName: String,
    partnerId: { type: Number, default: null },
    status: { type: String, default: 'idle' },
    matchLimit: { type: Number, default: 20 },
    referrals: { type: Number, default: 0 },
    lastClaimed: { type: Date, default: null },
    webStatus: { type: String, default: 'idle' },
    webPartnerId: { type: Number, default: null },
    webSocketId: { type: String, default: null },
    hasReceivedReferralBonus: { type: Boolean, default: false },
    // Missing Fields Added
    joinedChannel: { type: Boolean, default: false }, 
    lastSpin: { type: Date, default: null },          
    isVip: { type: Boolean, default: false }
}));

// --- Helper Functions ---
async function isSubscribed(userId) {
    console.log(`🔍 [Check] Verifying subscription for: ${userId}`);
    if (userId === ADMIN_ID) return true;
    for (const channel of CHANNELS) {
        try {
            const member = await bot.telegram.getChatMember(channel, userId);
            if (['left', 'kicked'].includes(member.status)) return false;
        } catch (e) { 
            console.log(`⚠️ [Sub Error] ${channel}:`, e.message);
            return false; 
        }
    }
    return true;
}

// --- Web Server & Socket.io Logic ---
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/adsgram/reward', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).send('Missing userId');
    try {
        const user = await User.findOneAndUpdate(
            { userId: Number(userId) },
            { $inc: { matchLimit: 5 } },
            { new: true }
        );
        if (user) {
            console.log(`💰 [Adsgram S2S] Reward applied to ${userId}. New limit: ${user.matchLimit}`);
            return res.status(200).send('OK');
        } else {
            return res.status(404).send('User not found');
        }
    } catch (err) {
        console.error("Adsgram S2S Error:", err);
        res.status(500).send('Server Error');
    }
});

io.on('connection', (socket) => {
    console.log(`🌐 [Socket] New Web Connection: ${socket.id}`);
    
   socket.on('join', async (userId) => {
    if (!userId) return;
    const user = await User.findOneAndUpdate(
        { userId: Number(userId) }, 
        { webSocketId: socket.id, webStatus: 'idle', webPartnerId: null }, 
        { upsert: true, new: true }
    );
    console.log(`👤 [Web] User ${userId} joined via socket ${socket.id}`);
    socket.emit('user_data', { limit: user.matchLimit || 0 });
});

    socket.on('reward_user', async (userId) => {
        try {
            const user = await User.findOneAndUpdate(
                { userId: Number(userId) },
                { $inc: { matchLimit: 15 } }, // Updated to 15 as per previous logic
                { new: true }
            );
            console.log(`🎁 [Reward Success] User ${userId} watched video. Balance: ${user.matchLimit}`);
            socket.emit('reward_confirmed', user.matchLimit);
            socket.emit('user_data', { limit: user.matchLimit });
        } catch (err) {
            console.log('❌ [Reward Error]:', err);
        }
    });

    // --- Added Daily Claim Logic ---
    socket.on('claim_daily', async (userId) => {
        const user = await User.findOne({ userId: Number(userId) });
        const today = new Date().toDateString();
        if (user && (!user.lastClaimed || user.lastClaimed.toDateString() !== today)) {
            user.matchLimit += 5;
            user.lastClaimed = new Date();
            await user.save();
            console.log(`📅 [Daily Claim] User: ${userId} claimed bonus`);
            socket.emit('user_data', { limit: user.matchLimit });
        }
    });

    // --- Added Lucky Spin Logic ---
    socket.on('lucky_spin', async (userId) => {
        const user = await User.findOne({ userId: Number(userId) });
        const today = new Date().toDateString();
        if (user && (!user.lastSpin || user.lastSpin.toDateString() !== today)) {
            const winAmount = Math.floor(Math.random() * 50) + 1;
            user.matchLimit += winAmount;
            user.lastSpin = new Date();
            await user.save();
            console.log(`🎰 [Lucky Spin] User: ${userId} won ${winAmount}`);
            socket.emit('user_data', { limit: user.matchLimit });
            socket.emit('spin_result', { amount: winAmount });
        }
    });

    // --- Added Social Task Logic ---
    socket.on('social_task', async (userId) => {
        const user = await User.findOne({ userId: Number(userId) });
        if (user && !user.joinedChannel) {
            user.matchLimit += 10;
            user.joinedChannel = true;
            await user.save();
            console.log(`📱 [Social Task] User: ${userId} completed task`);
            socket.emit('user_data', { limit: user.matchLimit });
        }
    });

    socket.on('find_partner_web', async (userId) => {
        try {
            const user = await User.findOne({ userId: Number(userId) });
            if (!user) return;
            if (user.userId !== ADMIN_ID && user.matchLimit <= 0) {
                console.log(`🚫 [Web] Match limit over for: ${userId}`);
                return io.to(socket.id).emit('limit_over');
            }
            await User.updateOne({ userId: Number(userId) }, { webStatus: 'searching' });
            const partner = await User.findOneAndUpdate(
                { userId: { $ne: Number(userId) }, webStatus: 'searching', webSocketId: { $ne: null } },
                { webStatus: 'chatting', webPartnerId: Number(userId) },
                { new: true }
            );
            if (partner) {
                await User.updateOne({ userId: Number(userId) }, { webStatus: 'chatting', webPartnerId: partner.userId });
                if (user.userId !== ADMIN_ID) await User.updateOne({ userId: user.userId }, { $inc: { matchLimit: -1 } });
                if (partner.userId !== ADMIN_ID) await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });
                io.to(socket.id).emit('match_found');
                io.to(partner.webSocketId).emit('match_found');
                console.log(`🤝 [Web Match] ${userId} matched with ${partner.userId}`);
            }
        } catch (err) { console.error("Web Match Error:", err); }
    });

    socket.on('send_msg', async (data) => {
        const { senderId, text, image } = data; 
        const user = await User.findOne({ userId: Number(senderId) });
        if (user && user.webPartnerId) {
            const partner = await User.findOne({ userId: user.webPartnerId });
            if (partner && partner.webSocketId) {
                io.to(partner.webSocketId).emit('receive_msg', { text, image });
            }
        }
    });

    socket.on('disconnect', async () => {
        const user = await User.findOne({ webSocketId: socket.id });
        if (user) {
            if (user.webPartnerId) {
                const partner = await User.findOne({ userId: user.webPartnerId });
                if (partner && partner.webSocketId) io.to(partner.webSocketId).emit('chat_ended');
                await User.updateOne({ userId: user.webPartnerId }, { webStatus: 'idle', webPartnerId: null });
            }
            await User.updateOne({ userId: user.userId }, { webSocketId: null, webStatus: 'idle', webPartnerId: null });
        }
    });
});

// --- Telegram Bot Logic ---
bot.start(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const startPayload = ctx.payload;
        console.log(`🚀 [/start] User: ${userId} | Payload: ${startPayload}`);

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
                    await User.updateOne({ userId: referrer.userId }, { $inc: { matchLimit: 20, referrals: 1 } });
                    bot.telegram.sendMessage(referrer.userId, `🎉 Someone joined via your link! You received +20 matches.`).catch(() => {});
                }
            }
        }

        if (!user) {
            user = new User({ userId, firstName: ctx.from.first_name, matchLimit: 20, hasReceivedReferralBonus: !!startPayload });
            await user.save();
        } else if (startPayload && !user.hasReceivedReferralBonus) {
            await User.updateOne({ userId }, { hasReceivedReferralBonus: true });
        }

        const welcomeMsg = `👋 <b>Welcome to MatchMe 💌</b>\n\n` +
                            `🎁 <b>Your Balance:</b> ${userId === ADMIN_ID ? 'Unlimited' : user.matchLimit + ' Matches'} left.\n\n` +
                            `🚀 <b>Download and Install our Random video chat App to Connect with random people instantly!</b>\n` +
                            `👉 <a href="https://1024terabox.com/s/1wCQFn0fXbrLKkUjufnkCMg">✨ Download Random Video Chat App ✨</a>\n\n` +
                            `<i>Open our Mini App to find your perfect match!</i>`;
        
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
        await ctx.deleteMessage().catch(()=>{});
        ctx.reply("✅ Verified! Type /start to begin.");
    } else {
        ctx.answerCbQuery("❌ You haven't joined all channels!", { show_alert: true });
    }
});

bot.action(['verify_1', 'verify_2'], async (ctx) => {
    try {
        await User.updateOne({ userId: ctx.from.id }, { $inc: { matchLimit: 5 } });
        ctx.answerCbQuery("✅ Success! You received 5 matches.", { show_alert: true });
        await ctx.deleteMessage().catch(()=>{});
        ctx.reply("🎁 5 matches added! You can now search for a partner again.");
    } catch (err) { console.error("Verify Action Error:", err); }
});

bot.hears('🔍 Find Partner', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const user = await User.findOne({ userId });

        // ১. সাবস্ক্রিপশন চেক (যদি ইউজার চ্যানেল জয়েন না করে থাকে)
        if (!(await isSubscribed(userId))) {
            const buttons = CHANNELS.map(c => [Markup.button.url(`Join ${c}`, `https://t.me/${c.replace('@', '')}`)]);
            return ctx.reply(`⚠️ <b>Access Denied!</b>\nYou must join our channels to use this bot.`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('✅ I have Joined', 'check_sub')]])
            });
        }

        // ২. লিমিট চেক (লিমিট না থাকলে ভেরিফিকেশন বাটন দেখাবে)
        if (userId !== ADMIN_ID && user.matchLimit <= 0) {
            return ctx.reply('❌ <b>Your match limit is over!</b>\n\nClick the link below to visit, then click <b>Verify</b> to get 5 matches:', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Open Link 1', 'https://otieu.com/4/9382477'), Markup.button.callback('✅ Verify 1', 'verify_1')],
                    [Markup.button.url('🔗 Open Link 2', 'https://www.profitableratecpm.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'), Markup.button.callback('✅ Verify 2', 'verify_2')]
                ])
            });
        }

        // ৩. চ্যাট রিডাইরেক্ট (বট চ্যাট না করে মিনি অ্যাপে পাঠাবে)
        const miniAppMsg = `🚀 <b>Ready to Find Your Match?</b>\n\n` +
                           `Start our  <b>Mini App</b>  experience with photo sharing and instant connection With strangers! ⚡\n\n` +
                           `👇 <b>Click the button below to start:</b>`;

        ctx.reply(miniAppMsg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🚀 Open Mini App', 'https://t.me/MakefriendsglobalBot/Letschat')]
            ])
        });

        console.log(`📲 [Redirect] User ${userId} redirected to Mini App`);

    } catch (err) { 
        console.error("Find Partner Error:", err); 
    }
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

bot.on(['photo', 'video', 'video_note', 'voice', 'audio', 'document'], async (ctx) => {
    const userId = ctx.from.id;
    const isAdmin = userId === ADMIN_ID;
    const caption = ctx.message.caption || "";

    // --- ১. মিডিয়া ব্রডকাস্ট লজিক (Manual Link + Background Processing) ---
    if (isAdmin && caption.startsWith('/broadcast')) {
        // তাৎক্ষণিক রেসপন্স যাতে টাইমআউট এরর না আসে
        ctx.reply("⏳ Media Broadcast started in background. I will notify you when finished.").catch(() => {});

        (async () => {
            try {
                const parts = caption.split('|');
                const link = parts[1] ? parts[1].trim() : null;

                const allUsers = await User.find({});
                let count = 0;
                let failedCount = 0;

                for (const u of allUsers) {
                    try {
                        const extra = {};
                        if (link) {
                            extra.reply_markup = {
                                inline_keyboard: [[{ text: '🚀 Open Link', url: link }]]
                            };
                        }
                        
                        await bot.telegram.copyMessage(u.userId, ctx.chat.id, ctx.message.message_id, extra);
                        count++;
                        
                        // প্রতি ২৫ মেসেজ পর ১.৫ সেকেন্ড বিরতি (টেলিগ্রাম লিমিট রক্ষার জন্য)
                        if (count % 25 === 0) await new Promise(r => setTimeout(r, 1500));
                    } catch (e) {
                        failedCount++;
                    }
                }
                // শেষ হলে অ্যাডমিনকে রিপোর্ট দেওয়া
                bot.telegram.sendMessage(ADMIN_ID, `✅ <b>Media Broadcast Finished!</b>\n\n🚀 Sent to: ${count} users\n❌ Failed: ${failedCount}`, { parse_mode: 'HTML' }).catch(() => {});
            } catch (err) {
                console.error("BG Media Broadcast Error:", err);
            }
        })();
        return;
    }

    // --- ২. চ্যাটিং অবস্থায় মিডিয়া ব্লক করা ---
    const user = await User.findOne({ userId });
    if (user && user.status === 'chatting') {
        await ctx.deleteMessage().catch(()=>{});
        return ctx.reply("⚠️ Sending photos/media is not allowed in chat!");
    }
});

bot.on('text', async (ctx, next) => {
    try {
        const text = ctx.message.text;
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID;

        // --- ১. ব্রডকাস্ট লজিক (Manual Link + Background Processing) ---
        if (text.startsWith('/broadcast ') && isAdmin) {
            const fullContent = text.replace('/broadcast ', '').trim();
            const parts = fullContent.split('|');
            const msg = parts[0].trim();
            const link = parts[1] ? parts[1].trim() : null;

            ctx.reply("⏳ Text Broadcast started in background...").catch(() => {});

            (async () => {
                try {
                    const allUsers = await User.find({});
                    let count = 0;
                    let failedCount = 0;

                    for (const u of allUsers) {
                        try {
                            const extra = { parse_mode: 'HTML' };
                            if (link) {
                                extra.reply_markup = {
                                    inline_keyboard: [[{ text: '🚀 Open Link', url: link }]]
                                };
                            }
                            await bot.telegram.sendMessage(u.userId, msg, extra);
                            count++;
                            if (count % 25 === 0) await new Promise(r => setTimeout(r, 1500));
                        } catch (e) {
                            failedCount++;
                        }
                    }
                    bot.telegram.sendMessage(ADMIN_ID, `✅ <b>Text Broadcast Finished!</b>\n\n🚀 Sent to: ${count} users\n❌ Failed: ${failedCount}`, { parse_mode: 'HTML' }).catch(() => {});
                } catch (err) {
                    console.error("BG Text Broadcast Error:", err);
                }
            })();
            return;
        }

        // --- ২. ব্যাড ওয়ার্ড ফিল্টার ---
        if (BAD_WORDS.some(w => text.toLowerCase().includes(w))) {
            await ctx.deleteMessage().catch(()=>{});
            return ctx.reply(`🚫 Bad language is not allowed! Message deleted.`)
                .then(m => setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(()=>{}), 5000));
        }

        // --- ৩. মেনু বাটন চেক ---
        if (['🔍 Find Partner', '👤 My Status', '👫 Refer & Earn', '❌ Stop Chat', '❌ Stop Search', '/start', '📱 Random video chat app'].includes(text)) return next();

        // --- ৪. লিঙ্ক ফিল্টার ---
        if (!isAdmin) {
            if (/(https?:\/\/[^\s]+)|(www\.[^\s]+)|(t\.me\/[^\s]+)|(@[^\s]+)/gi.test(text)) {
                await ctx.deleteMessage().catch(()=>{});
                return ctx.reply('⚠️ Links not allowed!');
            }
        }

        // --- ৫. পার্টনার চ্যাটিং লজিক ---
        const user = await User.findOne({ userId });
        if (user && user.status === 'chatting' && user.partnerId) {
            bot.telegram.sendMessage(user.partnerId, text)
                .catch(() => ctx.reply('⚠️ Partner left.'));
        }
    } catch (err) { 
        console.error("Text Handler Error:", err); 
    }
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

bot.hears(['❌ Stop Chat', '❌ Stop Search'], async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize();
    if (user && user.partnerId) {
        await User.updateOne({ userId: user.partnerId }, { status: 'idle', partnerId: null });
        bot.telegram.sendMessage(user.partnerId, '❌ Partner ended the chat.', menu).catch(()=>{});
    }
    await User.updateOne({ userId: ctx.from.id }, { status: 'idle', partnerId: null });
    ctx.reply('❌ Stopped.', menu);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 [Server] System Live on port ${PORT}`);
    let lastAutoMsgId = null;
    async function sendAutoPromo() {
        try {
            if (lastAutoMsgId) await bot.telegram.deleteMessage(GROUP_ID, lastAutoMsgId).catch(()=>{});
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
