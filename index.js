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

// --- ওয়েবসাইট সার্ভার ও সকেট লজিক ---
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    console.log('🌐 New Web Connection:', socket.id);

   socket.on('join', async (userId) => {
        if (!userId) return;
        await User.findOneAndUpdate(
            { userId: Number(userId) }, 
            { webSocketId: socket.id, webStatus: 'idle', webPartnerId: null }, 
            { upsert: true }
        );
        console.log(`👤 User ${userId} is now online (Idle)`);
    });

    socket.on('leave_chat', async (userId) => {
        const user = await User.findOne({ userId: Number(userId) });
        if (user && user.webPartnerId) {
            const partner = await User.findOne({ userId: user.webPartnerId });
            if (partner && partner.webSocketId) {
                io.to(partner.webSocketId).emit('chat_ended');
            }
            await User.updateOne({ userId: user.userId }, { webStatus: 'idle', webPartnerId: null });
            await User.updateOne({ userId: partner.userId }, { webStatus: 'idle', webPartnerId: null });
        }
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

            const partner = await User.findOne({ 
                userId: { $ne: Number(userId) }, 
                webStatus: 'searching',
                webSocketId: { $ne: null } 
            });

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
        try {
            const user = await User.findOne({ userId: Number(senderId) });
            if (user && user.webPartnerId) {
                const partner = await User.findOne({ userId: user.webPartnerId });
                if (partner && partner.webSocketId) {
                    io.to(partner.webSocketId).emit('receive_msg', { text: text || null, image: image || null });
                }
            }
        } catch (err) { console.error("Web Send Msg Error:", err); }
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
        } catch (err) { console.error("Disconnect Error:", err); }
    });
});

// --- টেলিগ্রাম বট লজিক ---

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
        
        const welcomeMsg = `👋 <b>Welcome to MatchMe 💌</b>\n\n` +
                           `🎁 <b>Your Balance:</b> ${userId === ADMIN_ID ? 'Unlimited' : user.matchLimit + ' Matches'} left.\n\n` +
                           `🚀 <b>Connect with random people instantly!</b>\n` +
                           `👉 <a href="https://t.me/MakefriendsglobalBot/Letschat">✨ Start Chatting Now ✨</a>\n\n` +
                           `<i>Open our Mini App to find your perfect match!</i>`;
        
        ctx.reply(welcomeMsg, {
            parse_mode: 'HTML',
            disable_web_page_preview: false,
            ...Markup.keyboard([
                ['🔍 Find Partner'], 
                ['👤 My Status', '👫 Refer & Earn'], 
                ['❌ Stop Chat']
            ]).resize()
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
                    [Markup.button.url('🔗 Open Link 1', 'https://otieu.com/4/9382477'), Markup.button.callback('✅ Verify 1', 'verify_1')],
                    [Markup.button.url('🔗 Open Link 2', 'https://www.profitableratecpm.com/k8hkwgsm3z?key=2cb2941afdb3af8f1ca4ced95e61e00f'), Markup.button.callback('✅ Verify 2', 'verify_2')]
                ])
            });
        }

        if (user.status === 'chatting') return ctx.reply('❌ Already in a chat!');
        await User.updateOne({ userId }, { status: 'searching' });
        
        ctx.reply(`🔎 Searching for a partner...`, Markup.keyboard([['❌ Stop Search'], ['👤 My Status', '👫 Refer & Earn']]).resize());

        const partner = await User.findOne({ userId: { $ne: userId }, status: 'searching' });
        if (partner) {
            if (!isAdmin) await User.updateOne({ userId }, { $inc: { matchLimit: -1 } });
            if (partner.userId !== ADMIN_ID) await User.updateOne({ userId: partner.userId }, { $inc: { matchLimit: -1 } });
            await User.updateOne({ userId }, { status: 'chatting', partnerId: partner.userId });
            await User.updateOne({ userId: partner.userId }, { status: 'chatting', partnerId: userId });
            
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
        ctx.editMessageText('🎉 <b>Bonus Added!</b> You got +5 matches.', { parse_mode: 'HTML' });
    } catch (err) { console.error("Verify Error:", err); }
});

