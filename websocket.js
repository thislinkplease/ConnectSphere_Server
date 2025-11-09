const { Server } = require("socket.io");
const { supabase } = require("./db/supabaseClient");

/**
 * Initialize Socket.IO server
 * @param {import('http').Server} httpServer 
 * @param {string[]} allowedOrigins 
 */
function initializeWebSocket(httpServer, allowedOrigins) {
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // Store online users: username -> socket.id
  const onlineUsers = new Map();

  io.on("connection", (socket) => {
    console.log("WebSocket client connected:", socket.id);

    let currentUsername = null;

    // Handle authentication
    const token = socket.handshake.auth.token;
    if (token) {
      // In production, verify JWT token here
      // For now, we'll extract username from the token (base64 encoded: id:timestamp)
      try {
        const decoded = Buffer.from(token, "base64").toString("utf-8");
        const userId = decoded.split(":")[0];
        
        // Get user from database
        supabase
          .from("users")
          .select("username")
          .eq("id", userId)
          .single()
          .then(({ data, error }) => {
            if (!error && data) {
              currentUsername = data.username;
              onlineUsers.set(currentUsername, socket.id);
              
              // Update user online status in database
              supabase
                .from("users")
                .update({ is_online: true })
                .eq("username", currentUsername)
                .then(() => {
                  // Notify others that user is online
                  socket.broadcast.emit("user_status", {
                    username: currentUsername,
                    isOnline: true,
                  });
                });
              
              console.log(`User ${currentUsername} authenticated and online`);
            }
          });
      } catch (err) {
        console.error("Auth error:", err);
      }
    }

    // Join a conversation room
    socket.on("join_conversation", ({ conversationId }) => {
      const roomName = `conversation_${conversationId}`;
      socket.join(roomName);
      console.log(`Socket ${socket.id} joined room ${roomName}`);
    });

    // Leave a conversation room
    socket.on("leave_conversation", ({ conversationId }) => {
      const roomName = `conversation_${conversationId}`;
      socket.leave(roomName);
      console.log(`Socket ${socket.id} left room ${roomName}`);
    });

    // Send a message
    socket.on("send_message", async ({ conversationId, senderUsername, content, replyToMessageId }) => {
      try {
        // Verify sender is a member
        const { data: membership } = await supabase
          .from("conversation_members")
          .select("username")
          .eq("conversation_id", conversationId)
          .eq("username", senderUsername)
          .limit(1);

        if (!membership || membership.length === 0) {
          socket.emit("error", { message: "Not a member of this conversation" });
          return;
        }

        // Insert message into database
        const { data: message, error } = await supabase
          .from("messages")
          .insert([
            {
              conversation_id: conversationId,
              sender_username: senderUsername,
              message_type: "text",
              content,
              reply_to_message_id: replyToMessageId || null,
            },
          ])
          .select("id, conversation_id, sender_username, message_type, content, reply_to_message_id, created_at, updated_at")
          .single();

        if (error) {
          console.error("Error creating message:", error);
          socket.emit("error", { message: "Failed to send message" });
          return;
        }

        // Broadcast the message to all members in the room
        const roomName = `conversation_${conversationId}`;
        io.to(roomName).emit("new_message", message);

        console.log(`Message sent in conversation ${conversationId} by ${senderUsername}`);
      } catch (err) {
        console.error("send_message error:", err);
        socket.emit("error", { message: "Server error while sending message" });
      }
    });

    // Typing indicator
    socket.on("typing", ({ conversationId, username, isTyping }) => {
      const roomName = `conversation_${conversationId}`;
      // Broadcast to others in the room (not sender)
      socket.to(roomName).emit("typing", {
        conversationId,
        username,
        isTyping,
      });
    });

    // Mark messages as read
    socket.on("mark_read", async ({ conversationId, username, upToMessageId }) => {
      try {
        // Fetch target message ids
        let msgQuery = supabase
          .from("messages")
          .select("id")
          .eq("conversation_id", conversationId)
          .order("id", { ascending: true });

        if (upToMessageId) {
          msgQuery = msgQuery.lte("id", upToMessageId);
        }

        const { data: ids } = await msgQuery;

        const toMark = (ids || []).map((r) => ({ message_id: r.id, username }));
        if (toMark.length) {
          await supabase.from("message_reads").upsert(toMark);
        }

        // Broadcast read status to room
        const roomName = `conversation_${conversationId}`;
        io.to(roomName).emit("messages_read", {
          conversationId,
          username,
          upToMessageId,
        });
      } catch (err) {
        console.error("mark_read error:", err);
      }
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log("WebSocket client disconnected:", socket.id);
      
      if (currentUsername) {
        onlineUsers.delete(currentUsername);
        
        // Update user offline status in database
        supabase
          .from("users")
          .update({ 
            is_online: false,
            last_seen: new Date().toISOString() 
          })
          .eq("username", currentUsername)
          .then(() => {
            // Notify others that user is offline
            socket.broadcast.emit("user_status", {
              username: currentUsername,
              isOnline: false,
            });
          });
      }
    });
  });

  console.log("✅ WebSocket server initialized");
  return io;
}

module.exports = { initializeWebSocket };
