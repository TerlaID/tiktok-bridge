// =========================================================================
// server.js - TikTok Live Bridge (SISTEM REAL DATA 1:1 - NOL DUPLIKASI)
// FIXED: Anti-dupe key tidak lagi pakai `count` (rawan collision saat gift
// dikirim satuan/berturut-turut dengan repeatCount selalu 1).
// =========================================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const { TikTokLiveConnection } = require('tiktok-live-connector');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let eventQueue = [];
const MAX_QUEUE_SIZE = 300;
const userRobloxMap = {};
const pendingGifts = {};
const userChatCooldown = {};
const processedGifts = new Map();  // 🛡️ Dedup untuk msgId / fallback (value = timestamp)
const comboProgress = new Map();   // 📈 Tracking progres combo per groupId (value = {count, ts})
const COMBO_TIMEOUT_MS = 8000;     // Kalau tidak ada event baru dalam grup ini selama 8s,
                                    // anggap sesi combo itu sudah berakhir/basi -> combo
                                    // berikutnya dengan groupId sama (reuse/edge-case)
                                    // dihitung dari 0 lagi, bukan disambung.

let tiktokLive = null;
let isConnected = false;
let currentUsername = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;
let lastPollTime = Date.now();

// 🎛️ STATE DJ MODE (Roblox <-> Web HTML)
let isDjActive = false;

// 🌸 STATE PERFUME TRIGGER (Roblox/Web -> Web ganti lagu berikutnya)
let pendingMusicTrigger = { shouldSkip: false, user: "", triggerTime: 0 };

// 🎯 5 ID RESMI TIKTOK ANDA
const OFFICIAL_GIFTS = {
    "6064": { name: "GG", coins: 1 },
    "5655": { name: "Rose", coins: 1 },
    "8913": { name: "Rosa", coins: 10 },
    "5780": { name: "Bouquet Flower", coins: 30 },
    "5879": { name: "Doughnut", coins: 30 },
    "5660": { name: "Hand Hearts", coins: 100 },
    "5586": { name: "Hearts", coins: 199 },
    "6267": { name: "Corgi", coins: 299 }
};

const IGNORED_WORDS = new Set([
    "gw", "gua", "gue", "aku", "saya", "kami", "kita", "lu", "loe", "kamu",
    "bang", "bg", "bng", "kak", "kakak", "kk", "min", "admin", "bro", "bray", "mas", "dek", "om", "tante", "gan", "guys",
    "halo", "hai", "hi", "hey", "helo", "assalamualaikum", "p", "tes", "test", "cek", "hadir",
    "spawn", "spawin", "spwan", "spwaner", "spawner", "muncul", "munculin", "in", "masuk", "masukin",
    "nama", "namaku", "name", "username", "user", "id", "roblox", "rbx", "akun",
    "ini", "itu", "yang", "dan", "atau", "di", "ke", "dari", "buat", "untuk",
    "dong", "dongg", "dunk", "plis", "please", "pls", "tolong", "bantu", "ya", "iya", "yok", "kuy", "gas", "gass",
    "banget", "bisa", "gak", "nggak", "gk", "g", "ga", "tidak", "bukan", "udah", "udahh", "sudah", "blm", "belum",
    "ikut", "main", "game", "live", "gift", "mabar", "skin", "keren", "mantap", "gg", "wkwk", "wkwkwk"
]);

// 🧹 BERSIHKAN GEMBOK LAMA SUPAYA MAP TIDAK BOCOR MEMORI TERUS-MENERUS
// PENTING: dua map ini punya bentuk value BERBEDA, jadi cleanup-nya dipisah.
// (Bug lama: comboProgress sempat digabung ke processedGifts dan nyimpen
// `count` [angka kecil] padahal cleanup ngira semua value itu timestamp
// [angka besar] -> combo yang masih aktif ke-hapus prematur -> combo yang
// di-retry TikTok dianggap combo baru -> avatar keluar dobel/lebih banyak.)
setInterval(() => {
    const now = Date.now();
    const cutoff = now - 20000;

    for (const [key, ts] of processedGifts.entries()) {
        if (ts < cutoff) processedGifts.delete(key);
    }

    // Combo dianggap "selesai total" kalau tidak ada event baru masuk lagi
    // selama 20 detik -> baru boleh dihapus dari tracking.
    for (const [key, progress] of comboProgress.entries()) {
        if (progress.ts < cutoff) comboProgress.delete(key);
    }
}, 10000); // dicek tiap 10 detik supaya window 20 detik lebih presisi

