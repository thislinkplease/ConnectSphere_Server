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
    console.log("🔌 WebSocket client connected:", socket.id);

    let currentUsername = null;
    let heartbeatInterval = null;

    // Handle authentication
    const token = socket.handshake.auth.token;
    
    console.log("🔐 WebSocket auth attempt:", {
      socketId: socket.id,
      hasToken: !!token,
      tokenLength: token?.length,
    });
    
    if (token) {
      // In production, verify JWT token here
      // For now, we'll extract username from the token (base64 encoded: id:timestamp)
      (async () => {
        try {
          const decoded = Buffer.from(token, "base64").toString("utf-8");
          const userId = decoded.split(":")[0];
          
          console.log("🔍 Decoded token - userId:", userId);
          
          // Get user from database
          const { data, error } = await supabase
            .from("users")
            .select("username, id")
            .eq("id", userId)
            .single();
          
          if (error || !data) {
            console.error("❌ User not found for ID:", userId, error);
            return;
          }
          
          console.log("✅ User authenticated:", data.username);
          
          currentUsername = data.username;
          onlineUsers.set(currentUsername, socket.id);
          
          // Update user online status in database with error handling
          const { error: updateError } = await supabase
            .from("users")
            .update({ is_online: true })
            .eq("username", currentUsername);
          
          if (updateError) {
            console.error("❌ Failed to update online status:", updateError);
          } else {
            console.log(`✅ ${currentUsername} marked as online`);
            
            // Notify others that user is online
            socket.broadcast.emit("user_status", {
              username: currentUsername,
              isOnline: true,
            });
          }
          
          // Start heartbeat mechanism
          heartbeatInterval = setInterval(() => {
            socket.emit("heartbeat");
          }, 30000); // Send heartbeat every 30 seconds
          
        } catch (err) {
          console.error("❌ Auth error:", err);
        }
      })();
    }
    
    // Handle heartbeat acknowledgment
    socket.on("heartbeat_ack", async () => {
      // User is still active, refresh online status
      if (currentUsername) {
        try {
          await supabase
            .from("users")
            .update({ 
              is_online: true,
              last_seen: new Date().toISOString()
            })
            .eq("username", currentUsername);
        } catch (err) {
          console.error("❌ Error updating heartbeat status:", err);
        }
      }
    });

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
        // Insert message with sender profile joined
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
          .select(`
            id,
            conversation_id,
            sender_username,
            message_type,
            content,
            reply_to_message_id,
            created_at,
            updated_at,
            sender:users!messages_sender_username_fkey(id, username, name, avatar, email, country, city, status, bio, age, gender, interests, is_online)
          `)
          .single();

        if (error) {
          console.error("Error creating message:", error);
          socket.emit("error", { message: "Failed to send message" });
          return;
        }

// Emit to sender (confirmation) and broadcast to others in the room
const roomName = `conversation_${conversationId}`;

// Create message payload with complete data
const messagePayload = {
  ...message,
  chatId: conversationId,  // Add for client compatibility
  senderId: senderUsername, // Add for client compatibility
  timestamp: message.created_at, // Add for client compatibility
};

// Emit to sender (confirmation)
socket.emit("message_sent", messagePayload);

// Broadcast to ALL clients in the room (including sender) for inbox list updates
// This ensures inbox lists update in real-time for all participants
io.to(roomName).emit("new_message", messagePayload);

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
    socket.on("disconnect", async (reason) => {
      console.log("❌ WebSocket disconnected:", {
        socketId: socket.id,
        username: currentUsername,
        reason,
      });
      
      // Clear heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      
      if (currentUsername) {
        onlineUsers.delete(currentUsername);
        
        try {
          // Update user offline status in database
          const { error } = await supabase
            .from("users")
            .update({ 
              is_online: false,
              last_seen: new Date().toISOString() 
            })
            .eq("username", currentUsername);
          
          if (error) {
            console.error("❌ Failed to update offline status:", error);
          } else {
            console.log(`✅ ${currentUsername} marked as offline`);
            
            // Notify others that user is offline
            socket.broadcast.emit("user_status", {
              username: currentUsername,
              isOnline: false,
            });
          }
        } catch (err) {
          console.error("❌ Error in disconnect handler:", err);
        }
      }
    });
  });

  console.log("✅ WebSocket server initialized");
  return io;
}

module.exports = { initializeWebSocket };
