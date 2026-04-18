const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- MONGODB CONNECTION SETUP ---
const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/anonymousChat';

mongoose.connect(mongoURI, {
    serverSelectionTimeoutMS: 5000
})
.then(() => console.log("✅ MongoDB Connected Successfully!"))
.catch(err => {
    console.error("❌ MongoDB Connection Failed!");
    console.error("Error Detail:", err.message);
    console.log("--------------------------------------------------");
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
    users: [String], // Array of active usernames
    lastActivity: { type: Date, default: Date.now, expires: 900 } // 15 mins TTL
});

const Room = mongoose.model('Room', roomSchema);

// --- IN-MEMORY ROOM TRACKING ---
// Format: { roomCode: [username1, username2, ...] }
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

    // JOIN ROOM
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

        // Send updated user list to ALL users in room
        io.to(roomCode).emit('update-users', activeRooms[roomCode]);
        console.log(`📋 Active users in ${roomCode}:`, activeRooms[roomCode]);
    });

    // SEND MESSAGE
    socket.on('send-message', async (data) => {
        const { roomCode, user, text } = data;

        // STEP 1: Instant broadcast
        socket.to(roomCode).emit('receive-message', {
            user,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        console.log(`💬 Message in ${roomCode} by ${user}: ${text.substring(0, 30)}...`);

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

    // LEAVE ROOM (Explicit)
    socket.on('leave-room', async (data) => {
        const { username, roomCode } = data;
        handleUserLeave(username, roomCode);
    });

    // DISCONNECT (Implicit leave)
    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', socket.id);
        
        if (currentUser && currentRoom) {
            handleUserLeave(currentUser, currentRoom);
        }
    });

    // Helper: Handle user leaving
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

// --- AUTO-CLEANUP: Remove empty rooms from memory every 5 minutes ---
setInterval(async () => {
    console.log('🧹 Running cleanup check...');
    
    for (const roomCode in activeRooms) {
        if (activeRooms[roomCode].length === 0) {
            delete activeRooms[roomCode];
            console.log(`🗑️ Cleaned up empty room: ${roomCode}`);
        }
    }

    // MongoDB TTL index will auto-delete rooms & messages after 15 min of inactivity
}, 5 * 60 * 1000); // Every 5 minutes

// --- ERROR HANDLING ---
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('--------------------------------------------------');
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('--------------------------------------------------');
    console.log('📌 Features:');
    console.log('   ✅ Online users list (live updates)');
    console.log('   ✅ Auto-delete inactive rooms after 15 min');
    console.log('   ✅ Fast message delivery (optimistic UI)');
    console.log('   ✅ Generate random room codes');
    console.log('--------------------------------------------------');
});