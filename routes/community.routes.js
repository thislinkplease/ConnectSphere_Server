const express = require("express");
const multer = require("multer");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");

const upload = multer({ storage: multer.memoryStorage() });

/* --------------------------------- Helpers --------------------------------- */

async function getCommunityById(communityId) {
  const { data, error } = await supabase
    .from("communities")
    .select("*")
    .eq("id", communityId)
    .single();

  if (error) throw error;
  return data || null;
}

async function isCommunityMember(communityId, username) {
  const { data, error } = await supabase
    .from("community_members")
    .select("username")
    .eq("community_id", communityId)
    .eq("username", username)
    .limit(1);

  if (error) throw error;
  return !!(data && data.length > 0);
}

async function isCommunityAdmin(communityId, username) {
  const { data, error } = await supabase
    .from("community_members")
    .select("role")
    .eq("community_id", communityId)
    .eq("username", username)
    .limit(1);

  if (error) throw error;
  return !!(data && data[0] && (data[0].role === "admin" || data[0].role === "moderator"));
}

// Recalculate member_count from community_members table
async function recomputeCommunityMemberCount(communityId) {
  const { count, error } = await supabase
    .from("community_members")
    .select("id", { count: "exact", head: true })
    .eq("community_id", communityId);

  if (error) throw error;

  const { error: updErr } = await supabase
    .from("communities")
    .update({ member_count: count || 0 })
    .eq("id", communityId);

  if (updErr) throw updErr;
  return count || 0;
}

// Recalculate post_count from posts table
async function recomputeCommunityPostCount(communityId) {
  const { count, error } = await supabase
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("community_id", communityId);

  if (error) throw error;

  const { error: updErr } = await supabase
    .from("communities")
    .update({ post_count: count || 0 })
    .eq("id", communityId);

  if (updErr) throw updErr;
  return count || 0;
}

// Recalculate like_count on posts from post_likes table
async function recomputePostLikeCount(postId) {
  const { count, error } = await supabase
    .from("post_likes")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId);

  if (error) throw error;

  const { error: updErr } = await supabase
    .from("posts")
    .update({ like_count: count || 0 })
    .eq("id", postId);

  if (updErr) throw updErr;
  return count || 0;
}

// Recalculate comment_count on posts from comments table
async function recomputePostCommentCount(postId) {
  const { count, error } = await supabase
    .from("comments")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId);

  if (error) throw error;

  const { error: updErr } = await supabase
    .from("posts")
    .update({ comment_count: count || 0 })
    .eq("id", postId);

  if (updErr) throw updErr;
  return count || 0;
}

/* ---------------------------- Community CRUD ------------------------------- */

/**
 * Create a community (PRO users only)
 * POST /communities
 * Body: { created_by, name, description?, image_url?, is_private? }
 */
router.post("/", async (req, res) => {
  const { created_by, name, description, image_url, is_private = false } = req.body;

  if (!created_by || !name) {
    return res.status(400).json({ message: "Missing created_by or name." });
  }

  try {
    // Check if user is PRO
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("is_premium")
      .eq("username", created_by)
      .single();
    
    if (userErr) throw userErr;
    
    if (!user || !user.is_premium) {
      return res.status(403).json({ 
        message: "Only PRO users can create communities.",
        requiresPro: true 
      });
    }

    const { data, error } = await supabase
      .from("communities")
      .insert([{ created_by, name, description, image_url, is_private }])
      .select("*")
      .single();

    if (error) throw error;

    // Add creator as admin member
    await supabase
      .from("community_members")
      .insert([{ community_id: data.id, username: created_by, role: "admin" }]);

    await recomputeCommunityMemberCount(data.id);
    
    // Create a conversation for community chat
    try {
      await supabase
        .from("conversations")
        .insert([{
          type: "community",
          community_id: data.id,
          created_by: created_by,
        }]);
    } catch (convErr) {
      console.error("Error creating community conversation:", convErr);
      // Don't fail the whole operation if conversation creation fails
    }

    res.status(201).json(data);
  } catch (err) {
    console.error("create community error:", err);
    res.status(500).json({ message: "Server error while creating community." });
  }
});

/**
 * Get all communities or search
 * GET /communities?q=<search>&limit=20
 */
