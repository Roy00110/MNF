const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); // যোগ করা হয়েছে
const { Server } = require('socket.io'); // যোগ করা হয়েছে
const path = require('path'); // যোগ করা হয়েছে

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI; 
const ADMIN_ID = Number(process.env.ADMIN_ID); 

const bot = new Telegraf(BOT_TOKEN);

// Database Connection
mongoose.connect(MONGO_URI).then(() => console.log('✅ Connected to MongoDB')).catch(err => console.log('❌ DB Error:', err));

// User Model (আপনার অরিজিনাল ফিল্ডগুলো ঠিক রাখা হয়েছে)
const User = mongoose.model('User', new mongoose.Schema({
    userId: { type: Number, unique: true },
    firstName: String,
    partnerId: { type: Number, default: null },
    status: { type: String, default: 'idle' },
    matchLimit: { type: Number, default: 10 },
    referrals: { type: Number, default: 0 },
    lastClaimed: { type: Date, default: null },
    // ওয়েবসাইটের জন্য আলাদা স্ট্যাটাস
    webStatus: { type: String, default: 'idle' },
    webPartnerId: { type: Number, default: null },
    webSocketId: { type: String, default: null }
}));

// --- ওয়েবসাইট সার্ভার ও সকেট লজিক (বট থেকে সম্পূর্ণ আলাদা) ---
// --- ওয়েবসাইট সার্ভার ও সকেট লজিক (Updated & Fixed) ---
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    console.log('🌐 New Web Connection:', socket.id);

   socket.on('join', async (userId) => {
        if (!userId) return;
        
        // ইউজার জয়েন করলে তার আইডি আপডেট হবে কিন্তু স্ট্যাটাস 'idle' হয়ে যাবে
        // এর ফলে আপনি নিজে 'Start Searching' এ ক্লিক না করা পর্যন্ত কেউ আপনাকে পাবে না
        await User.findOneAndUpdate(
            { userId: Number(userId) }, 
            { 
                webSocketId: socket.id, 
                webStatus: 'idle', // নতুন করে জয়েন করলে স্ট্যাটাস ক্লিয়ার
                webPartnerId: null 
            }, 
            { upsert: true }
        );
        console.log(`👤 User ${userId} is now online (Idle)`);
    });

    socket.on('leave_chat', async (userId) => {
        const user = await User.findOne({ userId: Number(userId) });
        if (user && user.webPartnerId) {
            const partner = await User.findOne({ userId: user.webPartnerId });
            if (partner && partner.webSocketId) {
                io.to(partner.webSocketId).emit('chat_ended'); // পার্টনারকে জানানো
            }
            // ডাটাবেস আপডেট
            await User.updateOne({ userId: user.userId }, { webStatus: 'idle', webPartnerId: null });
            await User.updateOne({ userId: partner.userId }, { webStatus: 'idle', webPartnerId: null });
        }
    });

    socket.on('find_partner_web', async (userId) => {
    try {
        const user = await User.findOne({ userId: Number(userId) });
        const isAdmin = user.userId === ADMIN_ID;

        // ১. লিমিট চেক করা (এডমিন বাদে)
        if (!isAdmin && user.matchLimit <= 0) {
            // বটের মাধ্যমে রেফারেল মেসেজ পাঠানো
            const refLink = `https://t.me/${bot.botInfo.username}?start=${user.userId}`;
            bot.telegram.sendMessage(user.userId, 
                `❌ <b>Your match limit is over!</b>\n\nInvite friends to get more matches.\n🔗 ${refLink}`, 
                { parse_mode: 'HTML' }
            ).catch(e => {});

            // ওয়েব অ্যাপে এলার্ট পাঠানো
            return io.to(socket.id).emit('limit_over');
        }

        // ২. সার্চিং স্ট্যাটাস আপডেট
        await User.updateOne({ userId: Number(userId) }, { webStatus: 'searching', webSocketId: socket.id });

        // ৩. পার্টনার খোঁজা
        const partner = await User.findOne({ 
            userId: { $ne: Number(userId) }, 
            webStatus: 'searching',
            webSocketId: { $ne: null } 
        });

        if (partner && partner.webSocketId) {
            // ৪. লিমিট কমানো (এডমিন বাদে)
            if (!isAdmin) await User.updateOne({ userId: user.userId }, { $inc: { matchLimit: -1 } });
            if (partner.userId !== ADMIN_ID) await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });

            // ৫. স্ট্যাটাস আপডেট (Chatting)
            await User.updateOne({ userId: user.userId }, { webStatus: 'chatting', webPartnerId: partner.userId });
            await User.updateOne({ userId: partner.userId }, { webStatus: 'chatting', webPartnerId: user.userId });

            io.to(socket.id).emit('match_found');
            io.to(partner.webSocketId).emit('match_found');
        }
    } catch (err) {
        console.error("Web Match Error:", err);
    }
});

