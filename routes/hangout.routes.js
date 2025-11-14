const express = require("express");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");

/*Helpers  */

function calculateDistance(lat1, lon1, lat2, lon2) {
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

async function getHangoutById(hangoutId) {
  const { data, error } = await supabase
    .from("hangouts")
    .select("*")
    .eq("id", hangoutId)
    .single();
  if (error) throw error;
  return data || null;
}

// ... các import và code khác phía trên

/**
 * Update user hangout status
 * PUT /hangouts/status
 * Body: { username, is_available, current_activity?, activities? }
 */
router.put("/status", async (req, res) => {
  const { username, is_available, current_activity, activities } = req.body;

  if (!username) {
    return res.status(400).json({ message: "Missing username." });
  }

  try {
    const updates = {
      username,
      is_available: !!is_available,
    };

    if (current_activity !== undefined) {
      updates.current_activity = current_activity;
    }
    if (activities !== undefined) {
      updates.activities = Array.isArray(activities) ? activities : [];
    }

    const { data, error } = await supabase
      .from("user_hangout_status")
      .upsert([updates])
      .select("*")
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("update hangout status error:", err);
    res.status(500).json({ message: "Server error while updating hangout status." });
  }
});

// GET /hangouts/status/:username
router.get("/status/:username", async (req, res) => {
  const { username } = req.params;

  try {
    const { data, error } = await supabase
      .from("user_hangout_status")
      .select("*")
      .eq("username", username)
      .maybeSingle();                

    if (error) {
      console.error("[DEBUG] hangout status supabase error:", error);
      throw error;
    }

    if (!data) {
      // Fallback khi chưa có status
      return res.json({
        username,
        is_available: false,
        current_activity: "",
        activities: [],
      });
    }

    res.json(data);
  } catch (err) {
    console.error("get hangout status error:", err);
    res.status(500).json({ message: "Server error while fetching hangout status." });
  }
});

/* ------------------------------- Hangout CRUD ------------------------------ */

/**
 * Create a new hangout
 * POST /hangouts
 * Body: { creator_username, title?, description?, activities?: string[], 
 *         languages?: string[], latitude?, longitude?, location_name?, max_distance_km? }
 */
router.post("/", async (req, res) => {
  const {
    creator_username,
    title,
    description,
    activities = [],
    languages = [],
    latitude,
    longitude,
    location_name,
    max_distance_km = 10,
  } = req.body;

  if (!creator_username) {
    return res.status(400).json({ message: "Missing creator_username." });
  }

  try {
    const { data, error } = await supabase
      .from("hangouts")
      .insert([
        {
          creator_username,
          title,
          description,
          activities,
          languages,
          latitude,
          longitude,
          location_name,
          max_distance_km,
        },
      ])
      .select("*")
      .single();

    if (error) throw error;

    // Automatically add creator as participant
    await supabase
      .from("hangout_participants")
      .insert([{ hangout_id: data.id, username: creator_username, status: "joined" }]);

    res.status(201).json(data);
  } catch (err) {
    console.error("create hangout error:", err);
    res.status(500).json({ message: "Server error while creating hangout." });
  }
});

/**
 * Get online users for hangout (Tinder-like feature)
 * GET /hangouts?languages=English,Vietnamese&distance_km=10&user_lat=<>&user_lng=<>&limit=50
 * Returns only online users with their background images
 */
router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const languagesParam = req.query.languages || "";
  const languages = languagesParam ? languagesParam.split(",").map((l) => l.trim()) : [];
  const distanceKm = Number(req.query.distance_km || 0);
  const userLat = req.query.user_lat ? Number(req.query.user_lat) : null;
  const userLng = req.query.user_lng ? Number(req.query.user_lng) : null;

  try {
    // Query for users who are online
    let query = supabase
      .from("users")
      .select(`
        id,
        username,
        name,
        email,
        avatar,
        background_image,
        country,
        city,
        age,
        bio,
        interests,
        is_online,
        latitude,
        longitude,
        status,
        current_activity
      `)
      .eq("is_online", true);

    if (limit) {
      query = query.limit(parseInt(limit));
    }

    const { data: users, error } = await query;

    if (error) {
      console.error("Error fetching users:", error);
      return res.status(500).json({ message: "Error fetching users." });
    }

    let hangoutUsers = users || [];

    // Filter by languages if specified
    // Note: This requires user_languages table join or languages stored in user profile
    // For now, we'll skip language filtering and let the client handle it
    // TODO: Implement language filtering if needed

    // Calculate distance and filter if user location is provided
    if (userLat && userLng) {
      hangoutUsers = hangoutUsers.map((user) => {
        let distance = null;
        if (user.latitude && user.longitude) {
          distance = calculateDistance(userLat, userLng, user.latitude, user.longitude);
        }
        return { ...user, distance };
      });

      // Filter by distance if specified
      if (distanceKm > 0) {
        hangoutUsers = hangoutUsers.filter((u) => u.distance !== null && u.distance <= distanceKm);
      }

      // Sort by distance
      hangoutUsers.sort((a, b) => {
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });
    }

    res.json(hangoutUsers);
  } catch (err) {
    console.error("list hangout users error:", err);
    res.status(500).json({ message: "Server error while fetching hangout users." });
  }
});