router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const q = (req.query.q || "").trim();

  try {
    let query = supabase
      .from("communities")
      .select("*")
      .order("member_count", { ascending: false })
      .limit(limit);

    if (q) {
      query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error("list communities error:", err);
    res.status(500).json({ message: "Server error while fetching communities." });
  }
});

/**
 * Get suggested communities (top by member count)
 * GET /communities/suggested?limit=10
 */
router.get("/suggested", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 10), 50);

  try {
    const { data, error } = await supabase
      .from("communities")
      .select("*")
      .order("member_count", { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("suggested communities error:", err);
    res.status(500).json({ message: "Server error while fetching suggested communities." });
  }
});

/**
 * Get a single community
 * GET /communities/:id?viewer=<username>
 */
router.get("/:id", async (req, res) => {
  const communityId = Number(req.params.id);
  const viewer = (req.query.viewer || "").trim();

  try {
    const community = await getCommunityById(communityId);
    if (!community) return res.status(404).json({ message: "Community not found." });

    let isMember = false;
    if (viewer) {
      isMember = await isCommunityMember(communityId, viewer);
    }

    res.json({ ...community, is_member: isMember });
  } catch (err) {
    console.error("get community error:", err);
    res.status(500).json({ message: "Server error while fetching community." });
  }
});

/**
 * Update community (admin only)
 * PUT /communities/:id
 * Body: { actor, name?, description?, image_url?, is_private? }
 */
router.put("/:id", async (req, res) => {
  const communityId = Number(req.params.id);
  const { actor, name, description, image_url, is_private } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    if (!(await isCommunityAdmin(communityId, actor))) {
      return res.status(403).json({ message: "Only admin can update community." });
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (image_url !== undefined) updates.image_url = image_url;
    if (is_private !== undefined) updates.is_private = is_private;

    const { data, error } = await supabase
      .from("communities")
      .update(updates)
      .eq("id", communityId)
      .select("*")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("update community error:", err);
    res.status(500).json({ message: "Server error while updating community." });
  }
});

/**
 * Delete community (creator only)
 * DELETE /communities/:id
 * Body: { actor }
 */
router.delete("/:id", async (req, res) => {
  const communityId = Number(req.params.id);
  const { actor } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    const community = await getCommunityById(communityId);
    if (!community) return res.status(404).json({ message: "Community not found." });
    if (community.created_by !== actor) {
      return res.status(403).json({ message: "Only creator can delete community." });
    }

    const { error } = await supabase.from("communities").delete().eq("id", communityId);
    if (error) throw error;

    res.json({ message: "Community deleted." });
  } catch (err) {
    console.error("delete community error:", err);
    res.status(500).json({ message: "Server error while deleting community." });
  }
});

/* -------------------------- Community Members ------------------------------ */

/**
 * Join a community (public only - private requires join request)
 * POST /communities/:id/join
 * Body: { username }
 */
router.post("/:id/join", async (req, res) => {
  const communityId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const community = await getCommunityById(communityId);
    if (!community) return res.status(404).json({ message: "Community not found." });

    if (community.is_private) {
      return res.status(403).json({ 
        message: "Cannot join private community directly. Please send a join request.",
        requiresRequest: true
      });
    }

    const { data, error } = await supabase
      .from("community_members")
      .upsert(
        [{ community_id: communityId, username, role: "member" }],
        { onConflict: "community_id,username" }
      )
      .select("*")
      .single();

    if (error) throw error;

    await recomputeCommunityMemberCount(communityId);

    // Auto-add member to community chat conversation
    try {
      // Get or create community conversation
      const { data: conv, error: convErr } = await supabase
        .from("conversations")
        .select("id")
        .eq("community_id", communityId)
        .single();

      if (conv && conv.id) {
        // Add member to conversation
        await supabase
          .from("conversation_members")
          .upsert(
            [{ conversation_id: conv.id, username }],
            { onConflict: "conversation_id,username" }
          );
        console.log(`Auto-added ${username} to community ${communityId} chat`);
      }
    } catch (chatErr) {
      console.error("Error adding member to community chat:", chatErr);
      // Don't fail the join operation if chat addition fails
    }

    res.json(data);
  } catch (err) {
    console.error("join community error:", err);
    res.status(500).json({ message: "Server error while joining community." });
  }
});

/**
 * Leave a community
 * DELETE /communities/:id/join
 * Body: { username }
 */