socket.on('send_msg', async (data) => {
    const { senderId, text, image } = data; 
    try {
        const user = await User.findOne({ userId: Number(senderId) });
        
        if (user && user.webPartnerId) {
            const partner = await User.findOne({ userId: user.webPartnerId });
            if (partner && partner.webSocketId) {
                // এখানে text অথবা image যা আসবে তাই পার্টনারের কাছে চলে যাবে
                io.to(partner.webSocketId).emit('receive_msg', { 
                    text: text || null, 
                    image: image || null 
                });
            }
        }
    } catch (err) {
        console.error("Web Send Msg Error:", err);
    }
});

    // index.js এর ভেতর এই ডিসকানেক্ট লজিকটি দিন
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
            // নিজের আইডি ক্লিন করা
            await User.updateOne({ userId: user.userId }, { webSocketId: null, webStatus: 'idle', webPartnerId: null });
        }
    } catch (err) { console.error("Disconnect Error:", err); }
});
});

// --- টেলিগ্রাম বট লজিক (আপনার অরিজিনাল কোড যা আপনি দিয়েছেন) ---

bot.start(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const startPayload = ctx.payload;
        let user = await User.findOne({ userId });

        if (!user) {
            console.log(`🆕 [NEW USER] ${ctx.from.first_name} (ID: ${userId}) joined.`);
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
        
        const welcomeMsg = `👋 <b>Welcome to Secret Dating Bot!</b>\n\n🎁 Your Balance: ${userId === ADMIN_ID ? 'Unlimited' : user.matchLimit + ' Matches'} left.`;
        
        ctx.reply(welcomeMsg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🚀 miniapp', 'https://t.me/RandomChatting18_Bot/MeetRandom')]
            ]),
            ...Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize()
        });
    } catch (err) { console.error("Start Error:", err); }
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
                    [
                        Markup.button.url('🔗 Open Link 1', 'https://otieu.com/4/9382477'),
                        Markup.button.callback('✅ Verify 1', 'verify_1')
                    ],
                    [
                        Markup.button.url('🔗 Open Link 2', 'https://www.profitableratecpm.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'),
                        Markup.button.callback('✅ Verify 2', 'verify_2')
                    ]
                ])
            });
        }

        if (user.status === 'chatting') return ctx.reply('❌ Already in a chat!');
        await User.updateOne({ userId }, { status: 'searching' });
        
        ctx.reply(`🔎 Searching for a partner...`, Markup.keyboard([
            ['❌ Stop Search'],
            ['👤 My Status', '👫 Refer & Earn']
        ]).resize());

        const partner = await User.findOne({ userId: { $ne: userId }, status: 'searching' });
        if (partner) {
            if (!isAdmin) await User.updateOne({ userId }, { $inc: { matchLimit: -1 } });
            if (partner.userId !== ADMIN_ID) await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });
            await User.updateOne({ userId }, { status: 'chatting', partnerId: partner.userId });
            await User.updateOne({ userId: partner.userId }, { status: 'chatting', partnerId: userId });
            
            console.log(`✅ [CONNECTION] ${ctx.from.first_name} <--> ${partner.firstName}`);
            const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize();
            ctx.reply('✅ Partner found! Start chatting...', menu);
            bot.telegram.sendMessage(partner.userId, '✅ Partner found! Start chatting...', menu).catch(e => {});
        }
    } catch (err) { console.error("Match Error:", err); }
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
        ctx.editMessageText('🎉 <b>Bonus Added!</b> You got +5 matches. You can use these links again tomorrow.', { parse_mode: 'HTML' });
    } catch (err) { console.error("Verify Error:", err); }
});

bot.on('text', async (ctx, next) => {
    try {
        const text = ctx.message.text;
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID;
        const user = await User.findOne({ userId });

        if (!user) return;

        if (text.startsWith('/broadcast ') && isAdmin) {
            const msg = text.replace('/broadcast ', '').trim();
            const all = await User.find({});
            all.forEach(u => bot.telegram.sendMessage(u.userId, msg).catch(e => {}));
            return ctx.reply('✅ Broadcast sent.');
        }

        if (['🔍 Find Partner', '👤 My Status', '👫 Refer & Earn', '❌ Stop Chat', '❌ Stop Search', '/start'].includes(text)) return next();

        if (!isAdmin) {
            const filter = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(t\.me\/[^\s]+)|(@[^\s]+)/gi;
            if (filter.test(text)) return ctx.reply('⚠️ Links and @usernames are blocked!');
        }

        if (user.status === 'chatting' && user.partnerId) {
            bot.telegram.sendMessage(user.partnerId, text).catch(e => ctx.reply('⚠️ Partner left.'));
        }
    } catch (err) { console.error("Text Error:", err); }
});

