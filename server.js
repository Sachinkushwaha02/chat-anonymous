const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const path       = require('path');
const crypto     = require('crypto'); // ✅ Built-in Node.js — no install needed

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    maxHttpBufferSize: 5e6  // 5MB limit for voice messages
});

// ============================================================
//  🔐 AES-256-GCM ENCRYPTION HELPERS
//  - Algorithm : AES-256-GCM  (authenticated encryption)
//  - Key size  : 256 bits (32 bytes)
//  - IV size   : 96 bits  (12 bytes) — recommended for GCM
//  - Key derivation: PBKDF2 — roomCode + APP_SECRET → 256-bit key
//    So even if someone knows the room code, they still need
//    the secret to derive the real key.
// ============================================================

// ⚠️  IMPORTANT: Set this in your environment variables on Render/server
//     e.g.  APP_SECRET=mera_super_secret_key_change_this_in_production
const APP_SECRET = process.env.APP_SECRET || 'default_dev_secret_change_in_production';

/**
 * Derive a 256-bit AES key from the room code + app secret.
 * PBKDF2 with 100,000 iterations makes brute-force very expensive.
 * Same room code always → same key (deterministic).
 */
function deriveKey(roomCode) {
    return crypto.pbkdf2Sync(
        roomCode,                    // "password"
        APP_SECRET,                  // salt  (app-level secret)
        100_000,                     // iterations
        32,                          // key length in bytes → 256 bits
        'sha256'                     // hash algorithm
    );
}

/**
 * Encrypt a plain-text string.
 * Returns a single string:  iv_hex:authTag_hex:ciphertext_hex
 * All three parts are needed to decrypt.
 */
function encrypt(plainText, roomCode) {
    const key = deriveKey(roomCode);
    const iv  = crypto.randomBytes(12);                          // fresh random IV every time
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const encrypted  = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag    = cipher.getAuthTag();                      // GCM authentication tag (16 bytes)

    // Store as one combined string so MongoDB holds a single field
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a string produced by encrypt().
 * Returns the original plain text, or null if tampered / wrong key.
 */
function decrypt(encryptedString, roomCode) {
    try {
        const [ivHex, authTagHex, ciphertextHex] = encryptedString.split(':');
        const key        = deriveKey(roomCode);
        const iv         = Buffer.from(ivHex,         'hex');
        const authTag    = Buffer.from(authTagHex,    'hex');
        const ciphertext = Buffer.from(ciphertextHex, 'hex');

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);                            // ← GCM verifies integrity

        return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
    } catch (err) {
        // Wrong key, corrupted data, or tampered message
        console.error('❌ Decryption failed:', err.message);
        return null;
    }
}

// ============================================================
//  MONGODB CONNECTION
// ============================================================

const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/anonymousChat';

mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log('✅ MongoDB Connected Successfully!'))
    .catch(err => {
        console.error('❌ MongoDB Connection Failed!');
        console.error('Error Detail:', err.message);
        console.log('TIP: Check karein ki MongoDB Compass chalu hai ya nahi.');
    });

// ============================================================
//  SCHEMAS
// ============================================================

const messageSchema = new mongoose.Schema({
    roomCode  : String,
    user      : String,
    text      : String,          // ← stored ENCRYPTED, never plain text
    createdAt : { type: Date, default: Date.now, expires: 900 }
});

const Message = mongoose.model('Message', messageSchema);

const roomSchema = new mongoose.Schema({
    roomCode     : { type: String, unique: true },
    createdBy    : String,
    users        : [String],
    createdAt    : { type: Date, default: Date.now },
    lastActivity : { type: Date, default: Date.now, expires: 900 }
});

const Room = mongoose.model('Room', roomSchema);

// ============================================================
//  IN-MEMORY TRACKING
// ============================================================

const activeRooms = {};

// ============================================================
//  EXPRESS ROUTES
// ============================================================

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
//  SOCKET.IO
// ============================================================

