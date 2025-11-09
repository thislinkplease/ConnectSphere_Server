const express = require("express");
const multer = require("multer");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");
const upload = multer({ storage: multer.memoryStorage() });

/* --------------------------------- Helpers --------------------------------- */

async function getEventById(eventId) {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .single();
  if (error) throw error;
  return data || null;
}

async function getEventParticipants(eventId) {
  const { data, error } = await supabase
    .from("event_participants")
    .select("username, status, joined_at")
    .eq("event_id", eventId)
    .in("status", ["interested", "going"]);
  if (error) throw error;
  return data || [];
}

async function calculateDistance(lat1, lon1, lat2, lon2) {
  // Haversine formula to calculate distance in km
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ------------------------------- Event CRUD -------------------------------- */

/**
 * Create a new event
 * POST /events
 * Body: { hosted_by, name, description, details, address, date_start, date_end, 
 *         latitude?, longitude?, entrance_fee?, schedule?, is_recurring?, 
 *         recurrence_pattern?, has_pricing_menu?, max_participants?, image_url? }
 */
router.post("/", async (req, res) => {
  const {
    hosted_by,
    name,
    description,
    details,
    address,
    date_start,
    date_end,
    latitude,
    longitude,
    entrance_fee = "Free",
    schedule,
    is_recurring = false,
    recurrence_pattern,
    has_pricing_menu = false,
    max_participants,
    image_url,
  } = req.body;

  if (!hosted_by || !name || !address || !date_start || !date_end) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  try {
    const { data, error } = await supabase
      .from("events")
      .insert([
        {
          hosted_by,
          name,
          description,
          details,
          address,
          date_start,
          date_end,
          latitude,
          longitude,
          entrance_fee,
          schedule,
          is_recurring,
          recurrence_pattern,
          has_pricing_menu,
          max_participants,
          image_url,
        },
      ])
      .select("*")
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error("create event error:", err);
    res.status(500).json({ message: "Server error while creating event." });
  }
});

/**
 * Get all events (with optional filters)
 * GET /events?limit=20&before=<ISO>&status=upcoming&distance_km=10&user_lat=<>&user_lng=<>
 */
router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const before = req.query.before ? new Date(req.query.before).toISOString() : null;
  const status = req.query.status || "upcoming";
  const distanceKm = Number(req.query.distance_km || 0);
  const userLat = req.query.user_lat ? Number(req.query.user_lat) : null;
  const userLng = req.query.user_lng ? Number(req.query.user_lng) : null;

  try {
    let query = supabase
      .from("events")
      .select("*")
      .eq("status", status)
      .order("date_start", { ascending: true })
      .limit(limit);

    if (before) {
      query = query.lt("created_at", before);
    }

    const { data, error } = await query;
    if (error) throw error;

    let events = data || [];

    // Calculate distance for each event if user location is provided
    if (userLat && userLng) {
      events = events.map((event) => {
        let distance = null;
        if (event.latitude && event.longitude) {
          distance = calculateDistance(userLat, userLng, event.latitude, event.longitude);
        }
        return { ...event, distance };
      });

      // Filter by distance if specified
      if (distanceKm > 0) {
        events = events.filter((e) => e.distance !== null && e.distance <= distanceKm);
      }

      // Sort by distance
      events.sort((a, b) => {
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });
    }

    res.json(events);
  } catch (err) {
    console.error("list events error:", err);
    res.status(500).json({ message: "Server error while fetching events." });
  }
});

/**
 * Get a single event by ID with participants
 * GET /events/:id?viewer=<username>
 */
router.get("/:id", async (req, res) => {
  const eventId = Number(req.params.id);
  const viewer = (req.query.viewer || "").trim();

  try {
    const event = await getEventById(eventId);
    if (!event) return res.status(404).json({ message: "Event not found." });

    // Get participants
    const participants = await getEventParticipants(eventId);

    // Get comments count
    const { count: commentCount, error: ccErr } = await supabase
      .from("event_comments")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId);
    if (ccErr) throw ccErr;

    // Check if viewer is participating
    let viewerStatus = null;
    if (viewer) {
      const { data: vpData, error: vpErr } = await supabase
        .from("event_participants")
        .select("status")
        .eq("event_id", eventId)
        .eq("username", viewer)
        .limit(1);
      if (vpErr) throw vpErr;
      viewerStatus = vpData && vpData.length > 0 ? vpData[0].status : null;
    }

    res.json({
      ...event,
      participants,
      participant_count: participants.length,
      comment_count: commentCount || 0,
      viewer_status: viewerStatus,
    });
  } catch (err) {
    console.error("get event error:", err);
    res.status(500).json({ message: "Server error while fetching event." });
  }
});

