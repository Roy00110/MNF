const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const CHANNELS = ['@androidmodapkfile', '@yes4all'];
const BAD_WORDS = ['sex', 'fuck', 'porn'];
const GROUP_ID = -1002461999862;

const bot = new Telegraf(BOT_TOKEN);

// --- Optimized: Use Set instead of Array ---
const waitingUsers = new Set();

// --- Database Connection ---
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log('✅ [DB] Connected to MongoDB Successfully'))
.catch(err => console.log('❌ [DB] Error:', err));

// --- User Model with indexes ---
const userSchema = new mongoose.Schema({
  userId: { type: Number, unique: true, index: true },
  firstName: String,
  partnerId: { type: Number, default: null, index: true },
  status: { type: String, default: 'idle', index: true },
  matchLimit: { type: Number, default: 10 },
  referrals: { type: Number, default: 0 },
  lastClaimed: { type: Date, default: null },
  webStatus: { type: String, default: 'idle', index: true },
  webPartnerId: { type: Number, default: null, index: true },
  webSocketId: { type: String, default: null },
  hasReceivedReferralBonus: { type: Boolean, default: false },
  joinedChannel: { type: Boolean, default: false },
  lastSpin: { type: Date, default: null },
  isVip: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now, index: true },
  lastReminderSent: { type: Date, default: null }
});

userSchema.index({ webStatus: 1, webSocketId: 1 });

const User = mongoose.model('User', userSchema);

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

// --- Optimized: Bulk update for last active ---
const activeUpdates = new Map();
let activeUpdateTimeout = null;

async function updateLastActive(userId) {
    if (!userId) return;
    activeUpdates.set(Number(userId), new Date());
    
    if (!activeUpdateTimeout) {
        activeUpdateTimeout = setTimeout(async () => {
            const updates = Array.from(activeUpdates.entries());
            activeUpdates.clear();
            if (updates.length === 0) return;
            
            const bulkOps = updates.map(([userId, lastActive]) => ({
                updateOne: {
                    filter: { userId },
                    update: { $set: { lastActive } }
                }
            }));
            
            try {
                await User.bulkWrite(bulkOps, { ordered: false });
            } catch (err) {
                console.error("Bulk update error:", err);
            }
            activeUpdateTimeout = null;
        }, 5000);
    }
}