// মিডিয়া হ্যান্ডলার আপনার অরিজিনাল কোড অনুযায়ী
bot.on(['photo', 'video', 'sticker', 'voice', 'audio'], async (ctx) => {
    try {
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID;
        const user = await User.findOne({ userId });
        const caption = ctx.message.caption || "";
        if (isAdmin && caption.startsWith('/broadcast')) {
            const cleanCaption = caption.replace('/broadcast', '').trim();
            const all = await User.find({});
            all.forEach(u => ctx.copyMessage(u.userId, { caption: cleanCaption }).catch(e => {}));
            return ctx.reply('✅ Media Broadcast sent.');
        }
        if (isAdmin && user && user.status === 'chatting' && user.partnerId) {
            return ctx.copyMessage(user.partnerId);
        }
        ctx.reply('⚠️ Only text messages are allowed!');
    } catch (err) { console.error("Media Error:", err); }
});

bot.hears('👫 Refer & Earn', async (ctx) => {
    try {
        const user = await User.findOne({ userId: ctx.from.id });
        const refLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
        const msg = `👫 <b>Referral Program</b>\n\nInvite your friends to use this bot and earn rewards!\n\n🎁 <b>Reward:</b> Get <b>+20 Matches</b> for each friend who joins using your link.\n\n🔗 <b>Your Invite Link:</b>\n${refLink}\n\n📊 <b>Your Stats:</b>\n• Total Referrals: ${user.referrals || 0}\n• Total Earned Matches: ${(user.referrals || 0) * 20}`;
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) { console.error("Referral Error:", err); }
});

bot.hears('👤 My Status', async (ctx) => {
    try {
        const user = await User.findOne({ userId: ctx.from.id });
        const statusMsg = `👤 <b>Profile:</b>\nName: ${user.firstName}\nMatches Left: ${ctx.from.id === ADMIN_ID ? 'Unlimited' : (user.matchLimit || 0)}\nTotal Referrals: ${user.referrals || 0}`;
        ctx.reply(statusMsg, { parse_mode: 'HTML' });
    } catch (err) { console.error("Status Error:", err); }
});

bot.hears('❌ Stop Chat', async (ctx) => {
    try {
        const user = await User.findOne({ userId: ctx.from.id });
        const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize();
        if (user && user.partnerId) {
            await User.updateOne({ userId: user.partnerId }, { status: 'idle', partnerId: null });
            bot.telegram.sendMessage(user.partnerId, '❌ Partner ended the chat.', menu).catch(e => {});
        }
        await User.updateOne({ userId: ctx.from.id }, { status: 'idle', partnerId: null });
        ctx.reply('❌ Chat ended.', menu);
    } catch (err) { console.error("StopChat Error:", err); }
});

bot.hears('❌ Stop Search', async (ctx) => {
    try {
        await User.updateOne({ userId: ctx.from.id }, { status: 'idle' });
        const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize();
        ctx.reply('🔍 Search stopped.', menu);
    } catch (err) { console.error("StopSearch Error:", err); }
});



const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server Live`);
// আপনার গ্রুপের ID এখানে দিন (যেমন: -100123456789)
const GROUP_ID = -1002461999862; // আপনার আসল গ্রুপ আইডি দিন

let lastAutoMsgId = null;

async function sendAutoPromo() {
    try {
        if (lastAutoMsgId) {
            await bot.telegram.deleteMessage(GROUP_ID, lastAutoMsgId).catch(e => {});
        }

        // আকর্ষণীয় ইংলিশ টেক্সট
        const promoMsg = `✨ <b>Connect Anonymously & Chat Live!</b> ✨\n\n` +
                         `Looking for someone to talk to? Meet random people instantly with our <b>Secret Meet</b> Mini App. No registration required! 🎭\n\n` +
                         `✅ <b>100% Private & Anonymous</b>\n` +
                         `✅ <b>Real-time Photo Sharing</b>\n` +
                         `✅ <b>Fast Matching</b>\n\n` +
                         `🚀 <b>Start your conversation now:</b>`;
        
        const sentMsg = await bot.telegram.sendMessage(GROUP_ID, promoMsg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🚀 Launch Mini App', 'https://t.me/MakefriendsglobalBot/Letschat')]
            ])
        });

        lastAutoMsgId = sentMsg.message_id;

    } catch (err) {
        console.error("Auto Post Error:", err);
    }
}

// প্রতি ৩০ মিনিট পর পর মেসেজ পাঠাবে (১৮০০০০০ মিলিসেকেন্ড = ৩০ মিনিট)
// আপনি সময় কমাতে চাইলে ১৮০০০০০ পরিবর্তন করতে পারেন
setInterval(sendAutoPromo, 500000); 

// বোট চালু হওয়ার সাথে সাথে প্রথম মেসেজ পাঠাতে চাইলে এটি কল করুন
sendAutoPromo();
    
    bot.launch();
});