router.delete("/:id/join", async (req, res) => {
  const communityId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { error } = await supabase
      .from("community_members")
      .delete()
      .eq("community_id", communityId)
      .eq("username", username);

    if (error) throw error;

    await recomputeCommunityMemberCount(communityId);

    res.json({ message: "Left community." });
  } catch (err) {
    console.error("leave community error:", err);
    res.status(500).json({ message: "Server error while leaving community." });
  }
});

/**
 * Get community members
 * GET /communities/:id/members
 */
router.get("/:id/members", async (req, res) => {
  const communityId = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit || 50), 100);

  try {
    const { data: members, error } = await supabase
      .from("community_members")
      .select("username, role, joined_at")
      .eq("community_id", communityId)
      .order("joined_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    if (!members || members.length === 0) return res.json([]);

    const usernames = members.map((m) => m.username);
    const { data: users, error: uErr } = await supabase
      .from("users")
      .select("id, username, name, avatar, bio")
      .in("username", usernames);

    if (uErr) throw uErr;

    const userMap = new Map(users.map((u) => [u.username, u]));
    const enriched = members.map((m) => ({
      ...m,
      user: userMap.get(m.username) || null,
    }));

    res.json(enriched);
  } catch (err) {
    console.error("get community members error:", err);
    res.status(500).json({ message: "Server error while fetching members." });
  }
});

/* --------------------------- Community Posts ------------------------------- */

/**
 * Create a community post
 * POST /communities/:id/posts
 * FormData: { author_username, content?, audience?, disable_comments?, hide_like_count?, image (optional file) }
 *
 * Viết vào bảng `posts` + `post_media`, gắn `community_id`.
 */
router.post("/:id/posts", upload.single("image"), async (req, res) => {
  const communityId = Number(req.params.id);
  const {
    author_username,
    content = null,
    audience = "followers",
    disable_comments = "false",
    hide_like_count = "false",
  } = req.body;
  const file = req.file;

  if (!author_username || (!content && !file)) {
    return res.status(400).json({ message: "Missing author or content/media." });
  }

  try {
    const community = await getCommunityById(communityId);
    if (!community) return res.status(404).json({ message: "Community not found." });

    if (!(await isCommunityMember(communityId, author_username))) {
      return res.status(403).json({ message: "Must be a member to post." });
    }

    // Create post trong bảng posts
    const { data: post, error: postErr } = await supabase
      .from("posts")
      .insert([
        {
          author_username,
          content,
          status: null,
          audience,
          disable_comments: String(disable_comments) === "true",
          hide_like_count: String(hide_like_count) === "true",
          community_id: communityId,
        },
      ])
      .select("*")
      .single();

    if (postErr) throw postErr;

    let mediaRows = [];
    if (file) {
      const cleanName = file.originalname.replace(/[^\w.\-]+/g, "_");
      const storagePath = `posts/${post.id}/${Date.now()}_0_${cleanName}`;

      const uploadRes = await supabase.storage
        .from("posts")
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadRes.error) throw uploadRes.error;

      const { data: pub } = supabase.storage.from("posts").getPublicUrl(storagePath);
      const media_url = pub.publicUrl;

      const { data: pm, error: pmErr } = await supabase
        .from("post_media")
        .insert([
          {
            post_id: post.id,
            media_url,
            media_type: file.mimetype.startsWith("video") ? "video" : "image",
            position: 0,
          },
        ])
        .select("*")
        .single();

      if (pmErr) throw pmErr;
      mediaRows.push(pm);
    }

    // Author info
    let author = null;
    const { data: authorData } = await supabase
      .from("users")
      .select("username, name, avatar")
      .eq("username", author_username)
      .single();

    if (authorData) author = authorData;

    await recomputeCommunityPostCount(communityId);

    const response = {
      ...post,
      community_name: community.name,
      post_media: mediaRows,
      author_avatar: author ? author.avatar : null,
      author_display_name: author ? author.name || author.username : post.author_username,
    };

    res.status(201).json(response);
  } catch (err) {
    console.error("create community post error:", err);
    res.status(500).json({ message: "Server error while creating post." });
  }
});

/**
 * Get community posts
 * GET /communities/:id/posts?limit=20&before=<ISO>
 *
 * Lấy từ bảng `posts` filter theo community_id, join thêm author + post_media.
 */