// --- Optimized inactivity checker with pagination ---
async function checkInactiveUsers() {
    try {
        const now = new Date();
        const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
        
        let skip = 0;
        const batchSize = 100;
        let totalProcessed = 0;
        
        while (true) {
            const inactiveUsers = await User.find({
                userId: { $ne: ADMIN_ID },
                lastActive: { $lt: twentyFourHoursAgo },
                $or: [
                    { lastReminderSent: null },
                    { lastReminderSent: { $lt: twentyFourHoursAgo } }
                ]
            })
            .limit(batchSize)
            .skip(skip)
            .lean()
            .exec();
            
            if (inactiveUsers.length === 0) break;
            
            console.log(`📊 [Inactivity Check] Processing batch ${skip/batchSize + 1} (${inactiveUsers.length} users)`);
            
            for (const user of inactiveUsers) {
                try {
                    const hoursInactive = Math.floor((now - user.lastActive) / (60 * 60 * 1000));
                    const daysInactive = Math.floor(hoursInactive / 24);
                    
                    let reminderMsg = '';
                    
                    if (daysInactive === 1) {
                        reminderMsg = `🔔 <b>Hey ${user.firstName || 'there'}! 👋</b>\n\n` +
                                     `We noticed you haven't used <b>MatchMe</b> in the last 24 hours.\n\n` +
                                     `✨ <b>Come back and connect with new people!</b>\n\n` +
                                     `👉 <b>Your balance:</b> ${user.matchLimit} matches remaining\n\n` +
                                     `🚀 <b>Start chatting now:</b>`;
                    } else if (daysInactive === 2) {
                        reminderMsg = `⚠️ <b>${user.firstName || 'There'}! We Miss You! 💔</b>\n\n` +
                                     `It's been <b>2 days</b> since your last visit.\n\n` +
                                     `🎁 You have <b>${user.matchLimit}</b> matches waiting!\n\n` +
                                     `👇 <b>Tap below to start chatting:</b>`;
                    } else if (daysInactive >= 3) {
                        reminderMsg = `🚨 <b>${user.firstName || 'Friend'}! Don't Miss Out! 🚨</b>\n\n` +
                                     `It's been <b>${daysInactive} days</b>!\n\n` +
                                     `🔥 <b>Your Stats:</b>\n` +
                                     `• ${user.matchLimit} matches available\n` +
                                     `• ${user.referrals || 0} referrals\n\n` +
                                     `👇 <b>Start matching NOW:</b>`;
                    } else {
                        reminderMsg = `🔔 <b>Hey ${user.firstName || 'there'}! 👋</b>\n\n` +
                                     `Come back to <b>MatchMe</b>!\n\n` +
                                     `👉 <b>Balance:</b> ${user.matchLimit} matches remaining\n\n` +
                                     `🚀 <b>Start chatting now:</b>`;
                    }
                    
                    await bot.telegram.sendMessage(user.userId, reminderMsg, {
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            [Markup.button.url('🎯 Start Chat Now', 'https://t.me/MakefriendsglobalBot/Letschat')],
                            [Markup.button.callback('💰 Claim Daily Bonus', 'claim_bonus')]
                        ])
                    });
                    
                    await User.updateOne(
                        { userId: user.userId },
                        { $set: { lastReminderSent: new Date() } }
                    );
                    
                    console.log(`📨 [Reminder] Sent to ${user.userId} (${daysInactive}d inactive)`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                } catch (err) {
                    console.error(`❌ [Reminder Failed] ${user.userId}:`, err.message);
                }
            }
            
            totalProcessed += inactiveUsers.length;
            skip += batchSize;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`📊 [Inactivity Check] Complete. Processed ${totalProcessed} users`);
        
    } catch (err) {
        console.error("❌ [Inactivity Check Error]:", err);
    }
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
            console.log(`💰 [Adsgram] Reward to ${userId}. New limit: ${user.matchLimit}`);
            return res.status(200).send('OK');
        } else {
            return res.status(404).send('User not found');
        }
    } catch (err) {
        console.error("Adsgram Error:", err);
        res.status(500).send('Server Error');
    }
});

const socketConnections = new Map();

