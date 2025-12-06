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

    // IMPROVED: Handle notification when user joins a community
    // This ensures the community conversation exists and user is added to it
    socket.on("notify_community_conversation", async ({ communityId, username }) => {
      try {
        console.log(`📢 User ${username} notified join for community ${communityId}`);
        
        // Get or create community conversation
        let conversationId;
        const { data: existingConv, error: convFetchErr } = await supabase
          .from("conversations")
          .select("id")
          .eq("community_id", communityId)
          .maybeSingle();

        if (convFetchErr) {
          console.error("Error fetching community conversation:", convFetchErr);
          return;
        }

        if (existingConv) {
          conversationId = existingConv.id;
          console.log(`Found existing conversation ${conversationId} for community ${communityId}`);
        } else {
          // Create conversation for this community if it doesn't exist
          const { data: newConv, error: convErr } = await supabase
            .from("conversations")
            .insert([{
              type: "community",
              community_id: communityId,
              created_by: username,
            }])
            .select("id")
            .maybeSingle();

          if (convErr) {
            console.error("Error creating community conversation:", convErr);
            return;
          }
          if (!newConv) {
            console.error("Failed to create community conversation - no data returned");
            return;
          }
          conversationId = newConv.id;
          console.log(`Created new conversation ${conversationId} for community ${communityId}`);
        }

        // Add user to conversation members if not already there
        const { error: memberAddErr } = await supabase
          .from("conversation_members")
          .upsert(
            [{ conversation_id: conversationId, username }],
            { onConflict: "conversation_id,username" }
          );

        if (memberAddErr) {
          console.error("Error adding user to conversation members:", memberAddErr);
          return;
        }

        console.log(`Added ${username} to conversation ${conversationId} members`);

        // Emit event back to the user to join the community chat
        socket.emit("community_conversation_ready", {
          communityId,
          conversationId,
        });

        // Auto-join the room for them
        const roomName = `community_chat_${communityId}`;
        socket.join(roomName);
        console.log(`✅ Auto-joined ${username} to community chat room ${roomName}`);
      } catch (err) {
        console.error("notify_community_conversation error:", err);
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
          .eq("status", "approved")
          .limit(1);

        if (!membership || membership.length === 0) {
          socket.emit("error", { message: "Not a member of this community" });
          return;
        }

        // 2. Get or create community conversation
        let conversationId;
        const { data: existingConv, error: convFetchErr2 } = await supabase
          .from("conversations")
          .select("id")
          .eq("community_id", communityId)
          .maybeSingle();

        if (convFetchErr2) {
          console.error("Error fetching community conversation:", convFetchErr2);
          socket.emit("error", { message: "Failed to fetch community conversation" });
          return;
        }

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
            .maybeSingle();

          if (convErr) {
            console.error("Error creating community conversation:", convErr);
            socket.emit("error", { message: "Failed to create community conversation" });
            return;
          }
          if (!newConv) {
            console.error("Failed to create community conversation - no data returned");
            socket.emit("error", { message: "Failed to create community conversation" });
            return;
          }
          conversationId = newConv.id;

          // IMPROVED: When creating a new conversation, add all approved members to conversation_members
          const { data: allMembers, error: membersErr } = await supabase
            .from("community_members")
            .select("username")
            .eq("community_id", communityId)
            .eq("status", "approved");

          if (membersErr) {
            console.error("Error fetching community members:", membersErr);
            // Continue anyway - not critical for message sending
          } else if (allMembers && allMembers.length > 0) {
            const memberEntries = allMembers.map(m => ({
              conversation_id: conversationId,
              username: m.username
            }));
            
            const { error: upsertErr } = await supabase
              .from("conversation_members")
              .upsert(memberEntries, { onConflict: "conversation_id,username" });
            
            if (upsertErr) {
              console.error("Error adding members to conversation:", upsertErr);
              // Continue anyway - not critical for message sending
            } else {
              console.log(`Added ${allMembers.length} members to new community conversation ${conversationId}`);
            }
          }
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
          community_id: communityId,
          chatId: conversationId,
          senderId: message.sender_username,
          timestamp: message.created_at,
        };

        // 5. Emit to community chat room
        io.to(roomName).emit("new_community_message", messagePayload);

        // 6. Also emit to all community members' sockets for inbox real-time update
        // This ensures the inbox updates even if user is not in the community chat screen
        const { data: allMembers } = await supabase
          .from("community_members")
          .select("username")
          .eq("community_id", communityId)
          .eq("status", "approved");

        if (allMembers && allMembers.length > 0) {
          allMembers.forEach(member => {
            // Find all sockets of this member
            for (const [id, s] of io.sockets.sockets) {
              if (s.username === member.username) {
                // Emit new_community_message to ensure inbox updates
                s.emit("new_community_message", messagePayload);
                console.log(`Sent community message notification to ${member.username} for inbox update`);
              }
            }
          });
        }

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