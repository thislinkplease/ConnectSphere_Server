const express = require("express");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");

async function updateCommentCount(postId) {
  const { count, error } = await supabase
    .from("comments")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId);
  if (error) throw error;

  const upd = await supabase.from("posts").update({ comment_count: count || 0 }).eq("id", postId);
  if (upd.error) throw upd.error;
  return count || 0;
}

// ------------------------------- Add a comment --------------------------------

/**
 * Add a comment
 * POST /posts/:id/comments
 */
router.post("/:id/comments", async (req, res) => {
  const postId = Number(req.params.id);
  const { author_username, content, parent_id = null } = req.body;

  if (!author_username || !content) {
    return res.status(400).json({ message: "Missing author_username or content." });
  }

  try {
    const { data, error } = await supabase
      .from("comments")
      .insert([{ post_id: postId, author_username, content, parent_id }])
      .select("*")
      .single();
    if (error) throw error;

    await updateCommentCount(postId);
    res.status(201).json(data);
  } catch (err) {
    console.error("add comment error:", err);
    res.status(500).json({ message: "Server error while adding comment." });
  }
});

// ------------------------------- Get comments --------------------------------

/**
 * Get comments for a post
 * GET /posts/:id/comments
 */
router.get("/:id/comments", async (req, res) => {
  const postId = Number(req.params.id);
  const parentId = req.query.parent_id === "null" ? null : Number(req.query.parent_id);

  try {
    let query = supabase
      .from("comments")
      .select("id, post_id, author_username, content, parent_id, created_at, updated_at")
      .eq("post_id", postId)
      .order("created_at", { ascending: true });

    if (parentId !== null) {
      query = query.eq("parent_id", parentId);
    } else {
      query = query.is("parent_id", null);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error("list comments error:", err);
    res.status(500).json({ message: "Server error while fetching comments." });
  }
});

// ------------------------------- Delete a comment -----------------------------

/**
 * Delete a comment (author only – basic check)
 * DELETE /posts/:id/comments/:commentId
 */
router.delete("/:id/comments/:commentId", async (req, res) => {
  const postId = Number(req.params.id);
  const commentId = Number(req.params.commentId);
  const { author_username } = req.body;

  if (!author_username) return res.status(400).json({ message: "Missing author_username." });

  try {
    const { data: cmt, error: cErr } = await supabase
      .from("comments")
      .select("id, author_username")
      .eq("id", commentId)
      .single();
    if (cErr) throw cErr;
    if (!cmt) return res.status(404).json({ message: "Comment not found." });
    if (cmt.author_username !== author_username)
      return res.status(403).json({ message: "Not allowed to delete this comment." });

    const del = await supabase.from("comments").delete().eq("id", commentId);
    if (del.error) throw del.error;

    await updateCommentCount(postId);
    res.json({ message: "Comment deleted." });
  } catch (err) {
    console.error("delete comment error:", err);
    res.status(500).json({ message: "Server error while deleting comment." });
  }
});

module.exports = router;