io.on('connection', (socket) => {
    console.log(`🌐 [Socket] New connection: ${socket.id}`);
    
    socket.on('join', async (userId) => {
        if (!userId) return;
        await updateLastActive(userId);
        socketConnections.set(socket.id, userId);
        
        const user = await User.findOneAndUpdate(
            { userId: Number(userId) }, 
            { webSocketId: socket.id, webStatus: 'idle', webPartnerId: null }, 
            { upsert: true, new: true }
        );
        console.log(`👤 [Web] User ${userId} joined`);
        socket.emit('user_data', { limit: user.matchLimit || 0 });
    });

    socket.on('reward_user', async (userId) => {
        try {
            await updateLastActive(userId);
            const user = await User.findOneAndUpdate(
                { userId: Number(userId) },
                { $inc: { matchLimit: 15 } },
                { new: true }
            );
            console.log(`🎁 [Reward] User ${userId} watched video. Balance: ${user.matchLimit}`);
            socket.emit('reward_confirmed', user.matchLimit);
            socket.emit('user_data', { limit: user.matchLimit });
        } catch (err) {
            console.log('❌ [Reward Error]:', err);
        }
    });

    socket.on('claim_daily', async (userId) => {
        await updateLastActive(userId);
        const user = await User.findOne({ userId: Number(userId) });
        const today = new Date().toDateString();
        if (user && (!user.lastClaimed || user.lastClaimed.toDateString() !== today)) {
            user.matchLimit += 5;
            user.lastClaimed = new Date();
            await user.save();
            console.log(`📅 [Daily Claim] User: ${userId}`);
            socket.emit('user_data', { limit: user.matchLimit });
        }
    });

    socket.on('cancel_search', async (userId) => {
        try {
            if (!userId) return;
            await updateLastActive(userId);
            waitingUsers.delete(userId);
            await User.updateOne(
                { userId: Number(userId) }, 
                { $set: { webStatus: 'idle' } }
            );
            console.log(`🛑 [Search Cancelled] User: ${userId}`);
        } catch (err) {
            console.error("Cancel Search Error:", err);
        }
    });

    socket.on('lucky_spin', async (userId) => {
        await updateLastActive(userId);
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

    socket.on('social_task', async (userId) => {
        await updateLastActive(userId);
        const user = await User.findOne({ userId: Number(userId) });
        if (user && !user.joinedChannel) {
            user.matchLimit += 10;
            user.joinedChannel = true;
            await user.save();
            console.log(`📱 [Social Task] User: ${userId} completed`);
            socket.emit('user_data', { limit: user.matchLimit });
        }
    });

    socket.on('find_partner_web', async (userId) => {
        await updateLastActive(userId);
        waitingUsers.delete(userId);
        waitingUsers.add(userId);
        
        try {
            const user = await User.findOne({ userId: Number(userId) });
            if (!user) return;
            
            if (user.userId !== ADMIN_ID && user.matchLimit <= 0) {
                waitingUsers.delete(userId);
                return io.to(socket.id).emit('limit_over');
            }
            
            await User.updateOne(
                { userId: Number(userId) },
                { webStatus: 'searching', webSocketId: socket.id }
            );
            
            const partner = await User.findOneAndUpdate(
                {
                    userId: { $ne: Number(userId) },
                    webStatus: 'searching',
                    webSocketId: { $ne: null }
                },
                { webStatus: 'chatting', webPartnerId: Number(userId) },
                { new: true }
            );
            
            if (partner) {
                waitingUsers.delete(userId);
                waitingUsers.delete(partner.userId);
                
                await User.updateOne(
                    { userId: Number(userId) },
                    { webStatus: 'chatting', webPartnerId: partner.userId }
                );
                
                if (user.userId !== ADMIN_ID) {
                    await User.updateOne({ userId: user.userId }, { $inc: { matchLimit: -1 } });
                }
                if (partner.userId !== ADMIN_ID) {
                    await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });
                }
                
                io.to(socket.id).emit('match_found');
                if (partner.webSocketId) {
                    io.to(partner.webSocketId).emit('match_found');
                }
                
                console.log(`🤝 [Web Match] ${userId} matched with ${partner.userId}`);
            }
        } catch (err) {
            console.error("Web Match Error:", err);
        }
    });
    
    socket.on('send_msg', async (data) => {
        const { senderId, text, image } = data;
        await updateLastActive(senderId);
        
        const user = await User.findOne({ userId: Number(senderId) }).lean();
        if (user && user.webPartnerId) {
            const partner = await User.findOne({ userId: user.webPartnerId }).lean();
            if (partner && partner.webSocketId) {
                io.to(partner.webSocketId).emit('receive_msg', { text, image });
            }
        }
    });

    socket.on('disconnect', async () => {
        const userId = socketConnections.get(socket.id);
        if (userId) {
            await updateLastActive(userId);
            
            const user = await User.findOne({ userId: Number(userId) });
            if (user) {
                if (user.webPartnerId) {
                    const partner = await User.findOne({ userId: user.webPartnerId });
                    if (partner && partner.webSocketId) {
                        io.to(partner.webSocketId).emit('chat_ended');
                    }
                    await User.updateOne(
                        { userId: user.webPartnerId },
                        { webStatus: 'idle', webPartnerId: null }
                    );
                }
                await User.updateOne(
                    { userId: user.userId },
                    { webSocketId: null, webStatus: 'idle', webPartnerId: null }
                );
            }
            
            socketConnections.delete(socket.id);
            waitingUsers.delete(userId);
        }
        console.log(`🌐 [Socket] Disconnected: ${socket.id}`);
    });
});