function pushEvent(evt) {
    eventQueue.push(evt);
    if (eventQueue.length > MAX_QUEUE_SIZE) {
        eventQueue.shift();
    }
}

function teardownConnection() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (tiktokLive) {
        try { tiktokLive.removeAllListeners(); } catch (e) {}
        try { tiktokLive.disconnect(); } catch (e) {}
    }
    tiktokLive = null;
}

function extractCommentText(data) {
    if (!data || typeof data !== 'object') return "";
    if (typeof data.comment === 'string' && data.comment.trim() !== '') return data.comment.trim();
    if (typeof data.text === 'string' && data.text.trim() !== '') return data.text.trim();
    if (typeof data.content === 'string' && data.content.trim() !== '') return data.content.trim();
    if (typeof data.message === 'string' && data.message.trim() !== '') return data.message.trim();

    if (data.displayText) {
        if (typeof data.displayText === 'string' && data.displayText.trim() !== '') return data.displayText.trim();
        if (Array.isArray(data.displayText.pieces)) {
            let combined = "";
            for (let piece of data.displayText.pieces) {
                if (piece && typeof piece.stringValue === 'string') combined += piece.stringValue;
                else if (piece && typeof piece.string_value === 'string') combined += piece.string_value;
                else if (typeof piece === 'string') combined += piece;
            }
            if (combined.trim() !== '') return combined.trim();
        }
    }
    return "";
}

function isValidRobloxName(name) {
    if (!name || typeof name !== 'string') return false;
    const clean = name.trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(clean)) return false;
    if (clean.startsWith('_') || clean.endsWith('_')) return false;
    if (clean.includes('__')) return false;
    return true;
}

