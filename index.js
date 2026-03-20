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

// index.js এর ওপরের দিকে
let waitingUsers = [];

// --- Database Connection ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ [DB] Connected to MongoDB Successfully'))
    .catch(err => console.log('❌ [DB] Error:', err));

// --- User Model (Updated with missing fields and lastActive) ---
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
    hasReceivedReferralBonus: { type: Boolean, default: false },
    joinedChannel: { type: Boolean, default: false }, 
    lastSpin: { type: Date, default: null },          
    isVip: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },  // Added for inactivity tracking
    lastReminderSent: { type: Date, default: null }  // Track last reminder sent
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

// --- Function to update user's last active timestamp ---
async function updateLastActive(userId) {
    try {
        await User.updateOne(
            { userId: Number(userId) },
            { $set: { lastActive: new Date() } }
        );
    } catch (err) {
        console.error("Error updating last active:", err);
    }
}

// --- Function to check inactive users and send reminders every 24 hours ---
async function checkInactiveUsers() {
    try {
        const now = new Date();
        const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
        
        // Find users inactive for 24+ hours who haven't received a reminder in the last 24 hours
        const inactiveUsers = await User.find({
            lastActive: { $lt: twentyFourHoursAgo },
            $or: [
                { lastReminderSent: null },
                { lastReminderSent: { $lt: twentyFourHoursAgo } }
            ]
        });
        
        console.log(`📊 [Inactivity Check] Found ${inactiveUsers.length} inactive users`);
        
        for (const user of inactiveUsers) {
            try {
                // Skip admin
                if (user.userId === ADMIN_ID) continue;
                
                const hoursInactive = Math.floor((now - user.lastActive) / (60 * 60 * 1000));
                const daysInactive = Math.floor(hoursInactive / 24);
                
                let reminderMsg = '';
                
                if (daysInactive === 1) {
                    reminderMsg = `🔔 <b>Hey ${user.firstName || 'there'}! 👋</b>\n\n` +
                                 `We noticed you haven't used <b>MatchMe</b> in the last 24 hours.\n\n` +
                                 `✨ <b>Come back and connect with new people!</b>\n\n` +
                                 `👉 <b>Your balance:</b> ${user.userId === ADMIN_ID ? 'Unlimited' : user.matchLimit} matches remaining\n\n` +
                                 `🚀 <b>Start chatting now:</b>`;
                } else if (daysInactive === 2) {
                    reminderMsg = `⚠️ <b>${user.firstName || 'There'}! We Miss You! 💔</b>\n\n` +
                                 `It's been <b>2 days</b> since your last visit to <b>MatchMe</b>.\n\n` +
                                 `🎁 <b>Special Reminder:</b> You have <b>${user.matchLimit}</b> matches waiting for you!\n\n` +
                                 `👥 New people are waiting to connect with you!\n\n` +
                                 `👇 <b>Tap below to start chatting:</b>`;
                } else if (daysInactive >= 3) {
                    reminderMsg = `🚨 <b>URGENT: ${user.firstName || 'Friend'}! Don't Miss Out! 🚨</b>\n\n` +
                                 `It's been <b>${daysInactive} days</b> since you last used <b>MatchMe</b>!\n\n` +
                                 `🔥 <b>Your Current Stats:</b>\n` +
                                 `• ${user.matchLimit} matches available\n` +
                                 `• ${user.referrals || 0} successful referrals\n\n` +
                                 `💝 <b>Special Offer:</b> Come back today and get <b>BONUS MATCHES</b>!\n\n` +
                                 `⭐ Don't let your matches go to waste!\n\n` +
                                 `👇 <b>Start matching NOW:</b>`;
                } else {
                    reminderMsg = `🔔 <b>Hey ${user.firstName || 'there'}! 👋</b>\n\n` +
                                 `We noticed you haven't used <b>MatchMe</b> recently.\n\n` +
                                 `✨ <b>Come back and connect with new people!</b>\n\n` +
                                 `👉 <b>Your balance:</b> ${user.userId === ADMIN_ID ? 'Unlimited' : user.matchLimit} matches remaining\n\n` +
                                 `🚀 <b>Start chatting now:</b>`;
                }
                
                await bot.telegram.sendMessage(user.userId, reminderMsg, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.url('🎯 Start Chat Now', 'https://t.me/MakefriendsglobalBot/Letschat')],
                        [Markup.button.callback('💰 Claim Daily Bonus', 'claim_bonus')]
                    ])
                });
                
                // Update reminder sent time
                await User.updateOne(
                    { userId: user.userId },
                    { $set: { lastReminderSent: new Date() } }
                );
                
                console.log(`📨 [Reminder Sent] To user: ${user.userId} | Inactive: ${hoursInactive}h (${daysInactive} days)`);
                
                // Add delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (err) {
                console.error(`❌ [Reminder Failed] User ${user.userId}:`, err.message);
                
                // If user blocked the bot, log it
                if (err.message.includes('bot was blocked by the user')) {
                    console.log(`🚫 [Blocked] User ${user.userId} blocked the bot`);
                }
            }
        }
        
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
    
    // Update last active when user joins web app
    await updateLastActive(userId);
    
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
            // Update last active
            await updateLastActive(userId);
            
            const user = await User.findOneAndUpdate(
                { userId: Number(userId) },
                { $inc: { matchLimit: 15 } },
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
        // Update last active
        await updateLastActive(userId);
        
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

    socket.on('cancel_search', async (userId) => {
    try {
        if (!userId) return;
        
        // Update last active
        await updateLastActive(userId);

        // অ্যারে থেকে ইউজারকে সরিয়ে ফেলা
        waitingUsers = waitingUsers.filter(u => u.userId !== userId);

        // ডাটাবেসে স্ট্যাটাস 'idle' করে দেওয়া যাতে অন্য কেউ তাকে খুঁজে না পায়
        await User.updateOne(
            { userId: Number(userId) }, 
            { $set: { webStatus: 'idle' } }
        );

        console.log(`🛑 [Search Cancelled] User: ${userId}`);
    } catch (err) {
        console.error("Cancel Search Error:", err);
    }
});

    // --- Added Lucky Spin Logic ---
    socket.on('lucky_spin', async (userId) => {
        // Update last active
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

    // --- Added Social Task Logic ---
    socket.on('social_task', async (userId) => {
        // Update last active
        await updateLastActive(userId);
        
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
    // Update last active
    await updateLastActive(userId);
    
    // --- ছোট পরিবর্তন: ডুপ্লিকেট এড়াতে আগে মুছে নিয়ে তারপর পুশ করা ---
    waitingUsers = waitingUsers.filter(u => u.userId !== userId);
    waitingUsers.push({ userId, socketId: socket.id });

    try {
        const user = await User.findOne({ userId: Number(userId) });
        if (!user) return;

        // লিমিট চেক
        if (user.userId !== ADMIN_ID && user.matchLimit <= 0) {
            console.log(`🚫 [Web] Match limit over for: ${userId}`);
            // লিমিট শেষ হলে ওয়েটিং লিস্ট থেকে সরিয়ে দেওয়া ভালো
            waitingUsers = waitingUsers.filter(u => u.userId !== userId);
            return io.to(socket.id).emit('limit_over');
        }

        // স্ট্যাটাস আপডেট
        await User.updateOne({ userId: Number(userId) }, { webStatus: 'searching', webSocketId: socket.id });

        // পার্টনার খোঁজা
        const partner = await User.findOneAndUpdate(
            { userId: { $ne: Number(userId) }, webStatus: 'searching', webSocketId: { $ne: null } },
            { webStatus: 'chatting', webPartnerId: Number(userId) },
            { new: true }
        );

        if (partner) {
            // ম্যাচ হলে দুজনকে ওয়েটিং লিস্ট থেকে সরিয়ে দিন
            waitingUsers = waitingUsers.filter(u => u.userId !== userId && u.userId !== partner.userId);

            await User.updateOne({ userId: Number(userId) }, { webStatus: 'chatting', webPartnerId: partner.userId });

            // লিমিট কমানো
            if (user.userId !== ADMIN_ID) await User.updateOne({ userId: user.userId }, { $inc: { matchLimit: -1 } });
            if (partner.userId !== ADMIN_ID) await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });

            // ফ্রন্টেন্ডে জানানো
            io.to(socket.id).emit('match_found');
            io.to(partner.webSocketId).emit('match_found');

            console.log(`🤝 [Web Match] ${userId} matched with ${partner.userId}`);
        }
    } catch (err) { 
        console.error("Web Match Error:", err); 
    }
});
    socket.on('send_msg', async (data) => {
        const { senderId, text, image } = data; 
        
        // Update last active for sender
        await updateLastActive(senderId);
        
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
            // Update last active on disconnect
            await updateLastActive(user.userId);
            
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
        
        // Update last active on /start
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
    // Update last active
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
        // Update last active
        await updateLastActive(ctx.from.id);
        
        await User.updateOne({ userId: ctx.from.id }, { $inc: { matchLimit: 5 } });
        ctx.answerCbQuery("✅ Success! You received 5 matches.", { show_alert: true });
        await ctx.deleteMessage().catch(()=>{});
        ctx.reply("🎁 5 matches added! You can now search for a partner again.");
    } catch (err) { console.error("Verify Action Error:", err); }
});