// --- সমস্ত Telegram Bot Handler (পুরোপুরি রাখা হয়েছে) ---
bot.start(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const startPayload = ctx.payload;
        
        await updateLastActive(userId);
        
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
    await updateLastActive(ctx.from.id);
    if (await isSubscribed(ctx.from.id)) {
        await ctx.deleteMessage().catch(()=>{});
        ctx.reply("✅ Verified! Type /start to begin.");
    } else {
        ctx.answerCbQuery("❌ You haven't joined all channels!", { show_alert: true });
    }
});

bot.action(['verify_1', 'verify_2'], async (ctx) => {
    try {
        await updateLastActive(ctx.from.id);
        await User.updateOne({ userId: ctx.from.id }, { $inc: { matchLimit: 5 } });
        ctx.answerCbQuery("✅ Success! You received 5 matches.", { show_alert: true });
        await ctx.deleteMessage().catch(()=>{});
        ctx.reply("🎁 5 matches added! You can now search for a partner again.");
    } catch (err) { console.error("Verify Action Error:", err); }
});

bot.action('claim_bonus', async (ctx) => {
    try {
        await updateLastActive(ctx.from.id);
        const user = await User.findOne({ userId: ctx.from.id });
        const today = new Date().toDateString();
        
        if (user && (!user.lastClaimed || user.lastClaimed.toDateString() !== today)) {
            user.matchLimit += 5;
            user.lastClaimed = new Date();
            await user.save();
            
            await ctx.answerCbQuery("✅ You received 5 bonus matches!", { show_alert: true });
            await ctx.reply(`🎁 <b>Daily Bonus Claimed!</b>\n\nYou received +5 matches.\n\n✨ Your balance: ${user.matchLimit} matches left.`, {
                parse_mode: 'HTML'
            });
        } else {
            await ctx.answerCbQuery("❌ You already claimed your daily bonus today!", { show_alert: true });
        }
    } catch (err) {
        console.error("Claim Bonus Error:", err);
        await ctx.answerCbQuery("Error claiming bonus. Please try again.");
    }
});

bot.hears('🔍 Find Partner', async (ctx) => {
    try {
        const userId = ctx.from.id;
        await updateLastActive(userId);
        const user = await User.findOne({ userId });

        if (!(await isSubscribed(userId))) {
            const buttons = CHANNELS.map(c => [Markup.button.url(`Join ${c}`, `https://t.me/${c.replace('@', '')}`)]);
            return ctx.reply(`⚠️ <b>Access Denied!</b>\nYou must join our channels to use this bot.`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('✅ I have Joined', 'check_sub')]])
            });
        }

        if (userId !== ADMIN_ID && user.matchLimit <= 0) {
            return ctx.reply('❌ <b>Your match limit is over!</b>\n\nClick the link below to visit, then click <b>Verify</b> to get 5 matches:', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Open Link 1', 'https://www.profitablecpmratenetwork.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'), Markup.button.callback('✅ Verify 1', 'verify_1')],
                    [Markup.button.url('🔗 Open Link 2', 'https://www.profitablecpmratenetwork.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'), Markup.button.callback('✅ Verify 2', 'verify_2')]
                ])
            });
        }

        const miniAppMsg = `🚀 <b>Ready to Find Your Match?</b>\n\n` +
                           `Start our <b>Mini App</b> experience with photo sharing and instant connection With strangers! ⚡\n\n` +
                           `👇 <b>Click the button below to start:</b>`;

        ctx.reply(miniAppMsg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🚀 Start Chat here', 'https://t.me/MakefriendsglobalBot/Letschat')]
            ])
        });

        console.log(`📲 [Redirect] User ${userId} redirected to Mini App`);

    } catch (err) { 
        console.error("Find Partner Error:", err); 
    }
});

