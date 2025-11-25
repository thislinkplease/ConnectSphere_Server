const express = require("express");
const multer = require("multer");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");
const { requireAuth } = require("../middleware/auth.middleware");
const upload = multer({ storage: multer.memoryStorage() });

// ----------------------------- Utilities & Helpers -----------------------------

async function getPostById(postId) {
  const { data, error } = await supabase
    .from("posts")
    .select(
      "id, author_username, content, status, audience, disable_comments, hide_like_count, like_count, comment_count, created_at, updated_at, post_media(id, media_url, media_type, position), community_id"
    )
    .eq("id", postId)
    .single();
  if (error) throw error;
  return data || null;
}

async function enrichPostWithAuthor(post) {
  const { data: authorData } = await supabase
    .from("users")
    .select("username, name, avatar")
    .eq("username", post.author_username)
    .single();

  return {
    ...post,
    authorAvatar: authorData?.avatar || null,
    authorDisplayName: authorData?.name || post.author_username,
  };
}

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

// ------------------------------- Get Posts Feed --------------------------------

/**
 * Get posts feed with author information
 * GET /posts?limit=20&before=<ISO>
 */
router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const before = req.query.before ? new Date(req.query.before).toISOString() : null;

  try {
    let query = supabase
      .from("posts")
      .select(
        "id, author_username, content, status, audience, disable_comments, hide_like_count, like_count, comment_count, community_id, created_at, updated_at"
      )
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

    // Fetch media
    const { data: media, error: mediaErr } = await supabase
      .from("post_media")
      .select("id, post_id, media_url, media_type, position")
      .in("post_id", postIds)
      .order("position", { ascending: true });

    if (mediaErr) throw mediaErr;

    // Fetch authors
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
        post_media: mediaMap.get(p.id) || [],
        authorAvatar: author ? author.avatar : null,
        authorDisplayName: author ? author.name || author.username : p.author_username,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error("get posts feed error:", err);
    res.status(500).json({ message: "Server error while fetching posts." });
  }
});

/**
 * Get post by ID with author information
 * GET /posts/:id?viewer=username
 */
router.get("/:id", async (req, res) => {
  const postId = Number(req.params.id);
  const viewer = req.query.viewer;

  try {
    const post = await getPostById(postId);
    if (!post) return res.status(404).json({ message: "Post not found." });

    const enrichedPost = await enrichPostWithAuthor(post);

    // Check if viewer has liked this post
    if (viewer) {
      const { data: like } = await supabase
        .from("post_likes")
        .select("id")
        .eq("post_id", postId)
        .eq("username", viewer)
        .limit(1);

      enrichedPost.isLikedByViewer = !!(like && like.length > 0);
    }

    res.json(enrichedPost);
  } catch (err) {
    console.error("get post by id error:", err);
    res.status(500).json({ message: "Server error while fetching post." });
  }
});

// ----------------------- Upload media for a post -----------------------

router.post("/:id/media", upload.array("media", 20), async (req, res) => {
  try {
    const postId = Number(req.params.id);
    const files = req.files || [];

    if (!files.length) {
      return res.status(400).json({ message: "No media uploaded." });
    }

    const uploadedMedia = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      const cleanName = file.originalname.replace(/[^\w.\-]+/g, "_");
      const storagePath = `posts/${postId}/${Date.now()}_${i}_${cleanName}`;

      // Upload vào supabase storage
      const uploadRes = await supabase.storage
        .from("posts")
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadRes.error) throw uploadRes.error;

      // Lấy public url
      const { data: publicUrl } = supabase.storage
        .from("posts")
        .getPublicUrl(storagePath);

      const media_url = publicUrl.publicUrl;

      // Insert DB
      const { data: mediaRow, error: mediaErr } = await supabase
        .from("post_media")
        .insert([
          {
            post_id: postId,
            media_url,
            media_type: file.mimetype.startsWith("video") ? "video" : "image",
            position: i,
          },
        ])
        .select("*")
        .single();

      if (mediaErr) throw mediaErr;

      uploadedMedia.push(mediaRow);
    }

    res.status(201).json(uploadedMedia);
  } catch (err) {
    console.error("upload media error:", err);
    res.status(500).json({ message: "Failed to upload media." });
  }
});

// ------------------------------- Delete single media from a post -------------------------------

router.delete("/:id/media/:mediaId", async (req, res) => {
  const postId = Number(req.params.id);
  const mediaId = Number(req.params.mediaId);
  const { author_username } = req.body;

  if (!author_username) {
    return res.status(400).json({ message: "Missing author_username." });
  }

  try {
    // Check owner
    const { data: post, error: postErr } = await supabase
      .from("posts")
      .select("author_username")
      .eq("id", postId)
      .single();

    if (postErr || !post) return res.status(404).json({ message: "Post not found." });

    if (post.author_username !== author_username) {
      return res.status(403).json({ message: "Not allowed to delete this media." });
    }

    // Delete media row
    const { error: delErr } = await supabase
      .from("post_media")
      .delete()
      .eq("id", mediaId)
      .eq("post_id", postId);

    if (delErr) throw delErr;

    res.json({ success: true });
  } catch (err) {
    console.error("delete media error:", err);
    res.status(500).json({ message: "Failed to delete media." });
  }
});

