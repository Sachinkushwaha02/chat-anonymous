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
});

// --- SCHEMAS ---
const messageSchema = new mongoose.Schema({
    roomCode: String,
    user: String,
    text: String,
    createdAt: { type: Date, default: Date.now, expires: 900 }
});
const Message = mongoose.model('Message', messageSchema);

const roomSchema = new mongoose.Schema({
    roomCode: { type: String, unique: true },
    users: [String],
    lastActivity: { type: Date, default: Date.now, expires: 900 }
});
const Room = mongoose.model('Room', roomSchema);

const activeRooms = {};

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);
    let currentUser = '';
    let currentRoom = '';

    socket.on('join-room', async (data) => {
        const { username, roomCode } = data;
        currentUser = username;
        currentRoom = roomCode;
        socket.join(roomCode);

        if (!activeRooms[roomCode]) activeRooms[roomCode] = [];
        if (!activeRooms[roomCode].includes(username)) activeRooms[roomCode].push(username);

        try {
            await Room.findOneAndUpdate({ roomCode }, { users: activeRooms[roomCode], lastActivity: new Date() }, { upsert: true });
            const chatHistory = await Message.find({ roomCode }).sort({ createdAt: 1 });
            socket.emit('load-messages', chatHistory);
        } catch (err) { console.error(err); }

        socket.to(roomCode).emit('system-message', `${username} joined the room`);
        io.to(roomCode).emit('update-users', activeRooms[roomCode]);
    });

    socket.on('send-message', async (data) => {
        const { roomCode, user, text } = data;
        socket.to(roomCode).emit('receive-message', {
            user, text, timestamp: new Date().toLocaleTimeString()
        });
        try {
            const newMessage = new Message({ roomCode, user, text });
            await newMessage.save();
        } catch (err) { console.error(err); }
    });

    // --- NEW: VOICE MESSAGE EVENT ---
    socket.on('send-voice', (data) => {
        const { roomCode, user, audioData } = data;
        socket.to(roomCode).emit('receive-voice', { user, audioData });
    });

    socket.on('leave-room', (data) => handleUserLeave(data.username, data.roomCode));
    socket.on('disconnect', () => { if (currentUser && currentRoom) handleUserLeave(currentUser, currentRoom); });

    async function handleUserLeave(username, roomCode) {
        if (!activeRooms[roomCode]) return;
        activeRooms[roomCode] = activeRooms[roomCode].filter(u => u !== username);
        if (activeRooms[roomCode].length === 0) delete activeRooms[roomCode];
        socket.to(roomCode).emit('system-message', `${username} left the room`);
        io.to(roomCode).emit('update-users', activeRooms[roomCode] || []);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));