router.get("/:id/posts", async (req, res) => {
  const communityId = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const before = req.query.before ? new Date(req.query.before).toISOString() : null;
  const viewer = (req.query.viewer || "").trim();

  try {
    const community = await getCommunityById(communityId);
    if (!community) return res.status(404).json({ message: "Community not found." });

    // Check membership for private communities
    if (community.is_private) {
      if (!viewer) {
        return res.status(403).json({ message: "Must be logged in to view private community posts." });
      }
      
      const isMember = await isCommunityMember(communityId, viewer);
      if (!isMember) {
        // Return empty array instead of error so UI can still show community info
        return res.json([]);
      }
    }

    let query = supabase
      .from("posts")
      .select(
        "id, author_username, content, status, audience, disable_comments, hide_like_count, like_count, comment_count, community_id, created_at, updated_at"
      )
      .eq("community_id", communityId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (before) {
      query = query.lt("created_at", before);
    }

    const { data: posts, error: postsErr } = await query;
    if (postsErr) throw postsErr;

    if (!posts || posts.length === 0) {
      return res.json([]);
    }

    const postIds = posts.map((p) => p.id);
    const authorUsernames = [...new Set(posts.map((p) => p.author_username).filter(Boolean))];

    // Media
    const { data: media, error: mediaErr } = await supabase
      .from("post_media")
      .select("id, post_id, media_url, media_type, position")
      .in("post_id", postIds)
      .order("position", { ascending: true });

    if (mediaErr) throw mediaErr;

    // Authors
    let users = [];
    if (authorUsernames.length > 0) {
      const { data: usersData, error: usersErr } = await supabase
        .from("users")
        .select("username, name, avatar")
        .in("username", authorUsernames);

      if (usersErr) throw usersErr;
      users = usersData || [];
    }

    const userMap = new Map(users.map((u) => [u.username, u]));
    const mediaMap = new Map();
    (media || []).forEach((m) => {
      const arr = mediaMap.get(m.post_id) || [];
      arr.push(m);
      mediaMap.set(m.post_id, arr);
    });

    const enriched = posts.map((p) => {
      const author = userMap.get(p.author_username) || null;
      return {
        ...p,
        community_name: community.name,
        post_media: mediaMap.get(p.id) || [],
        author_avatar: author ? author.avatar : null,
        author_display_name: author ? author.name || author.username : p.author_username,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error("get community posts error:", err);
    res.status(500).json({ message: "Server error while fetching posts." });
  }
});

/**
 * Delete a community post (author or admin)
 * DELETE /communities/:id/posts/:postId
 * Body: { actor }
 */
router.delete("/:id/posts/:postId", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);
  const { actor } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("*")
      .eq("id", postId)
      .eq("community_id", communityId)
      .single();

    if (pErr || !post) {
      return res.status(404).json({ message: "Post not found." });
    }

    const isAdmin = await isCommunityAdmin(communityId, actor);
    if (post.author_username !== actor && !isAdmin) {
      return res.status(403).json({ message: "Not allowed to delete this post." });
    }

    const { error } = await supabase.from("posts").delete().eq("id", postId);
    if (error) throw error;

    await recomputeCommunityPostCount(communityId);

    res.json({ message: "Post deleted." });
  } catch (err) {
    console.error("delete community post error:", err);
    res.status(500).json({ message: "Server error while deleting post." });
  }
});

/* ------------------------- Community Post Likes ---------------------------- */

/**
 * Like a community post (uses main post_likes table)
 * POST /communities/:id/posts/:postId/like
 * Body: { username }
 */
router.post("/:id/posts/:postId/like", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    // Ensure post exists & belongs to this community
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id, community_id")
      .eq("id", postId)
      .single();

    if (pErr || !post || post.community_id !== communityId) {
      return res.status(404).json({ message: "Post not found in this community." });
    }

    const { error: insertErr } = await supabase
      .from("post_likes")
      .insert([{ post_id: postId, username }]);

    if (insertErr && !String(insertErr.message).toLowerCase().includes("duplicate")) {
      throw insertErr;
    }

    const likeCount = await recomputePostLikeCount(postId);

    res.json({ post_id: postId, like_count: likeCount });
  } catch (err) {
    console.error("like community post error:", err);
    res.status(500).json({ message: "Server error while liking post." });
  }
});

/**
 * Unlike a community post
 * DELETE /communities/:id/posts/:postId/like
 * Body: { username }
 */
