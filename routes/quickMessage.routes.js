const express = require("express");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");

/* --------------------------- Quick Messages CRUD --------------------------- */

/**
 * Get quick messages for a user
 * GET /quick-messages?username=<username>
 */
router.get("/", async (req, res) => {
  const username = (req.query.username || "").trim();

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { data, error } = await supabase
      .from("quick_messages")
      .select("*")
      .eq("username", username)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("get quick messages error:", err);
    res.status(500).json({ message: "Server error while fetching quick messages." });
  }
});

/**
 * Create a quick message
 * POST /quick-messages
 * Body: { username, shortcut, message }
 */
router.post("/", async (req, res) => {
  const { username, shortcut, message } = req.body;

  if (!username || !shortcut || !message) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  try {
    const { data, error } = await supabase
      .from("quick_messages")
      .insert([{ username, shortcut, message }])
      .select("*")
      .single();

    if (error) {
      if (String(error.message).toLowerCase().includes("duplicate")) {
        return res.status(409).json({ message: "Shortcut already exists." });
      }
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    console.error("create quick message error:", err);
    res.status(500).json({ message: "Server error while creating quick message." });
  }
});

/**
 * Update a quick message
 * PUT /quick-messages/:id
 * Body: { username, shortcut?, message? }
 */
router.put("/:id", async (req, res) => {
  const quickMessageId = Number(req.params.id);
  const { username, shortcut, message } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    // Verify ownership
    const { data: existing, error: existErr } = await supabase
      .from("quick_messages")
      .select("*")
      .eq("id", quickMessageId)
      .eq("username", username)
      .single();

    if (existErr || !existing) {
      return res.status(404).json({ message: "Quick message not found." });
    }

    const updates = {};
    if (shortcut !== undefined) updates.shortcut = shortcut;
    if (message !== undefined) updates.message = message;

    const { data, error } = await supabase
      .from("quick_messages")
      .update(updates)
      .eq("id", quickMessageId)
      .select("*")
      .single();

    if (error) {
      if (String(error.message).toLowerCase().includes("duplicate")) {
        return res.status(409).json({ message: "Shortcut already exists." });
      }
      throw error;
    }

    res.json(data);
  } catch (err) {
    console.error("update quick message error:", err);
    res.status(500).json({ message: "Server error while updating quick message." });
  }
});

/**
 * Delete a quick message
 * DELETE /quick-messages/:id
 * Body: { username }
 */
router.delete("/:id", async (req, res) => {
  const quickMessageId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { error } = await supabase
      .from("quick_messages")
      .delete()
      .eq("id", quickMessageId)
      .eq("username", username);

    if (error) throw error;
    res.json({ message: "Quick message deleted." });
  } catch (err) {
    console.error("delete quick message error:", err);
    res.status(500).json({ message: "Server error while deleting quick message." });
  }
});

/**
 * Get message by shortcut (for quick expansion)
 * GET /quick-messages/expand?username=<username>&shortcut=<shortcut>
 */
router.get("/expand", async (req, res) => {
  const username = (req.query.username || "").trim();
  const shortcut = (req.query.shortcut || "").trim();

  if (!username || !shortcut) {
    return res.status(400).json({ message: "Missing username or shortcut." });
  }

  try {
    const { data, error } = await supabase
      .from("quick_messages")
      .select("*")
      .eq("username", username)
      .eq("shortcut", shortcut)
      .single();

    if (error) {
      if (String(error.message).includes("0 rows")) {
        return res.status(404).json({ message: "Shortcut not found." });
      }
      throw error;
    }

    res.json(data);
  } catch (err) {
    console.error("expand quick message error:", err);
    res.status(500).json({ message: "Server error while expanding quick message." });
  }
});

module.exports = router;