io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    let currentUser = '';
    let currentRoom = '';

    // ----------------------------------------------------------
    //  CREATE ROOM
    // ----------------------------------------------------------
    socket.on('create-room', async (data) => {
        const { username, roomCode } = data;
        console.log(`🆕 ${username} wants to create room: ${roomCode}`);

        try {
            const existingRoom = await Room.findOne({ roomCode });
            if (existingRoom) {
                socket.emit('room-error', { message: 'Room code already exists! Please generate a new code.' });
                return;
            }

            const newRoom = new Room({
                roomCode,
                createdBy    : username,
                users        : [username],
                lastActivity : new Date()
            });
            await newRoom.save();
            console.log(`✅ Room ${roomCode} created by ${username}`);

            currentUser = username;
            currentRoom = roomCode;
            socket.join(roomCode);
            activeRooms[roomCode] = [username];

            socket.emit('room-created', { roomCode });
            io.to(roomCode).emit('update-users', activeRooms[roomCode]);

        } catch (err) {
            console.error('❌ Error creating room:', err);
            socket.emit('room-error', { message: 'Failed to create room. Please try again.' });
        }
    });

    // ----------------------------------------------------------
    //  JOIN ROOM
    // ----------------------------------------------------------
    socket.on('join-room', async (data) => {
        const { username, roomCode } = data;
        console.log(`🚪 ${username} wants to join room: ${roomCode}`);

        try {
            const room = await Room.findOne({ roomCode });
            if (!room) {
                socket.emit('room-error', { message: 'Room code not found! Please check the code.' });
                return;
            }

            currentUser = username;
            currentRoom = roomCode;
            socket.join(roomCode);

            if (!activeRooms[roomCode]) activeRooms[roomCode] = [];
            if (!activeRooms[roomCode].includes(username)) activeRooms[roomCode].push(username);

            await Room.findOneAndUpdate(
                { roomCode },
                { users: activeRooms[roomCode], lastActivity: new Date() }
            );

            // ✅ Load history — DECRYPT each message before sending to client
            const chatHistory = await Message.find({ roomCode }).sort({ createdAt: 1 });
            const decryptedHistory = chatHistory.map(msg => ({
                user : msg.user,
                text : decrypt(msg.text, roomCode) ?? '[🔒 Could not decrypt message]'
            }));
            socket.emit('load-messages', decryptedHistory);
            console.log(`📜 Loaded & decrypted ${chatHistory.length} messages`);

            socket.to(roomCode).emit('system-message', `${username} joined the room`);
            socket.emit('room-joined', { roomCode });
            io.to(roomCode).emit('update-users', activeRooms[roomCode]);

        } catch (err) {
            console.error('❌ Error joining room:', err);
            socket.emit('room-error', { message: 'Failed to join room. Please try again.' });
        }
    });

    // ----------------------------------------------------------
    //  SEND TEXT MESSAGE  🔐 Encrypt before saving
    // ----------------------------------------------------------
    socket.on('send-message', async (data) => {
        const { roomCode, user, text } = data;

        // 1. Forward plain text to other users in real-time (in-memory, not stored)
        socket.to(roomCode).emit('receive-message', {
            user,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        // 2. ENCRYPT then save to MongoDB
        try {
            const encryptedText = encrypt(text, roomCode);   // ← AES-256-GCM
            const newMessage = new Message({ roomCode, user, text: encryptedText });
            await newMessage.save();

            await Room.findOneAndUpdate({ roomCode }, { lastActivity: new Date() });

            console.log(`💬 [ENCRYPTED] ${roomCode} — ${user}: ${text.substring(0, 30)}...`);
            console.log(`   🔒 Stored: ${encryptedText.substring(0, 60)}...`);
        } catch (err) {
            console.error('❌ Error saving message:', err);
        }
    });

    // ----------------------------------------------------------
    //  SEND VOICE MESSAGE  (audio is base64 — encryption optional)
    //  Kept same as before; voice is large binary data.
    //  If you want to encrypt voice too, same encrypt() fn works.
    // ----------------------------------------------------------
    socket.on('send-voice', async (data) => {
        const { roomCode, user, audio } = data;

        socket.to(roomCode).emit('receive-voice', {
            user, audio,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        console.log(`🎤 ${roomCode} — ${user}: Voice (${(audio.length / 1024).toFixed(2)} KB)`);

        try {
            await Room.findOneAndUpdate({ roomCode }, { lastActivity: new Date() });
        } catch (err) {
            console.error('❌ Error updating room:', err);
        }
    });

    // ----------------------------------------------------------
    //  LEAVE ROOM
    // ----------------------------------------------------------
    socket.on('leave-room', async (data) => {
        const { username, roomCode } = data;
        handleUserLeave(username, roomCode);
    });

    // ----------------------------------------------------------
    //  DISCONNECT
    // ----------------------------------------------------------
    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', socket.id);
        if (currentUser && currentRoom) handleUserLeave(currentUser, currentRoom);
    });

    // ----------------------------------------------------------
    //  HELPER: USER LEAVE
    // ----------------------------------------------------------
    async function handleUserLeave(username, roomCode) {
        if (!activeRooms[roomCode]) return;

        activeRooms[roomCode] = activeRooms[roomCode].filter(u => u !== username);
        console.log(`👋 ${username} left room: ${roomCode}`);

        if (activeRooms[roomCode].length === 0) {
            delete activeRooms[roomCode];
            console.log(`🗑️  Room ${roomCode} empty — will auto-delete in 15 min`);
        } else {
            try {
                await Room.findOneAndUpdate(
                    { roomCode },
                    { users: activeRooms[roomCode], lastActivity: new Date() }
                );
            } catch (err) {
                console.error('❌ Error updating room:', err);
            }
        }

        socket.to(roomCode).emit('system-message', `${username} left the room`);
        if (activeRooms[roomCode]) {
            io.to(roomCode).emit('update-users', activeRooms[roomCode]);
        }
    }
});

// ============================================================
//  AUTO-CLEANUP
// ============================================================

setInterval(async () => {
    console.log('🧹 Running cleanup...');
    for (const roomCode in activeRooms) {
        if (activeRooms[roomCode].length === 0) {
            delete activeRooms[roomCode];
            console.log(`🗑️  Cleaned: ${roomCode}`);
        }
    }
}, 5 * 60 * 1000);

// ============================================================
//  ERROR HANDLING
// ============================================================

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

// ============================================================
//  START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('--------------------------------------------------');
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('--------------------------------------------------');
    console.log('🔐 AES-256-GCM Encryption: ACTIVE');
    console.log('   • Messages encrypted before MongoDB storage');
    console.log('   • Key derived from roomCode + APP_SECRET');
    console.log('   • Real-time delivery: plain text (in-memory only)');
    console.log('   • History load: auto-decrypted on delivery');
    if (!process.env.APP_SECRET) {
        console.log('');
        console.log('⚠️  WARNING: APP_SECRET not set in environment!');
        console.log('   Set it on Render: APP_SECRET=<your_secret_here>');
    }
    console.log('--------------------------------------------------');
});