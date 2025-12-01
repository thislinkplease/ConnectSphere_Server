const express = require("express");
const multer = require("multer");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");
const upload = multer({ storage: multer.memoryStorage() });
const MSG_BUCKET = "chat-image";

/* --------------------------------- Helpers --------------------------------- */

async function ensureUserExists(username) {
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("username", username)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0;
}

async function getConversationById(conversationId) {
  // Lấy conversation + members cơ bản (không join users để tránh nặng)
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, type, title, created_by, created_at, updated_at, conversation_members(username, role, joined_at, is_muted)"
    )
    .eq("id", conversationId)
    .single();
  if (error) throw error;
  return data || null;
}

async function isMember(conversationId, username) {
  const { data, error } = await supabase
    .from("conversation_members")
    .select("username")
    .eq("conversation_id", conversationId)
    .eq("username", username)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0;
}

async function isAdmin(conversationId, username) {
  const { data, error } = await supabase
    .from("conversation_members")
    .select("role")
    .eq("conversation_id", conversationId)
    .eq("username", username)
    .limit(1);
  if (error) throw error;
  return !!(data && data[0] && data[0].role === "admin");
}

async function getMessageById(messageId) {
  const { data, error } = await supabase
    .from("messages")
    .select(
      "id, conversation_id, sender_username, message_type, content, reply_to_message_id, created_at, updated_at, message_media(id, media_url, media_type, position)"
    )
    .eq("id", messageId)
    .single();
  if (error) throw error;
  return data || null;
}

