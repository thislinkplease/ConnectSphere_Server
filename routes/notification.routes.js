const express = require("express");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");

/* --------------------------------- Helpers --------------------------------- */

async function createNotification(recipientUsername, type, content, data = {}, senderUsername = null, title = null) {
  try {
    const { data: notification, error } = await supabase
      .from("notifications")
      .insert([
        {
          recipient_username: recipientUsername,
          sender_username: senderUsername,
          type,
          title,
          content,
          data,
        },
      ])
      .select("*")
      .single();

    if (error) throw error;
    return notification;
  } catch (err) {
    console.error("create notification error:", err);
    return null;
  }
}

/* ---------------------------- Get Notifications ---------------------------- */

/**
 * Get notifications for a user
 * GET /notifications?username=<username>&limit=50&unread_only=false
 */
router.get("/", async (req, res) => {
  const username = (req.query.username || "").trim();
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const unreadOnly = String(req.query.unread_only || "false") === "true";

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    let query = supabase
      .from("notifications")
      .select("*")
      .eq("recipient_username", username)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (unreadOnly) {
      query = query.eq("is_read", false);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error("get notifications error:", err);
    res.status(500).json({ message: "Server error while fetching notifications." });
  }
});

/**
 * Get unread notification count
 * GET /notifications/unread-count?username=<username>
 */
router.get("/unread-count", async (req, res) => {
  const username = (req.query.username || "").trim();

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { count, error } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("recipient_username", username)
      .eq("is_read", false);

    if (error) throw error;
    res.json({ username, unread_count: count || 0 });
  } catch (err) {
    console.error("get unread count error:", err);
    res.status(500).json({ message: "Server error while fetching unread count." });
  }
});

/**
 * Mark notification(s) as read
 * PUT /notifications/mark-read
 * Body: { username, notification_ids?: number[], all?: boolean }
 */
router.put("/mark-read", async (req, res) => {
  const { username, notification_ids = [], all = false } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    if (all) {
      // Mark all notifications as read for the user
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("recipient_username", username)
        .eq("is_read", false);

      if (error) throw error;
      res.json({ message: "All notifications marked as read." });
    } else if (notification_ids.length > 0) {
      // Mark specific notifications as read
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .in("id", notification_ids)
        .eq("recipient_username", username);

      if (error) throw error;
      res.json({ message: "Notifications marked as read." });
    } else {
      return res.status(400).json({ message: "No notifications specified." });
    }
  } catch (err) {
    console.error("mark read error:", err);
    res.status(500).json({ message: "Server error while marking notifications as read." });
  }
});

/**
 * Delete a notification
 * DELETE /notifications/:id
 * Body: { username }
 */
router.delete("/:id", async (req, res) => {
  const notificationId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("id", notificationId)
      .eq("recipient_username", username);

    if (error) throw error;
    res.json({ message: "Notification deleted." });
  } catch (err) {
    console.error("delete notification error:", err);
    res.status(500).json({ message: "Server error while deleting notification." });
  }
});

/**
 * Create a notification (for testing or internal use)
 * POST /notifications
 * Body: { recipient_username, sender_username?, type, title?, content, data? }
 */
router.post("/", async (req, res) => {
  const { recipient_username, sender_username, type, title, content, data = {} } = req.body;

  if (!recipient_username || !type || !content) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  try {
    const notification = await createNotification(
      recipient_username,
      type,
      content,
      data,
      sender_username,
      title
    );

    if (!notification) {
      return res.status(500).json({ message: "Failed to create notification." });
    }

    res.status(201).json(notification);
  } catch (err) {
    console.error("create notification error:", err);
    res.status(500).json({ message: "Server error while creating notification." });
  }
});

module.exports = router;
module.exports.createNotification = createNotification;
