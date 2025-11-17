const express = require("express");
const multer = require("multer");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");
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

async function updateLikeCount(postId) {
  const { count, error } = await supabase
    .from("post_likes")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId);
  if (error) throw error;

  const upd = await supabase.from("posts").update({ like_count: count || 0 }).eq("id", postId);
  if (upd.error) throw upd.error;
  return count || 0;
}

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

    const { data: post, error: postErr } = await supabase
      .from("posts")
      .insert([{
        author_username,
        content,
        status,
        audience,
        disable_comments: String(disable_comments) === "true",
        hide_like_count: String(hide_like_count) === "true",
        community_id
      }])
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
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });

      if (uploadRes.error) throw uploadRes.error;

      const { data: pub } = supabase.storage.from("posts").getPublicUrl(storagePath);
      const media_url = pub.publicUrl;

      const { data: pm, error: pmErr } = await supabase
        .from("post_media")
        .insert([{
          post_id: post.id,
          media_url,
          media_type: file.mimetype.startsWith("video") ? "video" : "image",
          position: i,
        }])
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

// ------------------------------- Like a post --------------------------------

/**
 * Like a post
 * POST /posts/:id/like
 * Body: { username }
 */
router.post("/:id/like", async (req, res) => {
  const postId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const ins = await supabase
      .from("post_likes")
      .insert([{ post_id: postId, username }])
      .select("*")
      .single();

    if (ins.error && !isDuplicateKeyError(ins.error)) throw ins.error;

    const newCount = await updateLikeCount(postId);
    res.json({ post_id: postId, liked_by: username, like_count: newCount, duplicated: !!ins.error });
  } catch (err) {
    console.error("like post error:", err);
    res.status(500).json({ message: "Server error while liking post." });
  }
});

// ------------------------------- Unlike a post --------------------------------

/**
 * Unlike a post
 * DELETE /posts/:id/like
 * Body: { username }
 */
router.delete("/:id/like", async (req, res) => {
  const postId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const del = await supabase.from("post_likes").delete().eq("post_id", postId).eq("username", username);
    if (del.error) throw del.error;

    const newCount = await updateLikeCount(postId);
    res.json({ post_id: postId, unliked_by: username, like_count: newCount });
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
