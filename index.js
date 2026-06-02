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

// --- User Model (Updated with missing fields + Profile Fields) ---
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
    // Missing Fields Added
    joinedChannel: { type: Boolean, default: false }, 
    lastSpin: { type: Date, default: null },          
    isVip: { type: Boolean, default: false },
    // ✅ Profile Fields Added (Database te save hobe)
    profileName: { type: String, default: 'Anonymous' },
    profileAge: { type: String, default: '25' },
    profileGender: { type: String, default: 'male' },
    lastSeen: { type: Date, default: Date.now } // Track last interaction
}));

// --- Inactive User Cleanup Function ---
async function cleanupInactiveUsers() {
    console.log('🧹 [Cleanup] Starting inactive user cleanup...');
    
    try {
        // Get all users from database
        const allUsers = await User.find({});
        let removedCount = 0;
        let errorCount = 0;
        let keptCount = 0;
        
        console.log(`📊 [Cleanup] Total users in database: ${allUsers.length}`);
        
        for (const user of allUsers) {
            try {
                // Try to send a silent test message to check if user is reachable
                await bot.telegram.sendChatAction(user.userId, 'typing');
                keptCount++;
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 50));
                
            } catch (error) {
                if (error.response && error.response.error_code) {
                    const errorCode = error.response.error_code;
                    const errorDesc = error.response.description || '';
                    
                    // These error codes mean user is permanently unreachable
                    if (errorCode === 403 || // Bot was blocked by user
                        errorCode === 400 && (errorDesc.includes('chat not found') || 
                        errorDesc.includes('user not found') ||
                        errorDesc.includes('bot was blocked') ||
                        errorDesc.includes('PEER_ID_INVALID'))) {
                        
                        // Delete the user from database
                        await User.deleteOne({ _id: user._id });
                        removedCount++;
                        console.log(`🗑️ [Cleanup] Removed inactive user: ${user.userId} (${user.firstName || 'Unknown'}) - Reason: ${errorDesc || errorCode}`);
                    } else {
                        // Other errors like rate limiting - just log but keep user
                        console.log(`⚠️ [Cleanup] Temporary error for user ${user.userId}: ${errorCode} - ${errorDesc}`);
                        errorCount++;
                    }
                }
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log(`✅ [Cleanup] Cleanup completed! Removed: ${removedCount}, Kept: ${keptCount}, Errors: ${errorCount}, Remaining: ${allUsers.length - removedCount}`);
        
        // Notify admin about cleanup
        if (ADMIN_ID && removedCount > 0) {
            await bot.telegram.sendMessage(
                ADMIN_ID,
                `🧹 <b>User Cleanup Completed</b>\n\n` +
                `✅ Removed: <b>${removedCount}</b> inactive users\n` +
                `📊 Remaining: <b>${allUsers.length - removedCount}</b> users\n` +
                `👥 Active: <b>${keptCount}</b>\n` +
                `⚠️ Errors: <b>${errorCount}</b>\n\n` +
                `<i>Users who blocked the bot or deleted their accounts have been removed.</i>`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
        
    } catch (err) {
        console.error('❌ [Cleanup] Error during cleanup:', err);
    }
}

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
            
            // If user is not found or bot can't check, consider them not subscribed
            if (e.response && e.response.error_code === 400 && 
                (e.response.description.includes('user not found') || 
                 e.response.description.includes('chat not found'))) {
                // Optionally mark user for cleanup
                setTimeout(() => {
                    User.deleteOne({ userId: userId }).catch(() => {});
                }, 1000);
                return false;
            }
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
        { webSocketId: socket.id, webStatus: 'idle', webPartnerId: null, lastSeen: new Date() }, 
        { upsert: true, new: true }
    );
    console.log(`👤 [Web] User ${userId} joined via socket ${socket.id}`);
    socket.emit('user_data', { limit: user.matchLimit || 0 });
});

    // ✅ UPDATED: reward_user with custom amount support (for 50 matches bonus)
    socket.on('reward_user', async (userId, customAmount = null) => {
        try {
            const amount = customAmount || 15;
            const user = await User.findOneAndUpdate(
                { userId: Number(userId) },
                { $inc: { matchLimit: amount } },
                { new: true }
            );
            console.log(`🏠 [Reward Success] User ${userId} received ${amount} matches. New balance: ${user.matchLimit}`);
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

    socket.on('cancel_search', async (userId) => {
    try {
        if (!userId) return;

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

    // ✅ Profile Save Handler (Database e Profile Update)
    socket.on('save_profile', async (data) => {
        try {
            const { userId, profile } = data;
            if (!userId || !profile) return;

            const user = await User.findOneAndUpdate(
                { userId: Number(userId) },
                { 
                    $set: { 
                        profileName: profile.name || 'Anonymous',
                        profileAge: profile.age || '25',
                        profileGender: profile.gender || 'male'
                    } 
                },
                { new: true }
            );

            if (user) {
                console.log(`💾 [Profile Saved] User: ${userId} -> Name: ${profile.name}, Age: ${profile.age}, Gender: ${profile.gender}`);
                socket.emit('profile_saved_confirmation', { success: true });
            }
        } catch (err) {
            console.error("Profile Save Error:", err);
        }
    });

    socket.on('find_partner_web', async (userId) => {
    // --- ছোট পরিবর্তন: ডুপ্লিকেট এড়াতে আগে মুছে তারপর পুশ করা ---
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

            // ফ্রন্টেন্ডে জানানো - সাথে পার্টনারের প্রোফাইল তথ্য পাঠানো হচ্ছে
            io.to(socket.id).emit('match_found', { 
                partnerId: partner.userId,
                partnerName: partner.profileName || 'Stranger',
                partnerGender: partner.profileGender || 'male'
            });
            
            io.to(partner.webSocketId).emit('match_found', { 
                partnerId: user.userId,
                partnerName: user.profileName || 'Stranger',
                partnerGender: user.profileGender || 'male'
            });

            console.log(`🤝 [Web Match] ${userId} matched with ${partner.userId}`);
        }
    } catch (err) { 
        console.error("Web Match Error:", err); 
    }
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
            user = new User({ 
                userId, 
                firstName: ctx.from.first_name, 
                matchLimit: 20, 
                hasReceivedReferralBonus: !!startPayload,
                // Default Profile Values
                profileName: 'Anonymous',
                profileAge: '25',
                profileGender: 'male',
                lastSeen: new Date()
            });
            await user.save();
        } else if (startPayload && !user.hasReceivedReferralBonus) {
            await User.updateOne({ userId }, { hasReceivedReferralBonus: true, lastSeen: new Date() });
        } else {
            await User.updateOne({ userId }, { lastSeen: new Date() });
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
                    [Markup.button.url('🔗 Open Link 1', 'https://www.profitableratecpm.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'), Markup.button.callback('✅ Verify 1', 'verify_1')],
                    [Markup.button.url('🔗 Open Link 2', 'https://www.profitableratecpm.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'), Markup.button.callback('✅ Verify 2', 'verify_2')]
                ])
            });
        }

        // Update last seen
        await User.updateOne({ userId }, { lastSeen: new Date() });

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
        const isAdmin = userId === ADMIN_ID;

        // Update last seen
        await User.updateOne({ userId }, { lastSeen: new Date() });

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
    const user = await User.findOne({ userId: ctx.from.id });
    const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize();
    if (user && user.partnerId) {
        await User.updateOne({ userId: user.partnerId }, { status: 'idle', partnerId: null });
        bot.telegram.sendMessage(user.partnerId, '❌ Partner ended the chat.', menu).catch(()=>{});
    }
    await User.updateOne({ userId: ctx.from.id }, { status: 'idle', partnerId: null });
    ctx.reply('❌ Stopped.', menu);
});