/**
 * Get a single hangout by ID
 * GET /hangouts/:id
 */
router.get("/:id", async (req, res) => {
  const hangoutId = Number(req.params.id);

  try {
    const hangout = await getHangoutById(hangoutId);
    if (!hangout) return res.status(404).json({ message: "Hangout not found." });

    // Get participants
    const { data: participants, error: pErr } = await supabase
      .from("hangout_participants")
      .select("username, status, joined_at")
      .eq("hangout_id", hangoutId);

    if (pErr) throw pErr;

    res.json({ ...hangout, participants: participants || [] });
  } catch (err) {
    console.error("get hangout error:", err);
    res.status(500).json({ message: "Server error while fetching hangout." });
  }
});

/**
 * Update a hangout (creator only)
 * PUT /hangouts/:id
 * Body: { actor, ...updatable fields }
 */
router.put("/:id", async (req, res) => {
  const hangoutId = Number(req.params.id);
  const {
    actor,
    title,
    description,
    activities,
    languages,
    latitude,
    longitude,
    location_name,
    max_distance_km,
    status,
  } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    const hangout = await getHangoutById(hangoutId);
    if (!hangout) return res.status(404).json({ message: "Hangout not found." });
    if (hangout.creator_username !== actor)
      return res.status(403).json({ message: "Only creator can update this hangout." });

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (activities !== undefined) updates.activities = activities;
    if (languages !== undefined) updates.languages = languages;
    if (latitude !== undefined) updates.latitude = latitude;
    if (longitude !== undefined) updates.longitude = longitude;
    if (location_name !== undefined) updates.location_name = location_name;
    if (max_distance_km !== undefined) updates.max_distance_km = max_distance_km;
    if (status !== undefined) updates.status = status;

    const { data, error } = await supabase
      .from("hangouts")
      .update(updates)
      .eq("id", hangoutId)
      .select("*")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("update hangout error:", err);
    res.status(500).json({ message: "Server error while updating hangout." });
  }
});

/**
 * Delete a hangout (creator only)
 * DELETE /hangouts/:id
 * Body: { actor }
 */
router.delete("/:id", async (req, res) => {
  const hangoutId = Number(req.params.id);
  const { actor } = req.body;

  if (!actor) return res.status(400).json({ message: "Missing actor." });

  try {
    const hangout = await getHangoutById(hangoutId);
    if (!hangout) return res.status(404).json({ message: "Hangout not found." });
    if (hangout.creator_username !== actor)
      return res.status(403).json({ message: "Only creator can delete this hangout." });

    const { error } = await supabase.from("hangouts").delete().eq("id", hangoutId);
    if (error) throw error;

    res.json({ message: "Hangout deleted." });
  } catch (err) {
    console.error("delete hangout error:", err);
    res.status(500).json({ message: "Server error while deleting hangout." });
  }
});

/* --------------------------- Hangout Participants -------------------------- */

/**
 * Join a hangout
 * POST /hangouts/:id/join
 * Body: { username }
 */
router.post("/:id/join", async (req, res) => {
  const hangoutId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const hangout = await getHangoutById(hangoutId);
    if (!hangout) return res.status(404).json({ message: "Hangout not found." });
    if (hangout.status !== "open")
      return res.status(400).json({ message: "Hangout is not open." });

    const { data, error } = await supabase
      .from("hangout_participants")
      .upsert([{ hangout_id: hangoutId, username, status: "joined" }])
      .select("*")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("join hangout error:", err);
    res.status(500).json({ message: "Server error while joining hangout." });
  }
});

/**
 * Leave a hangout
 * DELETE /hangouts/:id/join
 * Body: { username }
 */
router.delete("/:id/join", async (req, res) => {
  const hangoutId = Number(req.params.id);
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { error } = await supabase
      .from("hangout_participants")
      .update({ status: "left" })
      .eq("hangout_id", hangoutId)
      .eq("username", username);

    if (error) throw error;
    res.json({ message: "Left hangout." });
  } catch (err) {
    console.error("leave hangout error:", err);
    res.status(500).json({ message: "Server error while leaving hangout." });
  }
});

/**
 * Get hangout participants
 * GET /hangouts/:id/participants
 */