// ------------------------------- Create a post --------------------------------

/**
 * Create a post with optional media files
 * POST /posts
 */
router.post("/", upload.array("media", 10), async (req, res) => {
  try {
    const {
      author_username,
      content = null,
      status = null,
      audience = "followers",
      disable_comments = "false",
      hide_like_count = "false",
      community_id = null
    } = req.body;

    if (!author_username) {
      return res.status(400).json({ message: "Missing author_username." });
    }

    let finalStatus = status;

    if (community_id) {
      
      const { data: memberRow } = await supabase
        .from("community_members")
        .select("role")
        .eq("community_id", community_id)
        .eq("username", author_username)
        .single();

      const role = memberRow?.role;

      if (role === "admin" || role === "moderator") {
        finalStatus = "approved";
      } else {
        const { data: c } = await supabase
          .from("communities")
          .select("requires_post_approval")
          .eq("id", community_id)
          .single();

        finalStatus = c?.requires_post_approval ? "pending" : "approved";
      }
    }

    const { data: post, error: postErr } = await supabase
      .from("posts")
      .insert([
        {
          author_username,
          content,
          status: finalStatus,
          audience,
          disable_comments: String(disable_comments) === "true",
          hide_like_count: String(hide_like_count) === "true",
          community_id
        }
      ])
      .select("*")
      .single();

    if (postErr) throw postErr;

    const files = req.files || [];
    const mediaRows = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      const cleanName = file.originalname.replace(/[^\w.\-]+/g, "_");
      const storagePath = `posts/${post.id}/${Date.now()}_${i}_${cleanName}`;

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
            position: i,
          }
        ])
        .select("*")
        .single();

      if (pmErr) throw pmErr;

      mediaRows.push(pm);
    }

    const full = await getPostById(post.id);
    res.status(201).json(full);

  } catch (err) {
    console.error("create post error:", err);
    res.status(500).json({ message: "Server error while creating post." });
  }
});


// ------------------------------- Update a post --------------------------------

router.put("/:id", async (req, res) => {
  const postId = Number(req.params.id);
  const {
    author_username,
    content,
    audience,
    disable_comments,
    hide_like_count,
    community_id
  } = req.body;

  if (!author_username) {
    return res.status(400).json({ message: "Missing author_username." });
  }

  try {
    const { data: post, error } = await supabase
      .from("posts")
      .update({
        content,
        audience,
        disable_comments,
        hide_like_count,
        community_id
      })
      .eq("id", postId)
      .eq("author_username", author_username)
      .select("*")
      .single();

    if (error) throw error;

    res.json(post);
  } catch (err) {
    console.error("update post error:", err);
    res.status(500).json({ message: "Failed to update post." });
  }
});

// ------------------------------- Like/unlike a post --------------------------------

/**
 * Like a post
 * POST /posts/:id/like
 */
router.post("/:id/like", requireAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const username = req.user.username;

  try {
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id")
      .eq("id", postId)
      .single();

    if (pErr || !post) {
      return res.status(404).json({ message: "Post not found." });
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
    console.error("like post error:", err);
    res.status(500).json({ message: "Server error while liking post." });
  }
});

/**
 * Unlike a post
 * DELETE /posts/:id/like
 */
router.delete("/:id/like", requireAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const username = req.user.username;

  try {
    const { data: post, error: pErr } = await supabase
      .from("posts")
      .select("id")
      .eq("id", postId)
      .single();

    if (pErr || !post) {
      return res.status(404).json({ message: "Post not found." });
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
    console.error("unlike post error:", err);
    res.status(500).json({ message: "Server error while unliking post." });
  }
});

// ------------------------------- Get likes of a post -------------------------

/**
 * Get likes of a post
 * GET /posts/:id/likes
 */
router.get("/:id/likes", async (req, res) => {
  const postId = Number(req.params.id);

  try {
    const { data: likes, error } = await supabase
      .from("post_likes")
      .select("username, created_at")
      .eq("post_id", postId)
      .order("created_at", { ascending: false });
    if (error) throw error;

    res.json(likes || []);
  } catch (err) {
    console.error("list likes error:", err);
    res.status(500).json({ message: "Server error while fetching likes." });
  }
});

// ------------------------------- Delete a post --------------------------------

/**
 * Delete a post (author only – basic check)
 * DELETE /posts/:id
 * Body: { author_username }
 */
router.delete("/:id", async (req, res) => {
  const postId = Number(req.params.id);
  const { author_username } = req.body;

  if (!author_username) return res.status(400).json({ message: "Missing author_username." });

  try {
    const current = await getPostById(postId);
    if (!current) return res.status(404).json({ message: "Post not found." });
    if (current.author_username !== author_username)
      return res.status(403).json({ message: "Not allowed to delete this post." });

    const del = await supabase.from("posts").delete().eq("id", postId);
    if (del.error) throw del.error;

    res.json({ message: "Post deleted." });
  } catch (err) {
    console.error("delete post error:", err);
    res.status(500).json({ message: "Server error while deleting post." });
  }
});

module.exports = router;