/**
 * Update an event (host only)
 * PUT /events/:id
 * Body: { actor, ...updatable fields }
 */
router.put("/:id", async (req, res) => {
  const eventId = Number(req.params.id);
  const { actor, name, description, details, address, date_start, date_end, 
          latitude, longitude, entrance_fee, schedule, is_recurring, 
          recurrence_pattern, has_pricing_menu, max_participants, image_url, status } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    const event = await getEventById(eventId);
    if (!event) return res.status(404).json({ message: "Event not found." });
    if (event.hosted_by !== actor) 
      return res.status(403).json({ message: "Only host can update this event." });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (details !== undefined) updates.details = details;
    if (address !== undefined) updates.address = address;
    if (date_start !== undefined) updates.date_start = date_start;
    if (date_end !== undefined) updates.date_end = date_end;
    if (latitude !== undefined) updates.latitude = latitude;
    if (longitude !== undefined) updates.longitude = longitude;
    if (entrance_fee !== undefined) updates.entrance_fee = entrance_fee;
    if (schedule !== undefined) updates.schedule = schedule;
    if (is_recurring !== undefined) updates.is_recurring = is_recurring;
    if (recurrence_pattern !== undefined) updates.recurrence_pattern = recurrence_pattern;
    if (has_pricing_menu !== undefined) updates.has_pricing_menu = has_pricing_menu;
    if (max_participants !== undefined) updates.max_participants = max_participants;
    if (image_url !== undefined) updates.image_url = image_url;
    if (status !== undefined) updates.status = status;

    const { data, error } = await supabase
      .from("events")
      .update(updates)
      .eq("id", eventId)
      .select("*")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("update event error:", err);
    res.status(500).json({ message: "Server error while updating event." });
  }
});

/**
 * Delete an event (host only)
 * DELETE /events/:id
 * Body: { actor }
 */
router.delete("/:id", async (req, res) => {
  const eventId = Number(req.params.id);
  const { actor } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    const event = await getEventById(eventId);
    if (!event) return res.status(404).json({ message: "Event not found." });
    if (event.hosted_by !== actor)
      return res.status(403).json({ message: "Only host can delete this event." });

    const { error } = await supabase.from("events").delete().eq("id", eventId);
    if (error) throw error;

    res.json({ message: "Event deleted." });
  } catch (err) {
    console.error("delete event error:", err);
    res.status(500).json({ message: "Server error while deleting event." });
  }
});

/* ----------------------------- Event Participants -------------------------- */

/**
 * Join/Update participation in an event
 * POST /events/:id/participate
 * Body: { username, status: 'interested'|'going'|'not_going'|'maybe' }
 */
router.post("/:id/participate", async (req, res) => {
  const eventId = Number(req.params.id);
  const { username, status = "interested" } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const event = await getEventById(eventId);
    if (!event) return res.status(404).json({ message: "Event not found." });

    const { data, error } = await supabase
      .from("event_participants")
      .upsert([{ event_id: eventId, username, status }])
      .select("*")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("participate event error:", err);
    res.status(500).json({ message: "Server error while joining event." });
  }
});

/**
 * Leave an event (alias for DELETE /events/:id/participate)
 * DELETE /events/:id/leave
 * Body: { username }
 */
router.delete("/:id/leave", async (req, res) => {
  const eventId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { error } = await supabase
      .from("event_participants")
      .delete()
      .eq("event_id", eventId)
      .eq("username", username);

    if (error) throw error;
    res.json({ message: "Left event." });
  } catch (err) {
    console.error("leave event error:", err);
    res.status(500).json({ message: "Server error while leaving event." });
  }
});

/**
 * Leave an event
 * DELETE /events/:id/participate
 * Body: { username }
 */
