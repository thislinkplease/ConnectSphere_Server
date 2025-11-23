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
    let heartbeatInterval = null;

    // Handle authentication
    const token = socket.handshake.auth.token;

    console.log("WebSocket auth attempt:", {
      socketId: socket.id,
      hasToken: !!token,
      tokenLength: token?.length,
    });

    if (token) {
      // Verify Supabase token
      (async () => {
        try {
          const { data: { user }, error } = await supabase.auth.getUser(token);

          if (error || !user) {
            console.error("WebSocket auth failed:", error?.message);
            return;
          }

          console.log("Decoded token - userId:", user.id);

          // Get user from database
          const { data, error: dbError } = await supabase
            .from("users")
            .select("username, id")
            .eq("id", user.id)
            .single();

          if (dbError || !data) {
            console.error("User not found for ID:", user.id, dbError);
            return;
          }

          console.log("User authenticated:", data.username);

          currentUsername = data.username;
          // Store username on socket object for easy lookup
          socket.username = currentUsername;
          onlineUsers.set(currentUsername, socket.id);

          // Update user online status in database with error handling
          const { error: updateError } = await supabase
            .from("users")
            .update({ is_online: true })
            .eq("username", currentUsername);

          if (updateError) {
            console.error("Failed to update online status:", updateError);
          } else {
            console.log(`${currentUsername} marked as online`);

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
          console.error("Auth error:", err);
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
          console.error("Error updating heartbeat status:", err);
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
    // Send a message
    socket.on("send_message", async ({ conversationId, senderUsername, content, replyToMessageId }) => {
      try {
        // 1. Verify membership
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

        // 2. Insert message (giữ nguyên phần insert cũ)
        const { data: message, error } = await supabase
          .from("messages")
          .insert([{
            conversation_id: conversationId,
            sender_username: senderUsername,
            message_type: "text",
            content,
            reply_to_message_id: replyToMessageId || null,
          }])
          .select(`
            id,
            conversation_id,
            sender_username,
            message_type,
            content,
            reply_to_message_id,
            created_at,
            sender:users!messages_sender_username_fkey(id, username, name, avatar, email, country, city, status, bio, age, gender, interests, is_online)
          `)
          .single();

        if (error) {
          console.error("Error creating message:", error);
          socket.emit("error", { message: "Failed to send message" });
          return;
        }

        const roomName = `conversation_${conversationId}`;

        // 3. Build payload
        const messagePayload = {
          ...message,
          chatId: conversationId,
          senderId: message.sender_username,
          timestamp: message.created_at,
        };

        // 4. Get all participants of conversation
        const { data: participants } = await supabase
          .from("conversation_members")
          .select("username")
          .eq("conversation_id", conversationId);

        // 5. Emit confirmation to sender
        socket.emit("message_sent", messagePayload);

        // 6. Ensure each participant's sockets join the room + emit message directly
        if (participants && participants.length > 0) {
          participants.forEach(p => {
            // Find all sockets of this participant using stored username
            for (const [id, s] of io.sockets.sockets) {
              // Use the username stored on socket object (set during auth)
              if (s.username === p.username) {
                // Join room if not yet
                if (!s.rooms.has(roomName)) {
                  s.join(roomName);
                  console.log(`Auto-joined ${p.username} to room ${roomName}`);
                }
                // Emit new_message directly to ensure delivery
                s.emit("new_message", messagePayload);
                console.log(`Sent message directly to ${p.username}`);
              }
            }
          });
        }

        // 7. Broadcast vào room (giữ nguyên để những ai đã trong room nhận)
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

    // ==================== Community Chat Events ====================

    // Join a community chat room
    socket.on("join_community_chat", async ({ communityId }) => {
      try {
        const roomName = `community_chat_${communityId}`;
        socket.join(roomName);
        console.log(`Socket ${socket.id} (${currentUsername}) joined community chat ${communityId}`);

        // Notify others that user joined
        if (currentUsername) {
          socket.to(roomName).emit("user_joined_community_chat", {
            communityId,
            username: currentUsername,
          });
        }
      } catch (err) {
        console.error("join_community_chat error:", err);
      }
    });

    // Leave a community chat room
    socket.on("leave_community_chat", ({ communityId }) => {
      const roomName = `community_chat_${communityId}`;
      socket.leave(roomName);
      console.log(`Socket ${socket.id} left community chat ${communityId}`);

      // Notify others that user left
      if (currentUsername) {
        socket.to(roomName).emit("user_left_community_chat", {
          communityId,
          username: currentUsername,
        });
      }
    });

    // Send a message in community chat
    socket.on("send_community_message", async ({ communityId, senderUsername, content }) => {
      try {
        // 1. Verify user is member of community
        const { data: membership } = await supabase
          .from("community_members")
          .select("username")
          .eq("community_id", communityId)
          .eq("username", senderUsername)
          .limit(1);

        if (!membership || membership.length === 0) {
          socket.emit("error", { message: "Not a member of this community" });
          return;
        }

        // 2. Get or create community conversation
        let conversationId;
        const { data: existingConv } = await supabase
          .from("conversations")
          .select("id")
          .eq("community_id", communityId)
          .single();

        if (existingConv) {
          conversationId = existingConv.id;
        } else {
          // Create conversation for this community
          const { data: newConv, error: convErr } = await supabase
            .from("conversations")
            .insert([{
              type: "community",
              community_id: communityId,
              created_by: senderUsername,
            }])
            .select("id")
            .single();

          if (convErr) throw convErr;
          conversationId = newConv.id;
        }

        // 3. Insert message
        const { data: message, error } = await supabase
          .from("messages")
          .insert([{
            conversation_id: conversationId,
            sender_username: senderUsername,
            message_type: "text",
            content,
          }])
          .select(`
            id,
            conversation_id,
            sender_username,
            message_type,
            content,
            created_at,
            sender:users!messages_sender_username_fkey(id, username, name, avatar, email, country, city, status, bio, age, gender, interests, is_online)
          `)
          .single();

        if (error) {
          console.error("Error creating community message:", error);
          socket.emit("error", { message: "Failed to send message" });
          return;
        }

        const roomName = `community_chat_${communityId}`;

        // 4. Build payload
        const messagePayload = {
          ...message,
          communityId,
          chatId: conversationId,
          senderId: message.sender_username,
          timestamp: message.created_at,
        };

        // 5. Emit to room
        io.to(roomName).emit("new_community_message", messagePayload);

        console.log(`Community message sent in ${communityId} by ${senderUsername}`);
      } catch (err) {
        console.error("send_community_message error:", err);
        socket.emit("error", { message: "Server error while sending message" });
      }
    });

    // Community typing indicator
    socket.on("community_typing", ({ communityId, username, isTyping }) => {
      const roomName = `community_chat_${communityId}`;
      // Broadcast to others in the room (not sender)
      socket.to(roomName).emit("community_typing", {
        communityId,
        username,
        isTyping,
      });
    });
    // Handle disconnect
    socket.on("disconnect", async (reason) => {
      console.log("WebSocket disconnected:", {
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
            console.error("Failed to update offline status:", error);
          } else {
            console.log(`${currentUsername} marked as offline`);

            // Notify others that user is offline
            socket.broadcast.emit("user_status", {
              username: currentUsername,
              isOnline: false,
            });
          }
        } catch (err) {
          console.error("Error in disconnect handler:", err);
        }
      }
    });
  });

  console.log("WebSocket server initialized");
  return io;
}

module.exports = { initializeWebSocket };