router.delete("/:id/posts/:postId/like", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    // Ensure post exists & belongs to this community
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id, community_id")
      .eq("id", postId)
      .single();

    if (pErr || !post || post.community_id !== communityId) {
      return res.status(404).json({ message: "Post not found in this community." });
    }

    const { error: delErr } = await supabase
      .from("post_likes")
      .delete()
      .eq("post_id", postId)
      .eq("username", username);

    if (delErr) throw delErr;

    const likeCount = await recomputePostLikeCount(postId);

    res.json({ post_id: postId, like_count: likeCount });
  } catch (err) {
    console.error("unlike community post error:", err);
    res.status(500).json({ message: "Server error while unliking post." });
  }
});

/* ----------------------- Community Post Comments --------------------------- */

/**
 * Add a comment to a community post (uses main comments table)
 * POST /communities/:id/posts/:postId/comments
 * Body: { author_username, content, parent_id? }
 */
router.post("/:id/posts/:postId/comments", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);
  const { author_username, content, parent_id = null } = req.body;

  if (!author_username || !content) {
    return res.status(400).json({ message: "Missing author or content." });
  }

  try {
    // Ensure post exists & belongs to this community
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id, community_id")
      .eq("id", postId)
      .single();

    if (pErr || !post || post.community_id !== communityId) {
      return res.status(404).json({ message: "Post not found in this community." });
    }

    const { data, error } = await supabase
      .from("comments")
      .insert([{ post_id: postId, author_username, content, parent_id }])
      .select("*")
      .single();

    if (error) throw error;

    await recomputePostCommentCount(postId);

    res.status(201).json(data);
  } catch (err) {
    console.error("add comment error:", err);
    res.status(500).json({ message: "Server error while adding comment." });
  }
});

/**
 * Get comments for a community post
 * GET /communities/:id/posts/:postId/comments?parent_id=<id|null>
 */
router.get("/:id/posts/:postId/comments", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);
  const hasParent = typeof req.query.parent_id !== "undefined";
  const parentId = req.query.parent_id === "null" ? null : Number(req.query.parent_id);

  try {
    // Ensure post exists & belongs to this community
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id, community_id")
      .eq("id", postId)
      .single();

    if (pErr || !post || post.community_id !== communityId) {
      return res.status(404).json({ message: "Post not found in this community." });
    }

    let query = supabase
      .from("comments")
      .select("*")
      .eq("post_id", postId)
      .order("created_at", { ascending: true });

    if (hasParent) {
      if (parentId === null) query = query.is("parent_id", null);
      else query = query.eq("parent_id", parentId);
    } else {
      query = query.is("parent_id", null);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error("get comments error:", err);
    res.status(500).json({ message: "Server error while fetching comments." });
  }
});

/**
 * Get ALL comments of a community post
 * GET /communities/:id/posts/:postId/comments/all
 */
router.get("/:id/posts/:postId/comments/all", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);

  try {
    // ensure post exists
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id, community_id")
      .eq("id", postId)
      .single();

    if (pErr || !post || post.community_id !== communityId) {
      return res.status(404).json({ message: "Post not found in this community." });
    }

    // load ALL comments
    const { data: all, error } = await supabase
      .from("comments")
      .select("*")
      .eq("post_id", postId)
      .order("created_at", { ascending: true });

    if (error) throw error;

    res.json(all || []);
  } catch (err) {
    console.error("get all comments error:", err);
    res.status(500).json({ message: "Server error while fetching all comments." });
  }
});

/**
 * Delete a community post comment (author or admin)
 * DELETE /communities/:id/posts/:postId/comments/:commentId
 * Body: { actor }
 */
router.delete("/:id/posts/:postId/comments/:commentId", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);
  const commentId = Number(req.params.commentId);
  const { actor } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    // Ensure post exists & belongs to this community
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id, community_id")
      .eq("id", postId)
      .single();

    if (pErr || !post || post.community_id !== communityId) {
      return res.status(404).json({ message: "Post not found in this community." });
    }

    const { data: comment, error: cErr } = await supabase
      .from("comments")
      .select("*")
      .eq("id", commentId)
      .eq("post_id", postId)
      .single();

    if (cErr || !comment) return res.status(404).json({ message: "Comment not found." });

    const isAdmin = await isCommunityAdmin(communityId, actor);
    if (comment.author_username !== actor && !isAdmin) {
      return res.status(403).json({ message: "Not allowed to delete this comment." });
    }

    const { error } = await supabase.from("comments").delete().eq("id", commentId);
    if (error) throw error;

    await recomputePostCommentCount(postId);

    res.json({ message: "Comment deleted." });
  } catch (err) {
    console.error("delete comment error:", err);
    res.status(500).json({ message: "Server error while deleting comment." });
  }
});