router.delete("/:id/participate", async (req, res) => {
  const eventId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { error } = await supabase
      .from("event_participants")
      .delete()
      .eq("event_id", eventId)
      .eq("username", username);

    if (error) throw error;
    res.json({ message: "Left event." });
  } catch (err) {
    console.error("leave event error:", err);
    res.status(500).json({ message: "Server error while leaving event." });
  }
});

/**
 * Get event participants with profiles
 * GET /events/:id/participants
 */
router.get("/:id/participants", async (req, res) => {
  const eventId = Number(req.params.id);

  try {
    const { data: participants, error } = await supabase
      .from("event_participants")
      .select("username, status, joined_at")
      .eq("event_id", eventId)
      .in("status", ["interested", "going"]);

    if (error) throw error;

    if (!participants || participants.length === 0) return res.json([]);

    const usernames = participants.map((p) => p.username);
    const { data: users, error: uErr } = await supabase
      .from("users")
      .select("id, username, name, avatar, bio")
      .in("username", usernames);

    if (uErr) throw uErr;

    const userMap = new Map(users.map((u) => [u.username, u]));
    const enriched = participants.map((p) => ({
      ...p,
      user: userMap.get(p.username) || null,
    }));

    res.json(enriched);
  } catch (err) {
    console.error("get participants error:", err);
    res.status(500).json({ message: "Server error while fetching participants." });
  }
});

/* ----------------------------- Event Invitations --------------------------- */

/**
 * Invite users to an event
 * POST /events/:id/invite
 * Body: { inviter_username, invitee_usernames: string[] }
 */
router.post("/:id/invite", async (req, res) => {
  const eventId = Number(req.params.id);
  const { inviter_username, invitee_usernames = [] } = req.body;

  if (!inviter_username || !invitee_usernames.length) {
    return res.status(400).json({ message: "Missing inviter or invitees." });
  }

  try {
    const event = await getEventById(eventId);
    if (!event) return res.status(404).json({ message: "Event not found." });

    const invitations = invitee_usernames.map((invitee) => ({
      event_id: eventId,
      inviter_username,
      invitee_username: invitee,
    }));

    const { data, error } = await supabase
      .from("event_invitations")
      .upsert(invitations)
      .select("*");

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error("invite to event error:", err);
    res.status(500).json({ message: "Server error while inviting to event." });
  }
});

/**
 * Respond to event invitation
 * PUT /events/:id/invite/:invitationId
 * Body: { username, status: 'accepted'|'declined' }
 */
router.put("/:id/invite/:invitationId", async (req, res) => {
  const eventId = Number(req.params.id);
  const invitationId = Number(req.params.invitationId);
  const { username, status } = req.body;

  if (!username || !status) {
    return res.status(400).json({ message: "Missing username or status." });
  }

  try {
    const { data: invitation, error: invErr } = await supabase
      .from("event_invitations")
      .select("*")
      .eq("id", invitationId)
      .eq("event_id", eventId)
      .eq("invitee_username", username)
      .single();

    if (invErr || !invitation) {
      return res.status(404).json({ message: "Invitation not found." });
    }

    const { data, error } = await supabase
      .from("event_invitations")
      .update({ status, responded_at: new Date().toISOString() })
      .eq("id", invitationId)
      .select("*")
      .single();

    if (error) throw error;

    // If accepted, automatically add to participants
    if (status === "accepted") {
      await supabase
        .from("event_participants")
        .upsert([{ event_id: eventId, username, status: "going" }]);
    }

    res.json(data);
  } catch (err) {
    console.error("respond to invitation error:", err);
    res.status(500).json({ message: "Server error while responding to invitation." });
  }
});

/* ------------------------------ Event Comments ----------------------------- */

/**
 * Add a comment to an event
 * POST /events/:id/comments
 * Body: { author_username, content, image_url?, parent_id? }
 */
