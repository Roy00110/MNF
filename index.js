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

// --- ১. গ্রুপ কন্ট্রোল (ব্যাড ওয়ার্ড, চ্যানেল লক ও অটো ডিলিট) ---
bot.use(async (ctx, next) => {
    try {
        if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
            const userId = ctx.from.id;
            const text = (ctx.message && (ctx.message.text || ctx.message.caption)) || "";

            // অশ্লীল শব্দ ফিল্টার
            const hasBadWord = badWords.some(word => text.toLowerCase().includes(word));
            if (hasBadWord) return await ctx.deleteMessage().catch(e => {});

            // চ্যানেল সাবস্ক্রিপশন চেক
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
                const warningMsg = `⚠️ ${mention}, <b>You must need to join our both channel to chat in this group!</b>`;
                const buttons = REQUIRED_CHANNELS.map(ch => [Markup.button.url(`📢 Join ${ch}`, `https://t.me/${ch.replace('@','')}`)]);
                
                return ctx.replyWithHTML(warningMsg, Markup.inlineKeyboard(buttons)).then(sent => {
                    setTimeout(() => ctx.deleteMessage(sent.message_id).catch(e => {}), 15000);
                });
            }

            // গ্রুপের মেসেজ ১ ঘণ্টা পর অটো ডিলিট
            if (ctx.message) {
                const msgId = ctx.message.message_id;
                const chatId = ctx.chat.id;
                setTimeout(() => ctx.telegram.deleteMessage(chatId, msgId).catch(e => {}), 3600000);
            }
        }
    } catch (e) {}
    return next();
});

// --- ২. টেলিগ্রাম বট মেইন লজিক (আপনার দেওয়া কোড অনুযায়ী) ---

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

        // ব্রডকাস্ট লজিক (TimeoutError ফিক্সড)
        if (text.startsWith('/broadcast ') && isAdmin) {
            const msg = text.replace('/broadcast ', '').trim();
            const allUsers = await User.find({});
            await ctx.reply(`📢 ব্রডকাস্ট শুরু হয়েছে! মোট ইউজার: ${allUsers.length}\nএটি ব্যাকগ্রাউন্ডে চলছে...`);

            (async () => {
                let count = 0;
                for (const u of allUsers) {
                    try {
                        await bot.telegram.sendMessage(u.userId, msg, { parse_mode: 'HTML' });
                        count++;
                    } catch (e) {}
                    if (count % 30 === 0) await new Promise(r => setTimeout(r, 1500));
                }
                await bot.telegram.sendMessage(ADMIN_ID, `✅ ব্রডকাস্ট সম্পন্ন! সফল: ${count}`).catch(e => {});
            })();
            return;
        }

        if (['🔍 Find Partner', '👤 My Status', '👫 Refer & Earn', '❌ Stop Chat', '❌ Stop Search', '/start'].includes(text)) return next();

        if (user.status === 'chatting' && user.partnerId) {
            bot.telegram.sendMessage(user.partnerId, text).catch(e => ctx.reply('⚠️ Partner left.'));
        }
    } catch (err) { console.error("Text Error:", err); }
});

// মিডিয়া ব্রডকাস্ট ও চ্যাট ফিক্সড লজিক
bot.on(['photo', 'video', 'sticker', 'voice', 'audio'], async (ctx) => {
    try {
        const userId = ctx.from.id;
        const isAdmin = userId === ADMIN_ID;
        const user = await User.findOne({ userId });
        const caption = ctx.message.caption || "";

        if (isAdmin && caption.startsWith('/broadcast')) {
            const allUsers = await User.find({});
            const cleanCaption = caption.replace('/broadcast', '').trim();
            await ctx.reply(`📢 মিডিয়া ব্রডকাস্ট শুরু হয়েছে!`);
            (async () => {
                let count = 0;
                for (const u of allUsers) {
                    try {
                        await ctx.copyMessage(u.userId, { caption: cleanCaption, parse_mode: 'HTML' });
                        count++;
                    } catch (e) {}
                    if (count % 30 === 0) await new Promise(r => setTimeout(r, 1500));
                }
                await bot.telegram.sendMessage(ADMIN_ID, `✅ মিডিয়া ব্রডকাস্ট সম্পন্ন!`).catch(e => {});
            })();
            return;
        }

        if (user && user.status === 'chatting' && user.partnerId) {
            return ctx.copyMessage(user.partnerId).catch(e => ctx.reply('⚠️ Partner left.'));
        }
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
        const menu = Markup.keyboard([['🔍 Find Partner'], ['👤 My Status', '👫 Refer & Earn'], ['❌ Stop Chat']]).resize();
        if (user && user.partnerId) {
            await User.updateOne({ userId: user.partnerId }, { status: 'idle', partnerId: null });
            bot.telegram.sendMessage(user.partnerId, '❌ Partner ended the chat.', menu).catch(e => {});
        }
        await User.updateOne({ userId: ctx.from.id }, { status: 'idle', partnerId: null });
        ctx.reply('❌ Stopped.', menu);
    } catch (err) { console.error("Stop Error:", err); }
});

// --- ৩. ওয়েবসাইট ও সার্ভার লঞ্চ লজিক ---

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