function getRobloxNameFromChat(comment) {
    if (!comment || typeof comment !== 'string') return null;
    const text = comment.trim();
    if (!text) return null;

    const explicitMatch = text.match(/(?:username|user|nama|name|id|roblox|rbx|@)\s*[:=]?\s*([a-zA-Z0-9_]{3,20})/i);
    if (explicitMatch && explicitMatch[1] && isValidRobloxName(explicitMatch[1])) {
        return explicitMatch[1];
    }

    const rawWords = text.split(/[\s,.:;!?"'(){}[\]<>+=/\\|~`*]+/).filter(Boolean);
    if (rawWords.length === 1) {
        const clean = rawWords[0].replace(/^[@_]+/, '').replace(/[@_]+$/, '');
        if (isValidRobloxName(clean)) return clean;
    }

    const nonIgnored = [];
    for (let word of rawWords) {
        const clean = word.replace(/^[@_]+/, '').replace(/[@_]+$/, '');
        if (isValidRobloxName(clean) && !IGNORED_WORDS.has(clean.toLowerCase())) {
            nonIgnored.push(clean);
        }
    }

    if (nonIgnored.length > 0) {
        return nonIgnored[nonIgnored.length - 1];
    }
    return null;
}

async function connectToTikTok(username, isReconnect = false) {
    teardownConnection();
    console.log(`📡 Menyambungkan ke live TikTok: @${username}...`);

    const clientOptions = {
        processInitialData: false,
        enableExtendedGiftInfo: false,
        requestPollingIntervalMs: 1000,
        clientParams: { app_language: 'id-ID', device_platform: 'web' }
    };

    tiktokLive = new TikTokLiveConnection(username, clientOptions);

    // 💬 CHAT PENONTON
    tiktokLive.on('chat', (data) => {
        const comment = extractCommentText(data);
        const ttUser = data.user?.uniqueId || data.user?.nickname || "Penonton";
        const ttKey = ttUser.toLowerCase();

        if (!comment) return;
        const robloxName = getRobloxNameFromChat(comment);

        if (robloxName) {
            userRobloxMap[ttKey] = robloxName;

            // 👑 JIKA PENONTON INI PUNYA HADIAH PENDING -> LEPASKAN & JANGAN SPAWN CHAT!
            if (pendingGifts[ttKey] && pendingGifts[ttKey].length > 0) {
                console.log(`🚀 [PRIORITAS VIP] @${ttUser} baru komen "${robloxName}" -> Melepaskan ${pendingGifts[ttKey].length} hadiah pending!`);
                for (const giftEvt of pendingGifts[ttKey]) {
                    giftEvt.robloxUsername = robloxName;
                    pushEvent(giftEvt);
                }
                delete pendingGifts[ttKey];
                return; // 🛑 PENTING: Batalkan chat agar avatar tidak dobel!
            }

            const now = Date.now();
            if (userChatCooldown[ttKey] && (now - userChatCooldown[ttKey] < 4000)) return;
            userChatCooldown[ttKey] = now;

            pushEvent({
                type: 'chat',
                tiktokUsername: ttUser,
                robloxUsername: robloxName,
                comment: comment
            });
        }
    });

    // 🎁 GIFT PENONTON (STANDAR RESMI TIKTOK ANTI-DOBEL)
    tiktokLive.on('gift', (data) => {
        // 🛑 1. JIKA COMBO SEDANG BERJALAN (BELUM REPEAT END) -> BUANG KETUKAN DI TENGAH JALAN!
        if (data.giftType === 1 && !data.repeatEnd) {
            return; // Mengabaikan ketukan 1, 2, 3, 4... (NOL DUPLIKASI)
        }

        let giftId = String(data.giftId || "");
        let giftName = data.giftName || "Gift";
        let diamonds = Number(data.diamondCount) || 1;
        const rawNameLower = giftName.toLowerCase();
        const ttUser = data.user?.uniqueId || data.user?.nickname || "Sultan";
        const ttKey = ttUser.toLowerCase();
        const count = Number(data.repeatCount) || 1;

        // 🎯 KUNCI NAMA & ID RESMI
        if (rawNameLower.includes("corgi") || giftId === "6267") {
            giftId = "6267"; giftName = "Corgi"; diamonds = 299;
        } else if (rawNameLower.includes("hearts") || giftId === "5586") {
            giftId = "5586"; giftName = "Hearts"; diamonds = 199;
        } else if (rawNameLower.includes("bouquet") || rawNameLower.includes("flower") || giftId === "5780") {
            giftId = "5780"; giftName = "Bouquet Flower"; diamonds = 30;
        } else if (rawNameLower.includes("hand heart") || rawNameLower.includes("hand hearts") || giftId === "5660") {
            giftId = "5660"; giftName = "Hand Hearts"; diamonds = 100;
        } else if (OFFICIAL_GIFTS[giftId]) {
            giftName = OFFICIAL_GIFTS[giftId].name;
            diamonds = OFFICIAL_GIFTS[giftId].coins;
        } else {
            if (rawNameLower.includes("rosa")) { diamonds = 10; giftName = "Rosa"; giftId = "8913"; }
            else if (rawNameLower.includes("doughnut") || rawNameLower.includes("donut")) { diamonds = 30; giftName = "Doughnut"; giftId = "5879"; }
            else if (rawNameLower.includes("perfume") || rawNameLower.includes("parfum") || giftId === "5658") {
                giftId = "5658"; giftName = "Perfume"; diamonds = 20;
            }
        }

        // 🌸 PERFUME 20 COIN (5658) -> trigger ganti musik & dance di web
        if (giftId === "5658") {
            pendingMusicTrigger = { shouldSkip: true, user: ttUser, triggerTime: Date.now() };
            console.log(`🌸 [PERFUME 20] @${ttUser} -> trigger next music + dance`);
        }

        // 🛡️ 2. GEMBOK SESI COMBO RESMI
        // ⚠️ FIX #2: `groupId` TERNYATA dipakai TikTok untuk SATU SESI COMBO,
        // bukan per-event. Beberapa event repeatEnd:true bisa datang dengan
        // groupId yang SAMA tapi repeatCount BEDA (1, lalu 5, dst). Kalau kita
        // buang event kedua dst hanya karena groupId sama, kita kehilangan
        // event dengan repeatCount lebih besar/final -> avatar cuma keluar 1.
        //
        // Solusi: untuk groupId yang sama, JANGAN dibuang -- proses ulang,
        // tapi kirim SELISIH (delta) repeatCount-nya saja ke game, supaya
        // avatar yang sudah terlanjur dikirim untuk event sebelumnya tidak
        // dihitung dobel, dan sisanya tetap keluar semua.
        const msgId = data.msgId || data.common?.msgId || null;
        const now = Date.now();

        if (data.groupId) {
            const groupKey = `${ttKey}_${giftId}_grp${data.groupId}`;
            const progress = comboProgress.get(groupKey); // {count, ts} atau undefined

            // 🛡️ FIX #3: jangan cuma andalkan cleanup timer global (jalan tiap 10s).
            // Cek staleness LANGSUNG di sini juga -> kalau progress terakhir untuk
            // groupId ini sudah lebih dari COMBO_TIMEOUT_MS yang lalu, anggap sesi
            // combo lama sudah berakhir total dan mulai hitung dari 0 lagi. Ini
            // menutup celah reuse groupId / jeda combo yang sangat panjang.
            const isStale = progress && (now - progress.ts > COMBO_TIMEOUT_MS);
            const lastCountSent = (progress && !isStale) ? progress.count : 0;

            if (count <= lastCountSent) {
                // Event basi/retry murni (repeatCount tidak bertambah) -> aman dibuang
                console.log(`🛡️ [Sinyal Basi Dibuang] @${ttUser} groupId ${data.groupId} count ${count} <= ${lastCountSent}`);
                return;
            }

            // Ada tambahan gift baru dalam combo yang sama -> hitung selisihnya
            const delta = count - lastCountSent;
            // ⚠️ Simpan sebagai {count, ts} di map TERPISAH (comboProgress),
            // BUKAN di processedGifts -- supaya cleanup timestamp-based tidak
            // salah kira `count` sebagai timestamp dan menghapusnya prematur.
            comboProgress.set(groupKey, { count: count, ts: now });
            data._deltaCount = delta; // dipakai di bawah untuk giftEvent
        } else if (msgId) {
            const streakSessionKey = `msg_${msgId}`;
            if (processedGifts.has(streakSessionKey)) {
                console.log(`🛡️ [Sinyal Kembar Dibuang] @${ttUser} msgId ${msgId} diabaikan!`);
                return;
            }
            processedGifts.set(streakSessionKey, now);
        } else {
            // Tidak ada groupId maupun msgId -> fallback bucket waktu SANGAT pendek.
            // Retry/duplikat jaringan biasanya terjadi dalam hitungan puluhan ms;
            // tap manusia asli walau cepat biasanya >300ms terpisah. 300ms dipilih
            // supaya aman menangkap true-retry tanpa salah buang gift asli.
            const streakSessionKey = `${ttKey}_${giftId}_t${Math.floor(now / 300)}`;
            if (processedGifts.has(streakSessionKey)) {
                console.log(`🛡️ [Sinyal Kembar Dibuang] @${ttUser} sinyal duplikat ${streakSessionKey} diabaikan!`);
                return;
            }
            processedGifts.set(streakSessionKey, now);
        }

        // Kalau ini bagian dari groupId (combo), kirim jumlah SELISIH-nya saja,
        // bukan total kumulatif -- karena avatar untuk bagian sebelumnya
        // sudah pernah dikirim di event groupId yang sama.
        const effectiveCount = data._deltaCount || count;

        const giftEvent = {
            type: 'gift',
            tiktokUsername: ttUser,
            giftName: giftName,
            giftId: giftId,
            realCoins: diamonds,
            giftCount: effectiveCount, // 🎯 Selisih real (bukan total kumulatif combo)
            repeatCount: effectiveCount,
            isCombo: (effectiveCount > 1),
            timestamp: now
        };

        // ⏳ 3. JIKA BELUM PERNAH CHAT USERNAME -> TAHAN DI BRANKAS PENDING
        if (!userRobloxMap[ttKey]) {
            if (!pendingGifts[ttKey]) pendingGifts[ttKey] = [];
            pendingGifts[ttKey].push(giftEvent);
            console.log(`⏳ [Menunggu Username] @${ttUser} kirim ${count}x ${giftName} (${diamonds} Koin). Hadiah ditahan aman.`);
            return;
        }

        // 🚀 4. SUDAH ADA USERNAME -> LANGSUNG MELUNCUR KE ROBLOX TEPAT 1 KALI!
        giftEvent.robloxUsername = userRobloxMap[ttKey];
        console.log(`⚡ [HADIAH SAH MELUNCUR] @${ttUser} (${userRobloxMap[ttKey]}) kirim ${count}x ${giftName}!`);
        pushEvent(giftEvent);
    });

    tiktokLive.on('error', (err) => console.error('❌ [Error]', err?.message || err));
    tiktokLive.on('disconnected', () => { isConnected = false; });

    const state = await tiktokLive.connect();
    isConnected = true;
    currentUsername = username;
    lastPollTime = Date.now();
    console.log(`🔥 [BERHASIL TERHUBUNG] Live TikTok @${username}`);
    return state;
}

app.post('/api/connect', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.json({ success: false, error: "Username kosong" });
    const cleanUser = username.replace('@', '').trim();
    try {
        currentUsername = cleanUser;
        const state = await connectToTikTok(cleanUser, false);
        return res.json({ success: true, message: `Connected to @${cleanUser}`, roomId: state.roomId });
    } catch (err) {
        return res.json({ success: false, error: err.message || "Gagal konek" });
    }
});

app.post('/api/disconnect', (req, res) => {
    teardownConnection();
    isConnected = false;
    eventQueue = [];
    res.json({ success: true });
});

app.get('/events', (req, res) => {
    lastPollTime = Date.now();
    const events = [...eventQueue];
    eventQueue = [];
    res.json({ success: true, isOnline: isConnected, events: events });
});

// =========================================================================
// 🧪 TEST EVENT DARI WEB -> ANTREAN ROBLOX
// =========================================================================
app.post('/api/test-event', (req, res) => {
    const eventData = req.body;
    if (!eventData) return res.status(400).json({ success: false, error: "Data kosong" });

    if (eventData.robloxUsername && eventData.tiktokUsername) {
        userRobloxMap[eventData.tiktokUsername.toLowerCase()] = eventData.robloxUsername;
    }

    // 🌸 kalau test event Perfume -> aktifkan trigger juga
    if (eventData.type === 'gift') {
        const gid = String(eventData.giftId || '');
        const coins = Number(eventData.realCoins) || 0;
        const gn = String(eventData.giftName || '').toLowerCase();
        if (gid === '5658' || coins === 20 || gn.includes('perfume') || gn.includes('parfum')) {
            pendingMusicTrigger = { shouldSkip: true, user: eventData.tiktokUsername || 'Sultan', triggerTime: Date.now() };
        }
    }

    // 💃 Command dance dari web -> pastikan format konsisten untuk Roblox
    if (eventData.type === 'command' && eventData.action === 'dance') {
        pushEvent({
            type: 'command',
            action: 'dance',
            danceId: String(eventData.danceId || '')
        });
        console.log(`💃 [Web -> Roblox] Switch Dance ID: ${eventData.danceId}`);
        return res.json({ success: true });
    }

    pushEvent(eventData);
    console.log(`🧪 [Web Test] ${eventData.type} ${eventData.giftName || ''} -> antrean Roblox`);
    res.json({ success: true });
});

// =========================================================================
// 🎛️ STATUS DJ (Roblox POST start/end, Web GET polling)
// =========================================================================
app.get('/api/dj-status', (req, res) => {
    res.json({ active: isDjActive });
});

// 🌸 PERFUME TRIGGER (Web polling untuk auto-next lagu)
app.get('/api/music-trigger', (req, res) => {
    res.json(pendingMusicTrigger);
    if (pendingMusicTrigger.shouldSkip) {
        pendingMusicTrigger = { shouldSkip: false, user: "" };
    }
});

app.post('/api/dj-status', (req, res) => {
    if (req.body && typeof req.body.active === 'boolean') {
        isDjActive = req.body.active;
        console.log(`🎛️ [DJ STATUS] Mode DJ sekarang: ${isDjActive ? 'AKTIF' : 'MATI'}`);
    }
    res.json({ success: true, active: isDjActive });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 TikTok Server Berjalan di port: ${PORT}`);
});
