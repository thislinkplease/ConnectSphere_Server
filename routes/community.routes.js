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
  return data && data.length > 0;
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

/* ---------------------------- Community CRUD ------------------------------- */

/**
 * Create a community
 * POST /communities
 * Body: { created_by, name, description?, image_url?, is_private? }
 */
router.post("/", async (req, res) => {
  const { created_by, name, description, image_url, is_private = false } = req.body;

  if (!created_by || !name) {
    return res.status(400).json({ message: "Missing created_by or name." });
  }

  try {
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
      .eq("is_private", false)
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
      .eq("is_private", false)
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
 * Join a community
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
      return res.status(403).json({ message: "Cannot join private community." });
    }

    const { data, error } = await supabase
      .from("community_members")
      .upsert([{ community_id: communityId, username, role: "member" }])
      .select("*")
      .single();

    if (error) throw error;

    // Update member count
    await supabase.rpc("increment_community_members", { community_id: communityId });

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

    // Update member count
    await supabase.rpc("decrement_community_members", { community_id: communityId });

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
 * FormData: { author_username, content, image (optional file) }
 */
router.post("/:id/posts", upload.single("image"), async (req, res) => {
  const communityId = Number(req.params.id);
  const { author_username, content } = req.body;
  const file = req.file;

  if (!author_username || !content) {
    return res.status(400).json({ message: "Missing author or content." });
  }

  try {
    if (!(await isCommunityMember(communityId, author_username))) {
      return res.status(403).json({ message: "Must be a member to post." });
    }

    let imageUrl = null;

    // Upload image if provided
    if (file) {
      const fileName = `community_posts/${communityId}/${Date.now()}_${file.originalname}`;
      const { error: uploadErr } = await supabase.storage
        .from("posts")
        .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: true });

      if (uploadErr) throw uploadErr;

      const { data: publicUrl } = supabase.storage.from("posts").getPublicUrl(fileName);
      imageUrl = publicUrl.publicUrl;
    }

    const { data, error } = await supabase
      .from("community_posts")
      .insert([{ community_id: communityId, author_username, content, image_url: imageUrl }])
      .select("*")
      .single();

    if (error) throw error;

    // Update post count
    await supabase.rpc("increment_community_posts", { community_id: communityId });

    res.status(201).json(data);
  } catch (err) {
    console.error("create community post error:", err);
    res.status(500).json({ message: "Server error while creating post." });
  }
});

/**
 * Get community posts
 * GET /communities/:id/posts?limit=20&before=<ISO>
 */
router.get("/:id/posts", async (req, res) => {
  const communityId = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const before = req.query.before ? new Date(req.query.before).toISOString() : null;

  try {
    let query = supabase
      .from("community_posts")
      .select("*")
      .eq("community_id", communityId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (before) {
      query = query.lt("created_at", before);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
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
      .from("community_posts")
      .select("*")
      .eq("id", postId)
      .eq("community_id", communityId)
      .single();

    if (pErr || !post) return res.status(404).json({ message: "Post not found." });

    const isAdmin = await isCommunityAdmin(communityId, actor);
    if (post.author_username !== actor && !isAdmin) {
      return res.status(403).json({ message: "Not allowed to delete this post." });
    }

    const { error } = await supabase.from("community_posts").delete().eq("id", postId);
    if (error) throw error;

    // Update post count
    await supabase.rpc("decrement_community_posts", { community_id: communityId });

    res.json({ message: "Post deleted." });
  } catch (err) {
    console.error("delete community post error:", err);
    res.status(500).json({ message: "Server error while deleting post." });
  }
});

/* ------------------------- Community Post Likes ---------------------------- */

/**
 * Like a community post
 * POST /communities/:id/posts/:postId/like
 * Body: { username }
 */
router.post("/:id/posts/:postId/like", async (req, res) => {
  const communityId = Number(req.params.id);
  const postId = Number(req.params.postId);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { error: insertErr } = await supabase
      .from("community_post_likes")
      .insert([{ post_id: postId, username }]);

    if (insertErr && !String(insertErr.message).toLowerCase().includes("duplicate")) {
      throw insertErr;
    }

    // Update like count
    const { count, error: countErr } = await supabase
      .from("community_post_likes")
      .select("id", { count: "exact", head: true })
      .eq("post_id", postId);

    if (countErr) throw countErr;

    await supabase
      .from("community_posts")
      .update({ like_count: count || 0 })
      .eq("id", postId);

    res.json({ post_id: postId, like_count: count || 0 });
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
    const { error: delErr } = await supabase
      .from("community_post_likes")
      .delete()
      .eq("post_id", postId)
      .eq("username", username);

    if (delErr) throw delErr;

    // Update like count
    const { count, error: countErr } = await supabase
      .from("community_post_likes")
      .select("id", { count: "exact", head: true })
      .eq("post_id", postId);

    if (countErr) throw countErr;

    await supabase
      .from("community_posts")
      .update({ like_count: count || 0 })
      .eq("id", postId);

    res.json({ post_id: postId, like_count: count || 0 });
  } catch (err) {
    console.error("unlike community post error:", err);
    res.status(500).json({ message: "Server error while unliking post." });
  }
});

/* ----------------------- Community Post Comments --------------------------- */

/**
 * Add a comment to a community post
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
    const { data, error } = await supabase
      .from("community_post_comments")
      .insert([{ post_id: postId, author_username, content, parent_id }])
      .select("*")
      .single();

    if (error) throw error;

    // Update comment count
    const { count, error: countErr } = await supabase
      .from("community_post_comments")
      .select("id", { count: "exact", head: true })
      .eq("post_id", postId);

    if (countErr) throw countErr;

    await supabase
      .from("community_posts")
      .update({ comment_count: count || 0 })
      .eq("id", postId);

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
    let query = supabase
      .from("community_post_comments")
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
    const { data: comment, error: cErr } = await supabase
      .from("community_post_comments")
      .select("*")
      .eq("id", commentId)
      .eq("post_id", postId)
      .single();

    if (cErr || !comment) return res.status(404).json({ message: "Comment not found." });

    const isAdmin = await isCommunityAdmin(communityId, actor);
    if (comment.author_username !== actor && !isAdmin) {
      return res.status(403).json({ message: "Not allowed to delete this comment." });
    }

    const { error } = await supabase.from("community_post_comments").delete().eq("id", commentId);
    if (error) throw error;

    // Update comment count
    const { count, error: countErr } = await supabase
      .from("community_post_comments")
      .select("id", { count: "exact", head: true })
      .eq("post_id", postId);

    if (countErr) throw countErr;

    await supabase
      .from("community_posts")
      .update({ comment_count: count || 0 })
      .eq("id", postId);

    res.json({ message: "Comment deleted." });
  } catch (err) {
    console.error("delete comment error:", err);
    res.status(500).json({ message: "Server error while deleting comment." });
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

module.exports = router;
