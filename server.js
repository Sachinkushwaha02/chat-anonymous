const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 5e6  // 5MB limit for voice messages (Base64 audio can be large)
});

// --- MONGODB CONNECTION SETUP ---
const mongoURI = 'mongodb://127.0.0.1:27017/anonymousChat';

mongoose.connect(mongoURI, {
    serverSelectionTimeoutMS: 5000
})
.then(() => console.log("✅ MongoDB Connected Successfully!"))
.catch(err => {
    console.error("❌ MongoDB Connection Failed!");
    console.error("Error Detail:", err.message);
    console.log("--------------------------------------------------");
    console.log("TIP: Check karein ki MongoDB Compass chalu hai ya nahi.");
    console.log("--------------------------------------------------");
});

// --- MESSAGE SCHEMA & MODEL ---
const messageSchema = new mongoose.Schema({
    roomCode: String,
    user: String,
    text: String,
    createdAt: { type: Date, default: Date.now, expires: 900 } // 15 mins TTL
});

const Message = mongoose.model('Message', messageSchema);

// --- ROOM SCHEMA & MODEL (Auto-delete inactive rooms) ---
const roomSchema = new mongoose.Schema({
    roomCode: { type: String, unique: true },
    users: [String],
    lastActivity: { type: Date, default: Date.now, expires: 900 } // 15 mins TTL
});

const Room = mongoose.model('Room', roomSchema);

// --- IN-MEMORY ROOM TRACKING ---
const activeRooms = {};

// --- MIDDLEWARE & ROUTES ---
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    let currentUser = '';
    let currentRoom = '';

    // ===== JOIN ROOM =====
    socket.on('join-room', async (data) => {
        const { username, roomCode } = data;
        currentUser = username;
        currentRoom = roomCode;

        socket.join(roomCode);
        console.log(`👤 ${username} joined room: ${roomCode}`);

        // Initialize room if not exists
        if (!activeRooms[roomCode]) {
            activeRooms[roomCode] = [];
        }

        // Add user to room (avoid duplicates)
        if (!activeRooms[roomCode].includes(username)) {
            activeRooms[roomCode].push(username);
        }

        // Update or create room in DB
        try {
            await Room.findOneAndUpdate(
                { roomCode },
                { 
                    users: activeRooms[roomCode],
                    lastActivity: new Date()
                },
                { upsert: true, new: true }
            );
        } catch (err) {
            console.error("❌ Error updating room:", err);
        }

        // Load chat history
        try {
            const chatHistory = await Message.find({ roomCode }).sort({ createdAt: 1 });
            socket.emit('load-messages', chatHistory);
            console.log(`📜 Loaded ${chatHistory.length} messages for room ${roomCode}`);
        } catch (err) {
            console.error("❌ Error loading history:", err);
            socket.emit('load-messages', []);
        }

        // Broadcast to room
        socket.to(roomCode).emit('system-message', `${username} joined the room`);

        // Send updated user list
        io.to(roomCode).emit('update-users', activeRooms[roomCode]);
        console.log(`📋 Active users in ${roomCode}:`, activeRooms[roomCode]);
    });

    // ===== SEND TEXT MESSAGE =====
    socket.on('send-message', async (data) => {
        const { roomCode, user, text } = data;

        // STEP 1: Instant broadcast
        socket.to(roomCode).emit('receive-message', {
            user,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        console.log(`💬 Text message in ${roomCode} by ${user}: ${text.substring(0, 30)}...`);

        // STEP 2: Background save
        try {
            const newMessage = new Message({ roomCode, user, text });
            await newMessage.save();
            
            // Update room activity timestamp
            await Room.findOneAndUpdate(
                { roomCode },
                { lastActivity: new Date() }
            );
            
            console.log(`💾 Message saved & room activity updated`);
        } catch (err) {
            console.error("❌ Error saving message:", err);
        }
    });

    // ===== SEND VOICE MESSAGE =====
    socket.on('send-voice', async (data) => {
        const { roomCode, user, audio } = data;

        // STEP 1: Instant broadcast to all users in room (except sender)
        socket.to(roomCode).emit('receive-voice', {
            user,
            audio,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        console.log(`🎤 Voice message in ${roomCode} by ${user} (${(audio.length / 1024).toFixed(2)} KB)`);

        // STEP 2: Update room activity (we don't save voice to DB - too large)
        try {
            await Room.findOneAndUpdate(
                { roomCode },
                { lastActivity: new Date() }
            );
            console.log(`💾 Room activity updated for voice message`);
        } catch (err) {
            console.error("❌ Error updating room activity:", err);
        }

        // Note: Voice messages are NOT saved to MongoDB (too large)
        // Only real-time transmission. For persistence, consider cloud storage (S3, etc.)
    });

    // ===== LEAVE ROOM (Explicit) =====
    socket.on('leave-room', async (data) => {
        const { username, roomCode } = data;
        handleUserLeave(username, roomCode);
    });

    // ===== DISCONNECT (Implicit leave) =====
    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', socket.id);
        
        if (currentUser && currentRoom) {
            handleUserLeave(currentUser, currentRoom);
        }
    });

    // ===== HELPER: HANDLE USER LEAVE =====
    async function handleUserLeave(username, roomCode) {
        if (!activeRooms[roomCode]) return;

        // Remove user from active list
        activeRooms[roomCode] = activeRooms[roomCode].filter(u => u !== username);
        console.log(`👋 ${username} left room: ${roomCode}`);

        // If room is empty, clean up
        if (activeRooms[roomCode].length === 0) {
            delete activeRooms[roomCode];
            console.log(`🗑️ Room ${roomCode} is now empty (will auto-delete in 15 min if no activity)`);
        } else {
            // Update room in DB
            try {
                await Room.findOneAndUpdate(
                    { roomCode },
                    { 
                        users: activeRooms[roomCode],
                        lastActivity: new Date()
                    }
                );
            } catch (err) {
                console.error("❌ Error updating room:", err);
            }
        }

        // Notify remaining users
        socket.to(roomCode).emit('system-message', `${username} left the room`);
        
        // Send updated user list
        if (activeRooms[roomCode]) {
            io.to(roomCode).emit('update-users', activeRooms[roomCode]);
        }
    }
});

// ===== AUTO-CLEANUP: Remove empty rooms from memory every 5 minutes =====
setInterval(async () => {
    console.log('🧹 Running cleanup check...');
    
    for (const roomCode in activeRooms) {
        if (activeRooms[roomCode].length === 0) {
            delete activeRooms[roomCode];
            console.log(`🗑️ Cleaned up empty room: ${roomCode}`);
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes

// ===== ERROR HANDLING =====
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

// ===== START SERVER =====
const PORT = 3000;
server.listen(PORT, () => {
    console.log('--------------------------------------------------');
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('--------------------------------------------------');
    console.log('📌 Features:');
    console.log('   ✅ Text messaging (saved to DB)');
    console.log('   ✅ Voice messaging (real-time only) 🎤');
    console.log('   ✅ Online users list');
    console.log('   ✅ Auto-delete inactive rooms (15 min)');
    console.log('   ✅ Fast delivery (optimistic UI)');
    console.log('--------------------------------------------------');
    console.log('🎙️ Voice Message Info:');
    console.log('   • Hold mic button to record');
    console.log('   • Release to send');
    console.log('   • Max size: 5MB per message');
    console.log('   • Format: WebM audio (Base64)');
    console.log('   • Storage: Real-time only (not saved to DB)');
    console.log('--------------------------------------------------');
});