/**
 * Edit a community post comment (author or admin)
 * PATCH /communities/:id/posts/:postId/comments/:commentId
 * Body: { actor, content }
 */
router.patch("/:id/posts/:postId/comments/:commentId", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);
  const commentId = Number(req.params.commentId);
  const { actor, content } = req.body;

  if (!actor || !content) {
    return res.status(400).json({ message: "Missing actor or content." });
  }

  try {
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id, community_id")
      .eq("id", postId)
      .single();

    if (pErr || !post || post.community_id !== communityId) {
      return res.status(404).json({ message: "Post not found in this community." });
    }

    const { data: comment, error: cErr } = await supabase
      .from("comments")
      .select("*")
      .eq("id", commentId)
      .eq("post_id", postId)
      .single();

    if (cErr || !comment) {
      return res.status(404).json({ message: "Comment not found." });
    }

    const isAdmin = await isCommunityAdmin(communityId, actor);
    if (comment.author_username !== actor && !isAdmin) {
      return res.status(403).json({ message: "Not allowed to edit this comment." });
    }

    const { data: updated, error: updErr } = await supabase
      .from("comments")
      .update({ content })
      .eq("id", commentId)
      .select("*")
      .single();

    if (updErr) throw updErr;

    res.json(updated);
  } catch (err) {
    console.error("edit comment error:", err);
    res.status(500).json({ message: "Server error while editing comment." });
  }
});

/* ------------------------- User's Communities ------------------------------ */

/**
 * Get communities a user has joined
 * GET /communities/user/:username/joined
 */
router.get("/user/:username/joined", async (req, res) => {
  const { username } = req.params;
  const limit = Math.min(Number(req.query.limit || 20), 100);

  try {
    const { data: memberships, error: mErr } = await supabase
      .from("community_members")
      .select("community_id, role, joined_at")
      .eq("username", username);

    if (mErr) throw mErr;

    if (!memberships || memberships.length === 0) return res.json([]);

    const communityIds = memberships.map((m) => m.community_id);
    const { data: communities, error: cErr } = await supabase
      .from("communities")
      .select("*")
      .in("id", communityIds)
      .order("member_count", { ascending: false })
      .limit(limit);

    if (cErr) throw cErr;
    res.json(communities || []);
  } catch (err) {
    console.error("get user communities error:", err);
    res.status(500).json({ message: "Server error while fetching user communities." });
  }
});

/* ------------------------- Admin Management -------------------------------- */

/**
 * Update member role (admin/moderator only)
 * POST /communities/:id/members/:username/role
 * Body: { actor, role: 'admin'|'moderator'|'member' }
 */
router.post("/:id/members/:username/role", async (req, res) => {
  const communityId = Number(req.params.id);
  const targetUsername = req.params.username;
  const { actor, role } = req.body;

  if (!actor || !role) {
    return res.status(400).json({ message: "Missing actor or role." });
  }

  if (!["admin", "moderator", "member"].includes(role)) {
    return res.status(400).json({ message: "Invalid role." });
  }

  try {
    // Check if actor is admin
    if (!(await isCommunityAdmin(communityId, actor))) {
      return res.status(403).json({ message: "Only admins can change member roles." });
    }

    // Update role
    const { data, error } = await supabase
      .from("community_members")
      .update({ role })
      .eq("community_id", communityId)
      .eq("username", targetUsername)
      .select("*")
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("update member role error:", err);
    res.status(500).json({ message: "Server error while updating member role." });
  }
});

/**
 * Kick a member from community (admin/moderator only)
 * DELETE /communities/:id/members/:username
 * Body: { actor }
 */