bot.hears('📱 Random video chat app', async (ctx) => {
    await updateLastActive(ctx.from.id);
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
    await updateLastActive(userId);
    
    const isAdmin = userId === ADMIN_ID;
    const caption = ctx.message.caption || "";

    if (isAdmin && caption.startsWith('/broadcast')) {
        ctx.reply("⏳ Media Broadcast started in background...").catch(() => {});

        (async () => {
            try {
                let cleanCaption = caption.replace(/\/broadcast\s*/i, '').trim();
                const parts = cleanCaption.split('|');
                const finalCaption = parts[0].trim();
                const link = parts[1] ? parts[1].trim() : null;

                const allUsers = await User.find({});
                let count = 0;
                let failedCount = 0;

                for (const u of allUsers) {
                    try {
                        const extra = {
                            caption: finalCaption,
                            parse_mode: 'HTML'
                        };
                        
                        if (link) {
                            extra.reply_markup = {
                                inline_keyboard: [[{ text: '🚀 Open Link', url: link }]]
                            };
                        }
                        
                        const fileId = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id :
                                       ctx.message.video ? ctx.message.video.file_id :
                                       ctx.message.audio ? ctx.message.audio.file_id :
                                       ctx.message.document ? ctx.message.document.file_id :
                                       ctx.message.voice ? ctx.message.voice.file_id :
                                       ctx.message.video_note ? ctx.message.video_note.file_id : null;

                        if (ctx.message.photo) await bot.telegram.sendPhoto(u.userId, fileId, extra);
                        else if (ctx.message.video) await bot.telegram.sendVideo(u.userId, fileId, extra);
                        else if (ctx.message.voice) await bot.telegram.sendVoice(u.userId, fileId, extra);
                        else if (ctx.message.audio) await bot.telegram.sendAudio(u.userId, fileId, extra);
                        else if (ctx.message.document) await bot.telegram.sendDocument(u.userId, fileId, extra);
                        else await bot.telegram.copyMessage(u.userId, ctx.chat.id, ctx.message.message_id, extra);

                        count++;
                        if (count % 25 === 0) await new Promise(r => setTimeout(r, 1500));
                    } catch (e) { failedCount++; }
                }
                bot.telegram.sendMessage(ADMIN_ID, `✅ <b>Media Broadcast Finished!</b>\n\n🚀 Sent: ${count}\n❌ Failed: ${failedCount}`, { parse_mode: 'HTML' }).catch(() => {});
            } catch (err) { console.error("BG Media Broadcast Error:", err); }
        })();
        return;
    }

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
        
        await updateLastActive(userId);
        
        const isAdmin = userId === ADMIN_ID;

        if (text.startsWith('/broadcast') && isAdmin) {
            ctx.reply("⏳ Text Broadcast started in background...").catch(() => {});

            (async () => {
                try {
                    let cleanText = text.replace(/\/broadcast\s*/i, '').trim();
                    const parts = cleanText.split('|');
                    const msg = parts[0].trim();
                    const link = parts[1] ? parts[1].trim() : null;

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
                        } catch (e) { failedCount++; }
                    }
                    bot.telegram.sendMessage(ADMIN_ID, `✅ <b>Text Broadcast Finished!</b>\n\n🚀 Sent: ${count}\n❌ Failed: ${failedCount}`, { parse_mode: 'HTML' }).catch(() => {});
                } catch (err) { console.error("BG Text Broadcast Error:", err); }
            })();
            return;
        }

        if (BAD_WORDS.some(w => text.toLowerCase().includes(w))) {
            await ctx.deleteMessage().catch(()=>{});
            return ctx.reply(`🚫 Bad language is not allowed! Message deleted.`)
                .then(m => setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(()=>{}), 5000));
        }

        if (['🔍 Find Partner', '👤 My Status', '👫 Refer & Earn', '❌ Stop Chat', '❌ Stop Search', '/start', '📱 Random video chat app'].includes(text)) return next();

        if (!isAdmin) {
            if (/(https?:\/\/[^\s]+)|(www\.[^\s]+)|(t\.me\/[^\s]+)|(@[^\s]+)/gi.test(text)) {
                await ctx.deleteMessage().catch(()=>{});
                return ctx.reply('⚠️ Links not allowed!');
            }
        }

        const user = await User.findOne({ userId });
        if (user && user.status === 'chatting' && user.partnerId) {
            bot.telegram.sendMessage(user.partnerId, text)
                .catch(() => ctx.reply('⚠️ Partner left.'));
        }
    } catch (err) { console.error("Text Handler Error:", err); }
});