router.post("/:id/comments", upload.single("image"), async (req, res) => {
  const eventId = Number(req.params.id);
  const { author_username, content, parent_id = null } = req.body;
  const file = req.file;

  if (!author_username || !content) {
    return res.status(400).json({ message: "Missing author or content." });
  }

  try {
    let imageUrl = null;

    // Upload image if provided
    if (file) {
      const fileName = `event_comments/${eventId}/${Date.now()}_${file.originalname}`;
      const { error: uploadErr } = await supabase.storage
        .from("posts")
        .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: true });

      if (uploadErr) throw uploadErr;

      const { data: publicUrl } = supabase.storage.from("posts").getPublicUrl(fileName);
      imageUrl = publicUrl.publicUrl;
    }

    const { data, error } = await supabase
      .from("event_comments")
      .insert([
        {
          event_id: eventId,
          author_username,
          content,
          image_url: imageUrl,
          parent_id,
        },
      ])
      .select("*")
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error("add event comment error:", err);
    res.status(500).json({ message: "Server error while adding comment." });
  }
});

/**
 * Get event comments
 * GET /events/:id/comments?parent_id=<id|null>
 */
router.get("/:id/comments", async (req, res) => {
  const eventId = Number(req.params.id);
  const hasParent = typeof req.query.parent_id !== "undefined";
  const parentId = req.query.parent_id === "null" ? null : Number(req.query.parent_id);

  try {
    let query = supabase
      .from("event_comments")
      .select("*")
      .eq("event_id", eventId)
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
    console.error("get event comments error:", err);
    res.status(500).json({ message: "Server error while fetching comments." });
  }
});

/**
 * Delete an event comment (author only)
 * DELETE /events/:id/comments/:commentId
 * Body: { author_username }
 */
router.delete("/:id/comments/:commentId", async (req, res) => {
  const eventId = Number(req.params.id);
  const commentId = Number(req.params.commentId);
  const { author_username } = req.body;

  if (!author_username) return res.status(400).json({ message: "Missing author_username." });

  try {
    const { data: comment, error: cErr } = await supabase
      .from("event_comments")
      .select("*")
      .eq("id", commentId)
      .eq("event_id", eventId)
      .single();

    if (cErr || !comment) return res.status(404).json({ message: "Comment not found." });
    if (comment.author_username !== author_username)
      return res.status(403).json({ message: "Not allowed to delete this comment." });

    const { error } = await supabase.from("event_comments").delete().eq("id", commentId);
    if (error) throw error;

    res.json({ message: "Comment deleted." });
  } catch (err) {
    console.error("delete event comment error:", err);
    res.status(500).json({ message: "Server error while deleting comment." });
  }
});

/* ------------------------------- User Events ------------------------------- */

/**
 * Get events created by a user
 * GET /events/user/:username/created
 */
router.get("/user/:username/created", async (req, res) => {
  const { username } = req.params;
  const limit = Math.min(Number(req.query.limit || 20), 100);

  try {
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .eq("hosted_by", username)
      .order("date_start", { ascending: true })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("get user created events error:", err);
    res.status(500).json({ message: "Server error while fetching created events." });
  }
});

/**
 * Get events a user is participating in
 * GET /events/user/:username/participating
 */
router.get("/user/:username/participating", async (req, res) => {
  const { username } = req.params;
  const limit = Math.min(Number(req.query.limit || 20), 100);

  try {
    const { data: participations, error: pErr } = await supabase
      .from("event_participants")
      .select("event_id, status")
      .eq("username", username)
      .in("status", ["interested", "going"]);

    if (pErr) throw pErr;

    if (!participations || participations.length === 0) return res.json([]);

    const eventIds = participations.map((p) => p.event_id);
    const { data: events, error: eErr } = await supabase
      .from("events")
      .select("*")
      .in("id", eventIds)
      .order("date_start", { ascending: true })
      .limit(limit);

    if (eErr) throw eErr;
    res.json(events || []);
  } catch (err) {
    console.error("get user participating events error:", err);
    res.status(500).json({ message: "Server error while fetching participating events." });
  }
});

/**
 * Search events by name
 * GET /events/search?q=keyword
 */
router.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);

  const limit = Math.min(Number(req.query.limit || 20), 100);

  try {
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .or(`name.ilike.%${q}%,description.ilike.%${q}%`)
      .eq("status", "upcoming")
      .order("date_start", { ascending: true })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("search events error:", err);
    res.status(500).json({ message: "Server error while searching events." });
  }
});

module.exports = router;