router.delete("/:id/members/:username", async (req, res) => {
  const communityId = Number(req.params.id);
  const targetUsername = req.params.username;
  const { actor } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    // Check if actor is admin or moderator
    if (!(await isCommunityAdmin(communityId, actor))) {
      return res.status(403).json({ message: "Only admins/moderators can kick members." });
    }

    // Cannot kick yourself
    if (actor === targetUsername) {
      return res.status(400).json({ message: "Cannot kick yourself. Use leave instead." });
    }

    // Check if target is creator
    const community = await getCommunityById(communityId);
    if (community.created_by === targetUsername) {
      return res.status(403).json({ message: "Cannot kick the community creator." });
    }

    const { error } = await supabase
      .from("community_members")
      .delete()
      .eq("community_id", communityId)
      .eq("username", targetUsername);

    if (error) throw error;

    await recomputeCommunityMemberCount(communityId);

    res.json({ message: "Member kicked successfully." });
  } catch (err) {
    console.error("kick member error:", err);
    res.status(500).json({ message: "Server error while kicking member." });
  }
});

/**
 * Upload community avatar (admin only)
 * POST /communities/:id/avatar
 * FormData: { actor, avatar: File }
 */
router.post("/:id/avatar", upload.single("avatar"), async (req, res) => {
  const communityId = Number(req.params.id);
  const { actor } = req.body;
  const file = req.file;

  if (!actor) return res.status(400).json({ message: "Missing actor." });
  if (!file) return res.status(400).json({ message: "Missing avatar file." });

  try {
    if (!(await isCommunityAdmin(communityId, actor))) {
      return res.status(403).json({ message: "Only admins can upload avatar." });
    }

    const cleanName = file.originalname.replace(/[^\w.\-]+/g, "_");
    const storagePath = `community/${communityId}/avatar_${Date.now()}_${cleanName}`;

    const uploadRes = await supabase.storage
      .from("community")
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadRes.error) throw uploadRes.error;

    const { data: pub } = supabase.storage.from("community").getPublicUrl(storagePath);
    const image_url = pub.publicUrl;

    const { data, error } = await supabase
      .from("communities")
      .update({ image_url })
      .eq("id", communityId)
      .select("*")
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("upload avatar error:", err);
    res.status(500).json({ message: "Server error while uploading avatar." });
  }
});

/**
 * Upload community cover image (admin only)
 * POST /communities/:id/cover
 * FormData: { actor, cover: File }
 */
router.post("/:id/cover", upload.single("cover"), async (req, res) => {
  const communityId = Number(req.params.id);
  const { actor } = req.body;
  const file = req.file;

  if (!actor) return res.status(400).json({ message: "Missing actor." });
  if (!file) return res.status(400).json({ message: "Missing cover file." });

  try {
    if (!(await isCommunityAdmin(communityId, actor))) {
      return res.status(403).json({ message: "Only admins can upload cover image." });
    }

    const cleanName = file.originalname.replace(/[^\w.\-]+/g, "_");
    const storagePath = `community/${communityId}/cover_${Date.now()}_${cleanName}`;

    const uploadRes = await supabase.storage
      .from("community")
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadRes.error) throw uploadRes.error;

    const { data: pub } = supabase.storage.from("community").getPublicUrl(storagePath);
    const cover_image = pub.publicUrl;

    const { data, error } = await supabase
      .from("communities")
      .update({ cover_image })
      .eq("id", communityId)
      .select("*")
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("upload cover error:", err);
    res.status(500).json({ message: "Server error while uploading cover." });
  }
});

/* ----------------------- Join Request Management --------------------------- */

/**
 * Request to join a private community
 * POST /communities/:id/join-request
 * Body: { username }
 */
router.post("/:id/join-request", async (req, res) => {
  const communityId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const community = await getCommunityById(communityId);
    if (!community) return res.status(404).json({ message: "Community not found." });

    if (!community.is_private) {
      return res.status(400).json({ message: "This community is public, join directly." });
    }

    // Check if already a member
    if (await isCommunityMember(communityId, username)) {
      return res.status(400).json({ message: "Already a member." });
    }

    // Create or update join request
    const { data, error } = await supabase
      .from("community_join_requests")
      .upsert(
        [{ community_id: communityId, username, status: "pending" }],
        { onConflict: "community_id,username" }
      )
      .select("*")
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    console.error("join request error:", err);
    res.status(500).json({ message: "Server error while creating join request." });
  }
});

/**
 * Get join requests for a community (admin only)
 * GET /communities/:id/join-requests?actor=<username>&status=pending
 */