bot.hears('👫 Refer & Earn', async (ctx) => {
    try {
        await updateLastActive(ctx.from.id);
        const user = await User.findOne({ userId: ctx.from.id });
        
        if (!user) {
            return ctx.reply("❌ You are not registered yet. Please go to the bot's inbox and send /start.");
        }

        const refLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
        
        await ctx.replyWithHTML(
            `👫 <b>Referral Program</b>\n\n` +
            `🎁 Reward: +20 Matches per referral.\n` +
            `🔗 Link: ${refLink}\n` +
            `📊 Total Referrals: ${user.referrals || 0}`
        );
    } catch (e) {
        console.error(e);
        ctx.reply("Something went wrong. Please try again later.");
    }
});

bot.hears('👤 My Status', async (ctx) => {
    try {
        await updateLastActive(ctx.from.id);
        const user = await User.findOne({ userId: ctx.from.id });

        if (!user) {
            return ctx.reply("❌ You are not registered. Please send /start to register!");
        }

        const matchDisplay = (ctx.from.id === Number(ADMIN_ID)) ? 'Unlimited' : (user.matchLimit || 0);
        const referralCount = user.referrals || 0;

        await ctx.replyWithHTML(
            `👤 <b>Profile:</b>\n` +
            `━━━━━━━━━━━━━━\n` +
            `⚡ Matches Left: <b>${matchDisplay}</b>\n` +
            `👥 Referrals: <b>${referralCount}</b>`
        );
    } catch (error) {
        console.error("Status Error:", error);
        ctx.reply("⚠️ An error occurred while fetching your status.");
    }
});

bot.hears(['❌ Stop Chat', '❌ Stop Search'], async (ctx) => {
    await updateLastActive(ctx.from.id);
    const user = await User.findOne({ userId: ctx.from.id });
    const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize();
    if (user && user.partnerId) {
        await User.updateOne({ userId: user.partnerId }, { status: 'idle', partnerId: null });
        bot.telegram.sendMessage(user.partnerId, '❌ Partner ended the chat.', menu).catch(()=>{});
    }
    await User.updateOne({ userId: ctx.from.id }, { status: 'idle', partnerId: null });
    ctx.reply('❌ Stopped.', menu);
});

// --- Start Server ---
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
    
    // Memory monitoring
    setInterval(() => {
        const used = process.memoryUsage();
        console.log(`📊 [Memory] RSS: ${Math.round(used.rss / 1024 / 1024)}MB | Heap: ${Math.round(used.heapUsed / 1024 / 1024)}MB/${Math.round(used.heapTotal / 1024 / 1024)}MB`);
    }, 60000);
    
    // Inactivity checker (every 6 hours instead of 1 hour)
    setInterval(async () => {
        console.log("🔍 [Inactivity Checker] Running...");
        await checkInactiveUsers();
    }, 6 * 60 * 60 * 1000);
    
    setTimeout(() => {
        checkInactiveUsers();
    }, 5000);
    
    bot.launch();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Cleaning up...');
    await mongoose.disconnect();
    process.exit(0);
});