function storagePathFromPublicUrl(publicUrl, bucket = MSG_BUCKET) {
  try {
    const marker = `/object/public/${bucket}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return null;
    return publicUrl.substring(idx + marker.length);
  } catch {
    return null;
  }
}

/* ---------------------------- Conversations CRUD --------------------------- */

/**
 * Create a conversation (dm or group)
 * POST /messages/conversations
 * Body: { type: 'dm'|'group', created_by, title?, members: string[] }
 * - created_by becomes admin
 * - created_by is auto-added to members (if not present)
 */
/**
 * Create a conversation (dm or group); DM is unique per pair (re-use if exists)
 * POST /messages/conversations
 * Body: { type: 'dm'|'group', created_by, title?, members: string[] }
 */
router.post("/conversations", async (req, res) => {
  const { type, created_by, title = null, members = [] } = req.body;

  if (!type || !created_by) {
    return res.status(400).json({ message: "Missing type or created_by." });
  }

  try {
    const uniqMembers = Array.from(new Set([created_by, ...members]));
    const checks = await Promise.all(uniqMembers.map((u) => ensureUserExists(u)));
    if (checks.some((ok) => !ok)) {
      return res.status(400).json({ message: "Some members do not exist." });
    }

    if (type === "dm") {
      if (uniqMembers.length !== 2) {
        return res.status(400).json({ message: "DM must have exactly 2 distinct members." });
      }
      const [u1, u2] = uniqMembers;

      // All convs of u1
      const { data: convU1, error: e1 } = await supabase
        .from("conversation_members")
        .select("conversation_id")
        .eq("username", u1);
      if (e1) throw e1;
      const setU1 = new Set((convU1 || []).map((r) => r.conversation_id));

      // Convs of u2 intersect u1
      const { data: convU2, error: e2 } = await supabase
        .from("conversation_members")
        .select("conversation_id")
        .eq("username", u2);
      if (e2) throw e2;

      const commonIds = (convU2 || [])
        .map((r) => r.conversation_id)
        .filter((id) => setU1.has(id));

      if (commonIds.length) {
        // See if any is a dm with exactly these 2 users
        const { data: candidates, error: cErr } = await supabase
          .from("conversations")
          .select("id, type")
          .in("id", commonIds)
          .eq("type", "dm");
        if (cErr) throw cErr;

        for (const c of candidates || []) {
          const { data: memRows, error: mErr } = await supabase
            .from("conversation_members")
            .select("username")
            .eq("conversation_id", c.id);
          if (mErr) throw mErr;

          const setNames = new Set((memRows || []).map((r) => r.username));
          if (setNames.size === 2 && setNames.has(u1) && setNames.has(u2)) {
            const existing = await getConversationById(c.id);
            return res.status(200).json({ reused: true, ...existing });
          }
        }
      }
    }

    // Create new
    const { data: conv, error: cErr } = await supabase
      .from("conversations")
      .insert([{ type, title, created_by }])
      .select("*")
      .single();
    if (cErr) throw cErr;

    const rows = uniqMembers.map((u) => ({
      conversation_id: conv.id,
      username: u,
      role: u === created_by ? "admin" : "member",
    }));
    const add = await supabase.from("conversation_members").upsert(rows);
    if (add.error) throw add.error;

    const full = await getConversationById(conv.id);
    res.status(201).json(full);
  } catch (err) {
    console.error("create conversation error:", err);
    res.status(500).json({ message: "Server error while creating conversation." });
  }
});

/**
 * List conversations for a user with last message and unread count
 * GET /messages/conversations?user=<username>
 * Uses view v_conversation_overview(username, conversation_id, last_message_at, unread_count)
 */
router.get("/conversations", async (req, res) => {
  const viewer = (req.query.user || "").trim();
  if (!viewer) return res.status(400).json({ message: "Missing user." });

  try {
    // Which conversations is the viewer in?
    const { data: membership, error: mErr } = await supabase
      .from("conversation_members")
      .select("conversation_id")
      .eq("username", viewer);
    if (mErr) throw mErr;

    const convIds = (membership || []).map((m) => m.conversation_id);
    if (convIds.length === 0) return res.json([]);

    // Fetch minimal conversation info with community_id
    const { data: convs, error: cErr } = await supabase
      .from("conversations")
      .select("id, type, title, created_by, created_at, updated_at, community_id")
      .in("id", convIds);
    if (cErr) throw cErr;

    // Fetch last messages for those conversations, DISAMBIGUATE users join
    const convIdSet = new Set(convIds);
    const { data: lastMsgs, error: lErr } = await supabase
      .from("messages")
      .select(`
        id,
        conversation_id,
        sender_username,
        message_type,
        content,
        created_at,
        message_media(id, media_url, media_type, position),
        sender:users!messages_sender_username_fkey(id, username, name, avatar, email, country, city, status, bio, age, gender, interests, is_online)

      `)
      .in("conversation_id", Array.from(convIdSet))
      .order("created_at", { ascending: false })
      .limit(1000); // heuristic: get plenty, pick 1 per conv
    if (lErr) throw lErr;

    const lastByConv = new Map();
    (lastMsgs || []).forEach((m) => {
      if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m);
    });

    // Calculate unread counts for each conversation
    // Try to use the view first (if it exists), fall back to direct calculation
    const unreadByConv = new Map();
    
    try {
      // Try using the optimized view
      const { data: overview, error: oErr } = await supabase
        .from("v_conversation_overview")
        .select("conversation_id, username, last_message_at, unread_count")
        .eq("username", viewer)
        .in("conversation_id", convIds);
      
      if (!oErr && overview) {
        // View exists and worked
        overview.forEach(o => unreadByConv.set(o.conversation_id, o.unread_count || 0));
      } else {
        throw new Error("View not available, using fallback");
      }
    } catch (viewErr) {
      // Fallback: Calculate unread counts directly (optimized batch query)
      if (convIds.length > 0) {
        // Get all messages for all conversations
        const { data: allConvMsgs, error: allMsgErr } = await supabase
          .from("messages")
          .select("id, conversation_id")
          .in("conversation_id", convIds);
        
        if (!allMsgErr && allConvMsgs) {
          const allMsgIds = allConvMsgs.map(m => m.id);
          
          // Get all messages this user has read
          const { data: allReads, error: readErr } = await supabase
            .from("message_reads")
            .select("message_id")
            .eq("username", viewer)
            .in("message_id", allMsgIds);
          
          if (!readErr) {
            const readIdSet = new Set((allReads || []).map(r => r.message_id));
            
            // Count unread messages per conversation
            const unreadCounts = new Map();
            allConvMsgs.forEach(msg => {
              if (!readIdSet.has(msg.id)) {
                unreadCounts.set(msg.conversation_id, (unreadCounts.get(msg.conversation_id) || 0) + 1);
              }
            });
            
            // Set unread counts (default to 0 if no unread messages)
            convIds.forEach(convId => {
              unreadByConv.set(convId, unreadCounts.get(convId) || 0);
            });
          } else {
            // If error reading, set all to 0
            convIds.forEach(convId => unreadByConv.set(convId, 0));
          }
        } else {
          // If error getting messages, set all to 0
          convIds.forEach(convId => unreadByConv.set(convId, 0));
        }
      }
    }

    // For DM conversations, get the other participant's info (optimized)
    const dmConvs = (convs || []).filter((c) => c.type === "dm");
    const otherParticipants = new Map();
    
    if (dmConvs.length > 0) {
      const dmConvIds = dmConvs.map(c => c.id);
      
      // Fetch all members for DM conversations in one query
      const { data: allMembers, error: memErr } = await supabase
        .from("conversation_members")
        .select("conversation_id, username")
        .in("conversation_id", dmConvIds);
      
      if (!memErr && allMembers) {
        // Group members by conversation_id
        const membersByConv = new Map();
        allMembers.forEach((m) => {
          if (!membersByConv.has(m.conversation_id)) {
            membersByConv.set(m.conversation_id, []);
          }
          membersByConv.get(m.conversation_id).push(m.username);
        });
        
        // Find other usernames
        const otherUsernames = [];
        const convToUsername = new Map();
        membersByConv.forEach((members, convId) => {
          if (members.length === 2) {
            const otherUsername = members.find((u) => u !== viewer);
            if (otherUsername) {
              otherUsernames.push(otherUsername);
              convToUsername.set(convId, otherUsername);
            }
          }
        });
        
        // Fetch all other users in one query
        if (otherUsernames.length > 0) {
          const { data: otherUsers, error: userErr } = await supabase
            .from("users")
            .select("id, username, name, avatar, email, country, city, status, bio, age, gender, interests, is_online")
            .in("username", otherUsernames);
          
          if (!userErr && otherUsers) {
            // Map users by username
            const usersByUsername = new Map(otherUsers.map((u) => [u.username, u]));
            
            // Build the otherParticipants map
            convToUsername.forEach((username, convId) => {
              const user = usersByUsername.get(username);
              if (user) {
                otherParticipants.set(convId, user);
              }
            });
          }
        }
      }
    }

    // For community conversations, get community info
    const communityConvs = (convs || []).filter((c) => c.type === "community" && c.community_id);
    const communityInfo = new Map();
    
    if (communityConvs.length > 0) {
      const communityIds = communityConvs.map(c => c.community_id);
      
      const { data: communities, error: comErr } = await supabase
        .from("communities")
        .select("id, name, image_url, cover_image")
        .in("id", communityIds);
      
      if (!comErr && communities) {
        communities.forEach(com => {
          communityInfo.set(com.id, com);
        });
      }
    }

    const enriched = (convs || [])
      .map((c) => {
        const communityData = c.type === "community" && c.community_id ? communityInfo.get(c.community_id) : null;
        return {
          ...c,
          last_message: lastByConv.get(c.id) || null,
          unread_count: unreadByConv.get(c.id) || 0,
          other_participant: c.type === "dm" ? otherParticipants.get(c.id) || null : null,
          // Add community info for community conversations
          title: c.type === "community" && communityData ? communityData.name : c.title,
          community_avatar: communityData ? (communityData.image_url || communityData.cover_image) : null,
        };
      })
      .sort((a, b) => {
        const ta = a.last_message ? new Date(a.last_message.created_at).getTime() : 0;
        const tb = b.last_message ? new Date(b.last_message.created_at).getTime() : 0;
        return tb - ta;
      });

    res.json(enriched);
  } catch (err) {
    console.error("list conversations error:", err);
    res.status(500).json({ message: "Server error while listing conversations." });
  }
});

/**
 * Get conversation detail
 * GET /messages/conversations/:id
 */
router.get("/conversations/:id", async (req, res) => {
  const conversationId = Number(req.params.id);
  try {
    const conv = await getConversationById(conversationId);
    if (!conv) return res.status(404).json({ message: "Conversation not found." });
    res.json(conv);
  } catch (err) {
    console.error("get conversation error:", err);
    res.status(500).json({ message: "Server error while fetching conversation." });
  }
});

/**
 * Add members (admin only)
 * POST /messages/conversations/:id/members
 * Body: { actor, members: string[] }
 */
router.post("/conversations/:id/members", async (req, res) => {
  const conversationId = Number(req.params.id);
  const { actor, members = [] } = req.body;

  if (!actor || !members.length) return res.status(400).json({ message: "Missing actor or members." });

  try {
    if (!(await isAdmin(conversationId, actor)))
      return res.status(403).json({ message: "Only admin can add members." });

    // Validate existence
    const checks = await Promise.all(members.map((u) => ensureUserExists(u)));
    if (checks.some((ok) => !ok)) return res.status(400).json({ message: "Some members do not exist." });

    const rows = members.map((u) => ({
      conversation_id: conversationId,
      username: u,
      role: "member",
    }));
    const add = await supabase.from("conversation_members").upsert(rows);
    if (add.error) throw add.error;

    const conv = await getConversationById(conversationId);
    res.json(conv);
  } catch (err) {
    console.error("add members error:", err);
    res.status(500).json({ message: "Server error while adding members." });
  }
});

/**
 * Remove a member (admin or self)
 * DELETE /messages/conversations/:id/members/:username
 * Body: { actor }
 */
router.delete("/conversations/:id/members/:username", async (req, res) => {
  const conversationId = Number(req.params.id);
  const target = req.params.username;
  const { actor } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    const isActorAdmin = await isAdmin(conversationId, actor);
    if (!(isActorAdmin || actor === target))
      return res.status(403).json({ message: "Not allowed to remove this member." });

    const del = await supabase
      .from("conversation_members")
      .delete()
      .eq("conversation_id", conversationId)
      .eq("username", target);
    if (del.error) throw del.error;

    const conv = await getConversationById(conversationId);
    res.json(conv);
  } catch (err) {
    console.error("remove member error:", err);
    res.status(500).json({ message: "Server error while removing member." });
  }
});

/* --------------------------------- Messaging -------------------------------- */

/**
 * List messages (paginated)
 * GET /messages/conversations/:id/messages?limit=30&before=<ISO>
 */
router.get("/conversations/:id/messages", async (req, res) => {
  const conversationId = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit || 30), 100);
  const before = req.query.before ? new Date(req.query.before).toISOString() : null;

  try {
    let query = supabase
      .from("messages")
      .select(`
        id,
        conversation_id,
        sender_username,
        message_type,
        content,
        reply_to_message_id,
        created_at,
        updated_at,
        message_media(id, media_url, media_type, position),
        sender:users!messages_sender_username_fkey(id, username, name, avatar)
      `)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (before) query = query.lt("created_at", before);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error("list messages error:", err);
    res.status(500).json({ message: "Server error while listing messages." });
  }
});

/**
 * Send a text message (with optional image)
 * POST /messages/conversations/:id/messages
 * FormData: { sender_username, content, reply_to_message_id?, image? (file) }
 * OR JSON: { sender_username, content, reply_to_message_id? }
 */
router.post("/conversations/:id/messages", upload.single("image"), async (req, res) => {
  const conversationId = Number(req.params.id);
  const { sender_username, content, reply_to_message_id = null } = req.body;
  const imageFile = req.file;

  if (!sender_username || (!content && !reply_to_message_id && !imageFile)) {
    return res.status(400).json({ message: "Missing sender or content." });
  }

  try {
    if (!(await isMember(conversationId, sender_username)))
      return res.status(403).json({ message: "Not a member of this conversation." });

    // Determine message type based on whether there's an image
    const messageType = imageFile ? "image" : "text";

    // Create message
    const { data: message, error } = await supabase
      .from("messages")
      .insert([
        {
          conversation_id: conversationId,
          sender_username,
          message_type: messageType,
          content: content || null,
          reply_to_message_id,
        },
      ])
      .select(
        "id, conversation_id, sender_username, message_type, content, reply_to_message_id, created_at, updated_at"
      )
      .single();
    if (error) throw error;

    // If there's an image, upload it and attach to message
    let messageMedia = null;
    if (imageFile) {
      const clean = imageFile.originalname.replace(/[^\w.\-]+/g, "_");
      const storagePath = `conversations/${conversationId}/${message.id}/${Date.now()}_${clean}`;

      const up = await supabase.storage
        .from(MSG_BUCKET)
        .upload(storagePath, imageFile.buffer, { contentType: imageFile.mimetype, upsert: true });
      if (up.error) throw up.error;

      const { data: pub } = supabase.storage.from(MSG_BUCKET).getPublicUrl(storagePath);
      const media_url = pub.publicUrl;

      const media_type = imageFile.mimetype.startsWith("video")
        ? "video"
        : imageFile.mimetype.startsWith("audio")
        ? "audio"
        : "image";

      const ins = await supabase
        .from("message_media")
        .insert([{ message_id: message.id, media_url, media_type, position: 0 }])
        .select("id, message_id, media_url, media_type, position, created_at")
        .single();
      if (ins.error) throw ins.error;

      messageMedia = [ins.data];
    }

    const result = messageMedia ? { ...message, message_media: messageMedia } : message;
    res.status(201).json(result);
  } catch (err) {
    console.error("send message error:", err);
    res.status(500).json({ message: "Server error while sending message." });
  }
});

/**
 * Send a message with media attachments
 * POST /messages/conversations/:id/messages/media
 * Files: files[] (multi)
 * Body: { sender_username, content? }
 *
 * Creates ONE message, attaches N media rows.
 */
router.post(
  "/conversations/:id/messages/media",
  upload.array("files", 10),
  async (req, res) => {
    const conversationId = Number(req.params.id);
    const { sender_username, content = null } = req.body;
    const files = req.files || [];

    if (!sender_username) return res.status(400).json({ message: "Missing sender_username." });
    if (!(await isMember(conversationId, sender_username)))
      return res.status(403).json({ message: "Not a member of this conversation." });
    if (!files.length && !content)
      return res.status(400).json({ message: "No files or content to send." });

    try {
      // Create message first (type based on first file or text)
      const firstType = files[0]
        ? files[0].mimetype.startsWith("video")
          ? "video"
          : files[0].mimetype.startsWith("audio")
          ? "audio"
          : "image"
        : "text";

      const { data: msg, error: mErr } = await supabase
        .from("messages")
        .insert([
          {
            conversation_id: conversationId,
            sender_username,
            message_type: firstType,
            content, // optional caption
          },
        ])
        .select("id, conversation_id, sender_username, message_type, content, created_at, updated_at")
        .single();
      if (mErr) throw mErr;

      // Upload & attach media
      const attachments = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const clean = f.originalname.replace(/[^\w.\-]+/g, "_");
        const storagePath = `conversations/${conversationId}/${msg.id}/${Date.now()}_${i}_${clean}`;

        const up = await supabase.storage
          .from(MSG_BUCKET)
          .upload(storagePath, f.buffer, { contentType: f.mimetype, upsert: true });
        if (up.error) throw up.error;

        const { data: pub } = supabase.storage.from(MSG_BUCKET).getPublicUrl(storagePath);
        const media_url = pub.publicUrl;

        const media_type = f.mimetype.startsWith("video")
          ? "video"
          : f.mimetype.startsWith("audio")
          ? "audio"
          : "image";

        const ins = await supabase
          .from("message_media")
          .insert([{ message_id: msg.id, media_url, media_type, position: i }])
          .select("id, message_id, media_url, media_type, position, created_at")
          .single();
        if (ins.error) throw ins.error;

        attachments.push(ins.data);
      }

      // Return message with attachments
      res.status(201).json({ ...msg, message_media: attachments });
    } catch (err) {
      console.error("send media message error:", err);
      res.status(500).json({ message: "Server error while sending media message." });
    }
  }
);

/**
 * Delete a message (author only)
 * DELETE /messages/conversations/:id/messages/:messageId
 * Body: { actor }
 */
router.delete("/conversations/:id/messages/:messageId", async (req, res) => {
  const conversationId = Number(req.params.id);
  const messageId = Number(req.params.messageId);
  const { actor } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    const msg = await getMessageById(messageId);
    if (!msg || msg.conversation_id !== conversationId)
      return res.status(404).json({ message: "Message not found." });
    if (msg.sender_username !== actor)
      return res.status(403).json({ message: "Only author can delete this message." });

    const delMedia = await supabase.from("message_media").delete().eq("message_id", messageId);
    if (delMedia.error) throw delMedia.error;

    const delMsg = await supabase.from("messages").delete().eq("id", messageId);
    if (delMsg.error) throw delMsg.error;

    res.json({ message: "Message deleted." });
  } catch (err) {
    console.error("delete message error:", err);
    res.status(500).json({ message: "Server error while deleting message." });
  }
});

/* --------------------------------- Read state -------------------------------- */

/**
 * Mark messages as read up to a point
 * POST /messages/conversations/:id/read
 * Body: { username, up_to_message_id? }
 */
router.post("/conversations/:id/read", async (req, res) => {
  const conversationId = Number(req.params.id);
  const { username, up_to_message_id = null } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    if (!(await isMember(conversationId, username)))
      return res.status(403).json({ message: "Not a member of this conversation." });

    // Fetch target message ids
    let msgQuery = supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .order("id", { ascending: true });

    if (up_to_message_id) {
      msgQuery = msgQuery.lte("id", up_to_message_id);
    }

    const { data: ids, error: idErr } = await msgQuery;
    if (idErr) throw idErr;

    const toMark = (ids || []).map((r) => ({ message_id: r.id, username }));
    if (toMark.length) {
      const up = await supabase.from("message_reads").upsert(toMark);
      if (up.error) throw up.error;
    }

    res.json({ conversation_id: conversationId, read_up_to: up_to_message_id || "all" });
  } catch (err) {
    console.error("mark read error:", err);
    res.status(500).json({ message: "Server error while updating read state." });
  }
});

/* --------------------------------- Reactions -------------------------------- */

/**
 * Add a reaction
 * POST /messages/conversations/:id/reactions
 * Body: { message_id, username, emoji }
 */
router.post("/conversations/:id/reactions", async (req, res) => {
  const conversationId = Number(req.params.id);
  const { message_id, username, emoji } = req.body;

  if (!message_id || !username || !emoji)
    return res.status(400).json({ message: "Missing message_id, username or emoji." });

  try {
    const msg = await getMessageById(Number(message_id));
    if (!msg || msg.conversation_id !== conversationId)
      return res.status(404).json({ message: "Message not found in this conversation." });

    if (!(await isMember(conversationId, username)))
      return res.status(403).json({ message: "Not a member of this conversation." });

    const ins = await supabase.from("message_reactions").insert([{ message_id, username, emoji }]);
    if (ins.error) {
      const msg = String(ins.error.message || "").toLowerCase();
      if (!msg.includes("duplicate")) throw ins.error; // ignore duplicate same reaction
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("add reaction error:", err);
    res.status(500).json({ message: "Server error while adding reaction." });
  }
});

/**
 * Remove a reaction
 * DELETE /messages/conversations/:id/reactions
 * Body: { message_id, username, emoji }
 */
router.delete("/conversations/:id/reactions", async (req, res) => {
  const conversationId = Number(req.params.id);
  const { message_id, username, emoji } = req.body;

  if (!message_id || !username || !emoji)
    return res.status(400).json({ message: "Missing message_id, username or emoji." });

  try {
    const msg = await getMessageById(Number(message_id));
    if (!msg || msg.conversation_id !== conversationId)
      return res.status(404).json({ message: "Message not found in this conversation." });

    const del = await supabase
      .from("message_reactions")
      .delete()
      .eq("message_id", message_id)
      .eq("username", username)
      .eq("emoji", emoji);
    if (del.error) throw del.error;

    res.json({ ok: true });
  } catch (err) {
    console.error("remove reaction error:", err);
    res.status(500).json({ message: "Server error while removing reaction." });
  }
});

module.exports = router;