router.get("/:id/join-requests", async (req, res) => {
  const communityId = Number(req.params.id);
  const actor = (req.query.actor || "").trim();
  const status = (req.query.status || "pending").trim();

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    if (!(await isCommunityAdmin(communityId, actor))) {
      return res.status(403).json({ message: "Only admins can view join requests." });
    }

    const { data, error } = await supabase
      .from("community_join_requests")
      .select("*")
      .eq("community_id", communityId)
      .eq("status", status)
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Enrich with user info
    if (data && data.length > 0) {
      const usernames = data.map((r) => r.username);
      const { data: users, error: uErr } = await supabase
        .from("users")
        .select("username, name, avatar, bio")
        .in("username", usernames);

      if (uErr) throw uErr;

      const userMap = new Map(users.map((u) => [u.username, u]));
      const enriched = data.map((r) => ({
        ...r,
        user: userMap.get(r.username) || null,
      }));

      return res.json(enriched);
    }

    res.json(data || []);
  } catch (err) {
    console.error("get join requests error:", err);
    res.status(500).json({ message: "Server error while fetching join requests." });
  }
});

/**
 * Review a join request (admin only)
 * POST /communities/:id/join-requests/:requestId
 * Body: { actor, action: 'approve'|'reject' }
 */
router.post("/:id/join-requests/:requestId", async (req, res) => {
  const communityId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  const { actor, action } = req.body;

  if (!actor || !action) {
    return res.status(400).json({ message: "Missing actor or action." });
  }

  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({ message: "Invalid action." });
  }

  try {
    if (!(await isCommunityAdmin(communityId, actor))) {
      return res.status(403).json({ message: "Only admins can review join requests." });
    }

    // Get request
    const { data: request, error: rErr } = await supabase
      .from("community_join_requests")
      .select("*")
      .eq("id", requestId)
      .eq("community_id", communityId)
      .single();

    if (rErr || !request) {
      return res.status(404).json({ message: "Join request not found." });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ message: "Request already reviewed." });
    }

    const newStatus = action === "approve" ? "approved" : "rejected";

    // Update request
    await supabase
      .from("community_join_requests")
      .update({
        status: newStatus,
        reviewed_at: new Date().toISOString(),
        reviewed_by: actor,
      })
      .eq("id", requestId);

    // If approved, add to members
    if (action === "approve") {
      await supabase
        .from("community_members")
        .insert([{
          community_id: communityId,
          username: request.username,
          role: "member",
        }]);

      await recomputeCommunityMemberCount(communityId);

      // Auto-add member to community chat conversation
      try {
        const { data: conv, error: convErr } = await supabase
          .from("conversations")
          .select("id")
          .eq("community_id", communityId)
          .single();

        if (conv && conv.id) {
          await supabase
            .from("conversation_members")
            .upsert(
              [{ conversation_id: conv.id, username: request.username }],
              { onConflict: "conversation_id,username" }
            );
          console.log(`Auto-added ${request.username} to community ${communityId} chat (via join request approval)`);
        }
      } catch (chatErr) {
        console.error("Error adding member to community chat:", chatErr);
        // Don't fail the approval if chat addition fails
      }
    }

    res.json({ message: `Request ${newStatus}.` });
  } catch (err) {
    console.error("review join request error:", err);
    res.status(500).json({ message: "Server error while reviewing join request." });
  }
});

/* ------------------------- Community Chat ---------------------------------- */

/**
 * Get community chat messages
 * GET /communities/:id/chat/messages?viewer=<username>&limit=50
 */
router.get("/:id/chat/messages", async (req, res) => {
  const communityId = Number(req.params.id);
  const viewer = (req.query.viewer || "").trim();
  const limit = Math.min(Number(req.query.limit || 50), 100);

  if (!viewer) return res.status(400).json({ message: "Missing viewer." });

  try {
    // Check if user is member
    if (!(await isCommunityMember(communityId, viewer))) {
      return res.status(403).json({ message: "Must be a member to view chat." });
    }

    // Get community conversation
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("id")
      .eq("community_id", communityId)
      .single();

    if (convErr || !conv) {
      return res.json([]); // No messages yet
    }

    // Get messages
    const { data: messages, error: msgErr } = await supabase
      .from("messages")
      .select(`
        id,
        conversation_id,
        sender_username,
        message_type,
        content,
        created_at,
        sender:users!messages_sender_username_fkey(id, username, name, avatar, email, country, city, status, bio, age, gender, interests, is_online)
      `)
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (msgErr) throw msgErr;

    res.json(messages || []);
  } catch (err) {
    console.error("get community chat messages error:", err);
    res.status(500).json({ message: "Server error while fetching messages." });
  }
});

module.exports = router;