// --- Admin Commands for Cleanup ---
bot.command('cleanup', async (ctx) => {
    // Only allow admin to run this command
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply('❌ You are not authorized to use this command.');
    }
    
    await ctx.reply('🧹 Starting manual user cleanup... This may take a few minutes.');
    
    // Run cleanup in background
    cleanupInactiveUsers().then(() => {
        ctx.reply('✅ Cleanup completed! Check your DMs for the full report.').catch(() => {});
    }).catch((err) => {
        ctx.reply('❌ Cleanup failed. Check console for errors.').catch(() => {});
    });
});

bot.command('stats', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply('❌ Unauthorized');
    }
    
    try {
        const totalUsers = await User.countDocuments({});
        const usersWithPartners = await User.countDocuments({ partnerId: { $ne: null } });
        const usersChatting = await User.countDocuments({ status: 'chatting' });
        const webUsers = await User.countDocuments({ webSocketId: { $ne: null } });
        
        // Calculate users inactive for more than 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const inactiveUsers = await User.countDocuments({ lastSeen: { $lt: thirtyDaysAgo } });
        
        const msg = `📊 <b>Database Statistics</b>\n\n` +
                   `👥 Total Users: <b>${totalUsers}</b>\n` +
                   `💬 Active Chats: <b>${usersChatting}</b>\n` +
                   `🤝 Users in Match: <b>${usersWithPartners}</b>\n` +
                   `📱 Web Users: <b>${webUsers}</b>\n` +
                   `⏰ Inactive (30d+): <b>${inactiveUsers}</b>\n\n` +
                   `<i>Run /cleanup to remove inactive users</i>`;
        
        await ctx.replyWithHTML(msg);
    } catch (err) {
        console.error(err);
        ctx.reply('❌ Error fetching statistics');
    }
});

// --- Start Cleanup Schedule ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 [Server] System Live on port ${PORT}`);
    
    // Run initial cleanup after 10 seconds
    setTimeout(() => {
        cleanupInactiveUsers();
    }, 10000);
    
    // Schedule cleanup every 24 hours
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
    setInterval(cleanupInactiveUsers, CLEANUP_INTERVAL);
    
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
