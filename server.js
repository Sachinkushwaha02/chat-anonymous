const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 5e6  // 5MB limit for voice messages
});

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

// --- ROOM SCHEMA & MODEL ---
const roomSchema = new mongoose.Schema({
    roomCode: { type: String, unique: true },
    createdBy: String,  // Room creator
    users: [String],
    createdAt: { type: Date, default: Date.now },
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

    // ===== CREATE NEW ROOM =====
    socket.on('create-room', async (data) => {
        const { username, roomCode } = data;

        console.log(`🆕 ${username} wants to create room: ${roomCode}`);

        try {
            // Check if room already exists
            const existingRoom = await Room.findOne({ roomCode });
            
            if (existingRoom) {
                socket.emit('room-error', {
                    message: 'Room code already exists! Please generate a new code.'
                });
                console.log(`❌ Room ${roomCode} already exists`);
                return;
            }

            // Create new room in DB
            const newRoom = new Room({
                roomCode,
                createdBy: username,
                users: [username],
                lastActivity: new Date()
            });
            
            await newRoom.save();
            console.log(`✅ Room ${roomCode} created by ${username}`);

            // Join the room
            currentUser = username;
            currentRoom = roomCode;
            socket.join(roomCode);

            // Initialize in-memory tracking
            activeRooms[roomCode] = [username];

            // Send success
            socket.emit('room-created', { roomCode });
            io.to(roomCode).emit('update-users', activeRooms[roomCode]);
            
            console.log(`📋 Room ${roomCode} initialized`);

        } catch (err) {
            console.error("❌ Error creating room:", err);
            socket.emit('room-error', {
                message: 'Failed to create room. Please try again.'
            });
        }
    });

    // ===== JOIN EXISTING ROOM =====
    socket.on('join-room', async (data) => {
        const { username, roomCode } = data;

        console.log(`🚪 ${username} wants to join room: ${roomCode}`);

        try {
            // Check if room exists
            const room = await Room.findOne({ roomCode });
            
            if (!room) {
                socket.emit('room-error', {
                    message: 'Room code not found! Please check the code.'
                });
                console.log(`❌ Room ${roomCode} does not exist`);
                return;
            }

            // Join room
            currentUser = username;
            currentRoom = roomCode;
            socket.join(roomCode);

            console.log(`👤 ${username} joined room: ${roomCode}`);

            // Add to memory
            if (!activeRooms[roomCode]) {
                activeRooms[roomCode] = [];
            }

            if (!activeRooms[roomCode].includes(username)) {
                activeRooms[roomCode].push(username);
            }

            // Update DB
            await Room.findOneAndUpdate(
                { roomCode },
                { 
                    users: activeRooms[roomCode],
                    lastActivity: new Date()
                }
            );

            // Load history
            const chatHistory = await Message.find({ roomCode }).sort({ createdAt: 1 });
            socket.emit('load-messages', chatHistory);
            console.log(`📜 Loaded ${chatHistory.length} messages`);

            // Notify room
            socket.to(roomCode).emit('system-message', `${username} joined the room`);

            // Send success
            socket.emit('room-joined', { roomCode });
            io.to(roomCode).emit('update-users', activeRooms[roomCode]);

        } catch (err) {
            console.error("❌ Error joining room:", err);
            socket.emit('room-error', {
                message: 'Failed to join room. Please try again.'
            });
        }
    });

    // ===== SEND TEXT MESSAGE =====
    socket.on('send-message', async (data) => {
        const { roomCode, user, text } = data;

        socket.to(roomCode).emit('receive-message', {
            user, text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        console.log(`💬 ${roomCode} - ${user}: ${text.substring(0, 30)}...`);

        try {
            const newMessage = new Message({ roomCode, user, text });
            await newMessage.save();
            
            await Room.findOneAndUpdate(
                { roomCode },
                { lastActivity: new Date() }
            );
        } catch (err) {
            console.error("❌ Error saving message:", err);
        }
    });

    // ===== SEND VOICE MESSAGE =====
    socket.on('send-voice', async (data) => {
        const { roomCode, user, audio } = data;

        socket.to(roomCode).emit('receive-voice', {
            user, audio,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        console.log(`🎤 ${roomCode} - ${user}: Voice (${(audio.length / 1024).toFixed(2)} KB)`);

        try {
            await Room.findOneAndUpdate(
                { roomCode },
                { lastActivity: new Date() }
            );
        } catch (err) {
            console.error("❌ Error updating room:", err);
        }
    });

    // ===== LEAVE ROOM =====
    socket.on('leave-room', async (data) => {
        const { username, roomCode } = data;
        handleUserLeave(username, roomCode);
    });

    // ===== DISCONNECT =====
    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', socket.id);
        if (currentUser && currentRoom) {
            handleUserLeave(currentUser, currentRoom);
        }
    });

    // ===== HELPER: HANDLE USER LEAVE =====
    async function handleUserLeave(username, roomCode) {
        if (!activeRooms[roomCode]) return;

        activeRooms[roomCode] = activeRooms[roomCode].filter(u => u !== username);
        console.log(`👋 ${username} left room: ${roomCode}`);

        if (activeRooms[roomCode].length === 0) {
            delete activeRooms[roomCode];
            console.log(`🗑️ Room ${roomCode} empty (auto-delete in 15 min)`);
        } else {
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

        socket.to(roomCode).emit('system-message', `${username} left the room`);
        
        if (activeRooms[roomCode]) {
            io.to(roomCode).emit('update-users', activeRooms[roomCode]);
        }
    }
});

// ===== AUTO-CLEANUP =====
setInterval(async () => {
    console.log('🧹 Running cleanup...');
    
    for (const roomCode in activeRooms) {
        if (activeRooms[roomCode].length === 0) {
            delete activeRooms[roomCode];
            console.log(`🗑️ Cleaned: ${roomCode}`);
        }
    }
}, 5 * 60 * 1000);

// ===== ERROR HANDLING =====
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('--------------------------------------------------');
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('--------------------------------------------------');
    console.log('✅ FIXED: Room validation enabled');
    console.log('   • Create room = Must generate valid code');
    console.log('   • Join room = Code must exist in DB');
    console.log('   • Invalid codes = Error message');
    console.log('   • Empty rooms = Auto-delete (15 min TTL)');
    console.log('--------------------------------------------------');
});