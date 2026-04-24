const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    maxHttpBufferSize: 5e6  // 5MB limit for voice/photo messages
});

// ============================================================
//  🔐 AES-256-GCM ENCRYPTION HELPERS
// ============================================================

const APP_SECRET = process.env.APP_SECRET || 'default_dev_secret_change_in_production';

function deriveKey(roomCode) {
    return crypto.pbkdf2Sync(
        roomCode,
        APP_SECRET,
        100_000,
        32,
        'sha256'
    );
}

function encrypt(plainText, roomCode) {
    const key = deriveKey(roomCode);
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag   = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(encryptedString, roomCode) {
    try {
        const [ivHex, authTagHex, ciphertextHex] = encryptedString.split(':');
        const key        = deriveKey(roomCode);
        const iv         = Buffer.from(ivHex,         'hex');
        const authTag    = Buffer.from(authTagHex,    'hex');
        const ciphertext = Buffer.from(ciphertextHex, 'hex');

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
    } catch (err) {
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
    text      : String,
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
    //  SEND TEXT MESSAGE — encrypt before saving
    // ----------------------------------------------------------
    socket.on('send-message', async (data) => {
        const { roomCode, user, text } = data;

        socket.to(roomCode).emit('receive-message', {
            user,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        try {
            const encryptedText = encrypt(text, roomCode);
            const newMessage = new Message({ roomCode, user, text: encryptedText });
            await newMessage.save();

            await Room.findOneAndUpdate({ roomCode }, { lastActivity: new Date() });

            console.log(`💬 [ENCRYPTED] ${roomCode} — ${user}: ${text.substring(0, 30)}...`);
        } catch (err) {
            console.error('❌ Error saving message:', err);
        }
    });

    // ----------------------------------------------------------
    //  SEND VOICE MESSAGE
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
    //  SEND PRIVATE PHOTO — never saved to database
    //  Photo travels through memory only and is deleted after viewing
    // ----------------------------------------------------------
    socket.on('send-photo', async (data) => {
        const { roomCode, user, photo } = data;

        // Validate it's actually an image (basic check)
        if (!photo || !photo.startsWith('data:image/')) {
            socket.emit('room-error', { message: 'Invalid photo format.' });
            return;
        }

        // Forward to other users in room only — never stored in DB
        socket.to(roomCode).emit('receive-photo', {
            user,
            photo,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        console.log(`🖼️  [PRIVATE PHOTO] ${roomCode} — ${user}: sent (${(photo.length / 1024).toFixed(2)} KB) — NOT stored in DB`);

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
    console.log('🖼️  Private Photos: ACTIVE');
    console.log('   • Photos never saved to database');
    console.log('   • Memory-only transfer via Socket.io');
    console.log('   • Deleted after viewing on client side');
    if (!process.env.APP_SECRET) {
        console.log('');
        console.log('⚠️  WARNING: APP_SECRET not set in environment!');
        console.log('   Set it on Render: APP_SECRET=<your_secret_here>');
    }
    console.log('--------------------------------------------------');
});