bot.on('text', async (ctx, next) => {
    try {
        const text = ctx.message.text;
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID;
        const user = await User.findOne({ userId });

        if (!user) return;

        // --- আপডেট করা ব্রডকাস্ট লজিক (TimeoutError ফিক্সড) ---
        if (text.startsWith('/broadcast ') && isAdmin) {
            const msg = text.replace('/broadcast ', '').trim();
            const allUsers = await User.find({});
            
            // সাথে সাথে রিপ্লাই দিন যাতে টেলিগ্রাম ৯৩ সেকেন্ড অপেক্ষা না করে
            await ctx.reply(`📢 ব্রডকাস্ট শুরু হয়েছে! মোট ইউজার: ${allUsers.length}\nএটি ব্যাকগ্রাউন্ডে চলছে, শেষ হলে আপনাকে জানানো হবে।`);

            // একটি আলাদা ফাংশন হিসেবে চালান যাতে মেইন লুপে প্রেসার না পড়ে
            (async () => {
                let count = 0;
                let failed = 0;
                for (const u of allUsers) {
                    try {
                        // প্রতি মেসেজের মাঝে সামান্য গ্যাপ (টেলিগ্রাম রেট লিমিট এড়াতে)
                        await bot.telegram.sendMessage(u.userId, msg, { parse_mode: 'HTML' });
                        count++;
                    } catch (e) {
                        failed++;
                    }
                    // প্রতি ৩০টি মেসেজ পর ১.৫ সেকেন্ড বিরতি
                    if (count % 30 === 0) await new Promise(r => setTimeout(r, 1500));
                }
                await bot.telegram.sendMessage(ADMIN_ID, `✅ ব্রডকাস্ট সম্পন্ন!\n\nসফল: ${count}\nব্যর্থ: ${failed}`).catch(e => {});
            })();
            return; // এখানে রিটার্ন করে ফাংশন শেষ করে দিন
        }

        // আপনার বাকি লজিক...
        if (['🔍 Find Partner', '👤 My Status', '👫 Refer & Earn', '❌ Stop Chat', '❌ Stop Search', '/start'].includes(text)) return next();
        // ... filter logic ...
        if (user.status === 'chatting' && user.partnerId) {
            bot.telegram.sendMessage(user.partnerId, text).catch(e => ctx.reply('⚠️ Partner left.'));
        }
    } catch (err) { console.error("Text Error:", err); }
});



// --- মিডিয়া ব্রডকাস্ট ফিক্সড লজিক ---
bot.on(['photo', 'video', 'sticker', 'voice', 'audio'], async (ctx) => {
    try {
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID;
        const user = await User.findOne({ userId });
        const caption = ctx.message.caption || "";

        // ১. অ্যাডমিন যদি মিডিয়া ব্রডকাস্ট করতে চায়
        if (isAdmin && caption.startsWith('/broadcast')) {
            const allUsers = await User.find({});
            const cleanCaption = caption.replace('/broadcast', '').trim();
            
            await ctx.reply(`📢 মিডিয়া ব্রডকাস্ট শুরু হয়েছে! মোট ইউজার: ${allUsers.length}`);

            // ব্যাকগ্রাউন্ডে ব্রডকাস্ট লুপ
            (async () => {
                let count = 0;
                for (const u of allUsers) {
                    try {
                        // copyMessage ব্যবহার করলে ফটো/ভিডিও সব হুবহু চলে যায়
                        await ctx.copyMessage(u.userId, { caption: cleanCaption, parse_mode: 'HTML' });
                        count++;
                        
                        // প্রতি ৩০টি মেসেজ পর ১.৫ সেকেন্ড বিরতি (ফ্লাড কন্ট্রোল)
                        if (count % 30 === 0) await new Promise(r => setTimeout(r, 1500));
                    } catch (e) {
                        // ইউজার বোট ব্লক করলে বা ডিলিট করলে এরর ইগনোর করবে
                    }
                }
                await bot.telegram.sendMessage(ADMIN_ID, `✅ মিডিয়া ব্রডকাস্ট সম্পন্ন! সফলভাবে ${count} জন ইউজারের কাছে পৌঁছেছে।`).catch(e => {});
            })();
            return;
        }

        // ২. চ্যাটিংয়ের সময় পার্টনারকে মিডিয়া পাঠানো (যদি আপনার বোটে এলাউড থাকে)
        if (user && user.status === 'chatting' && user.partnerId) {
            // যদি আপনি চান চ্যাটিংয়ে শুধু টেক্সট হবে, তবে নিচের লাইনটি কমেন্ট করে দিন
            return ctx.copyMessage(user.partnerId).catch(e => ctx.reply('⚠️ Partner left.'));
        }

        // ৩. সাধারণ অবস্থায় মেসেজ
        if (!isAdmin) {
            ctx.reply('⚠️ Only text messages are allowed in public or initial state!');
        }
    } catch (err) {
        console.error("Media Error:", err);
    }
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
        const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize();
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
    const GROUP_ID = -1002461999862; 
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