router.get("/:id/participants", async (req, res) => {
  const hangoutId = Number(req.params.id);

  try {
    const { data: participants, error } = await supabase
      .from("hangout_participants")
      .select("username, status, joined_at")
      .eq("hangout_id", hangoutId)
      .eq("status", "joined");

    if (error) throw error;

    if (!participants || participants.length === 0) return res.json([]);

    const usernames = participants.map((p) => p.username);
    const { data: users, error: uErr } = await supabase
      .from("users")
      .select("id, username, name, avatar, bio, latitude, longitude, is_online")
      .in("username", usernames);

    if (uErr) throw uErr;

    const userMap = new Map(users.map((u) => [u.username, u]));
    const enriched = participants.map((p) => ({
      ...p,
      user: userMap.get(p.username) || null,
    }));

    res.json(enriched);
  } catch (err) {
    console.error("get hangout participants error:", err);
    res.status(500).json({ message: "Server error while fetching participants." });
  }
});

/* --------------------------- Hangout Connections --------------------------- */

/**
 * Create a hangout connection (when users meet)
 * POST /hangouts/connections
 * Body: { user1_username, user2_username, hangout_id?, location1_lat?, location1_lng?, 
 *         location2_lat?, location2_lng? }
 */
router.post("/connections", async (req, res) => {
  const {
    user1_username,
    user2_username,
    hangout_id,
    location1_lat,
    location1_lng,
    location2_lat,
    location2_lng,
  } = req.body;

  if (!user1_username || !user2_username) {
    return res.status(400).json({ message: "Missing user usernames." });
  }

  try {
    // Ensure ordering for unique constraint
    const [u1, u2] =
      user1_username < user2_username
        ? [user1_username, user2_username]
        : [user2_username, user1_username];

    const { data, error } = await supabase
      .from("hangout_connections")
      .insert([
        {
          user1_username: u1,
          user2_username: u2,
          hangout_id,
          location1_lat,
          location1_lng,
          location2_lat,
          location2_lng,
        },
      ])
      .select("*")
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error("create connection error:", err);
    res.status(500).json({ message: "Server error while creating connection." });
  }
});

/**
 * Get user's hangout connections history
 * GET /hangouts/connections/:username
 */
router.get("/connections/:username", async (req, res) => {
  const { username } = req.params;
  const limit = Math.min(Number(req.query.limit || 20), 100);

  try {
    const { data, error } = await supabase
      .from("hangout_connections")
      .select("*")
      .or(`user1_username.eq.${username},user2_username.eq.${username}`)
      .order("connection_date", { ascending: false })
      .limit(limit);

    if (error) throw error;

    // Enrich with other user's info
    const connections = data || [];
    const otherUsernames = connections.map((c) =>
      c.user1_username === username ? c.user2_username : c.user1_username
    );

    if (otherUsernames.length > 0) {
      const { data: users, error: uErr } = await supabase
        .from("users")
        .select("id, username, name, avatar, bio")
        .in("username", otherUsernames);

      if (uErr) throw uErr;

      const userMap = new Map(users.map((u) => [u.username, u]));
      const enriched = connections.map((c) => {
        const otherUsername = c.user1_username === username ? c.user2_username : c.user1_username;
        return {
          ...c,
          other_user: userMap.get(otherUsername) || null,
        };
      });

      return res.json(enriched);
    }

    res.json(connections);
  } catch (err) {
    console.error("get connections error:", err);
    res.status(500).json({ message: "Server error while fetching connections." });
  }
});

/* ---------------------------- User's Hangouts ------------------------------ */

/**
 * Get user's created hangouts
 * GET /hangouts/user/:username/created
 */
router.get("/user/:username/created", async (req, res) => {
  const { username } = req.params;
  const limit = Math.min(Number(req.query.limit || 20), 100);

  try {
    const { data, error } = await supabase
      .from("hangouts")
      .select("*")
      .eq("creator_username", username)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("get user created hangouts error:", err);
    res.status(500).json({ message: "Server error while fetching created hangouts." });
  }
});

/**
 * Get user's joined hangouts
 * GET /hangouts/user/:username/joined
 */
router.get("/user/:username/joined", async (req, res) => {
  const { username } = req.params;
  const limit = Math.min(Number(req.query.limit || 20), 100);

  try {
    const { data: participations, error: pErr } = await supabase
      .from("hangout_participants")
      .select("hangout_id, status, joined_at")
      .eq("username", username)
      .eq("status", "joined");

    if (pErr) throw pErr;

    if (!participations || participations.length === 0) return res.json([]);

    const hangoutIds = participations.map((p) => p.hangout_id);
    const { data: hangouts, error: hErr } = await supabase
      .from("hangouts")
      .select("*")
      .in("id", hangoutIds)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (hErr) throw hErr;
    res.json(hangouts || []);
  } catch (err) {
    console.error("get user joined hangouts error:", err);
    res.status(500).json({ message: "Server error while fetching joined hangouts." });
  }
});

module.exports = router;