// Add claim bonus action
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
        
        // Update last active
        await updateLastActive(userId);
        
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
                    [Markup.button.url('🔗 Open Link 1', 'https://www.profitableratecpm.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'), Markup.button.callback('✅ Verify 1', 'verify_1')],
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
                [Markup.button.url('🚀 Start Chat here', 'https://t.me/MakefriendsglobalBot/Letschat')]
            ])
        });

        console.log(`📲 [Redirect] User ${userId} redirected to Mini App`);

    } catch (err) { 
        console.error("Find Partner Error:", err); 
    }
});

bot.hears('📱 Random video chat app', async (ctx) => {
    // Update last active
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
    
    // Update last active
    await updateLastActive(userId);
    
    const isAdmin = userId === ADMIN_ID;
    const caption = ctx.message.caption || "";

    // --- ১. মিডিয়া ব্রডকাস্ট লজিক (কমান্ড ও লিঙ্ক ট্রিম করা হয়েছে) ---
    if (isAdmin && caption.startsWith('/broadcast')) {
        ctx.reply("⏳ Media Broadcast started in background...").catch(() => {});

        (async () => {
            try {
                // কমান্ড রিমুভ এবং পাইপ দিয়ে লিঙ্ক আলাদা করা
                let cleanCaption = caption.replace(/\/broadcast\s*/i, '').trim();
                const parts = cleanCaption.split('|');
                const finalCaption = parts[0].trim(); // শুধু আসল মেসেজ
                const link = parts[1] ? parts[1].trim() : null; // শুধু লিঙ্ক

                const allUsers = await User.find({});
                let count = 0;
                let failedCount = 0;

                for (const u of allUsers) {
                    try {
                        const extra = {
                            caption: finalCaption, // এখানে ফ্রেশ ক্যাপশন সেট করা হয়েছে
                            parse_mode: 'HTML'
                        };
                        
                        if (link) {
                            extra.reply_markup = {
                                inline_keyboard: [[{ text: '🚀 Open Link', url: link }]]
                            };
                        }
                        
                        // copyMessage এর বদলে অরিজিনাল ফাইল আইডি দিয়ে নতুন করে পাঠানো হচ্ছে যাতে পুরোনো ক্যাপশন না যায়
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
        
        // Update last active
        await updateLastActive(userId);
        
        const isAdmin = userId === ADMIN_ID;

        // --- ১. ব্রডকাস্ট লজিক (কমান্ড ও লিঙ্ক ট্রিম করা হয়েছে) ---
        if (text.startsWith('/broadcast') && isAdmin) {
            ctx.reply("⏳ Text Broadcast started in background...").catch(() => {});

            (async () => {
                try {
                    // কমান্ড (/broadcast) রিমুভ করা
                    let cleanText = text.replace(/\/broadcast\s*/i, '').trim();
                    
                    // পাইপ (|) দিয়ে টেক্সট আর লিঙ্ক আলাদা করা
                    const parts = cleanText.split('|');
                    const msg = parts[0].trim(); // আসল মেসেজ
                    const link = parts[1] ? parts[1].trim() : null; // লিঙ্ক

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
    } catch (err) { console.error("Text Handler Error:", err); }
});

bot.hears('👫 Refer & Earn', async (ctx) => {
    try {
        // Update last active
        await updateLastActive(ctx.from.id);
        
        const user = await User.findOne({ userId: ctx.from.id });
        
        // --- এই অংশটুকু অ্যাড করা হয়েছে ক্র্যাশ বন্ধ করতে ---
        if (!user) {
            return ctx.reply("❌ You are not registered yet. Please go to the bot's inbox and send /start.");
        }
        // -------------------------------------------

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
        // Update last active
        await updateLastActive(ctx.from.id);
        
        const user = await User.findOne({ userId: ctx.from.id });

        // যদি ইউজার ডাটাবেজে না থাকে
        if (!user) {
            return ctx.reply("❌ You are not registered. Please send /start to register!");
        }

        // অ্যাডমিন চেক এবং প্রোফাইল ডিটেইলস
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
    // Update last active
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
    
    // --- Start inactivity checker (runs every hour) ---
    setInterval(async () => {
        console.log("🔍 [Inactivity Checker] Running check...");
        await checkInactiveUsers();
    }, 60 * 60 * 1000); // Check every hour
    
    // Run initial check after 5 seconds
    setTimeout(() => {
        checkInactiveUsers();
    }, 5000);
    
    bot.launch();
});
