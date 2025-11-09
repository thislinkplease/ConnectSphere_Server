const express = require("express");
const multer = require("multer");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");
const upload = multer({ storage: multer.memoryStorage() });

/* ---------------------------------- Helpers ---------------------------------- */

async function countFollowers(username) {
  const { count, error } = await supabase
    .from("user_follows")
    .select("id", { count: "exact", head: true })
    .eq("followee_username", username);
  if (error) throw error;
  return count || 0;
}

async function countFollowing(username) {
  const { count, error } = await supabase
    .from("user_follows")
    .select("id", { count: "exact", head: true })
    .eq("follower_username", username);
  if (error) throw error;
  return count || 0;
}

async function countPosts(username) {
  const { count, error } = await supabase
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("author_username", username);
  if (error) throw error;
  return count || 0;
}

async function updateFollowCounters({ followerUsername, followeeUsername }) {
  const followerFollowing = await countFollowing(followerUsername);
  const followeeFollowers = await countFollowers(followeeUsername);

  const updates = [];
  updates.push(
    supabase.from("users").update({ is_following: followerFollowing }).eq("username", followerUsername)
  );
  updates.push(
    supabase.from("users").update({ is_follower: followeeFollowers }).eq("username", followeeUsername)
  );

  const [u1, u2] = await Promise.all(updates);
  if (u1.error) throw u1.error;
  if (u2.error) throw u2.error;

  return { followerFollowing, followeeFollowers };
}

async function getUserById(id) {
  const { data, error } = await supabase.from("users").select("*").eq("id", id).single();
  if (error) throw error;
  return data || null;
}

async function getUserByUsername(username) {
  const { data, error } = await supabase.from("users").select("*").eq("username", username).single();
  if (error) throw error;
  return data || null;
}

/* ----------------------------- Profile Endpoints ----------------------------- */

/**
 * Get current user (requires authentication via token/header)
 * GET /users/me
 * For now, we'll use a simple auth header: Authorization: Bearer <token>
 * Token format: base64(userId:timestamp)
 */
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Missing or invalid authorization header." });
    }

    const token = authHeader.substring(7); // Remove "Bearer "
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const userId = decoded.split(":")[0];

    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found." });

    const [followers, following, posts] = await Promise.all([
      countFollowers(user.username),
      countFollowing(user.username),
      countPosts(user.username),
    ]);

    res.json({ ...user, followers, following, posts });
  } catch (err) {
    console.error("get current user error:", err);
    res.status(500).json({ message: "Server error while fetching current user." });
  }
});

/**
 * Create or update a user profile (called after Supabase Auth signup)
 * POST /users/create-profile
 * Body: { id, email, username, name?, gender?, bio?, avatar? }
 */
router.post("/create-profile", async (req, res) => {
  const { id, email, username, name, gender, bio, avatar } = req.body;
  if (!id || !email || !username) return res.status(400).json({ message: "Missing required fields." });

  try {
    // Ensure username uniqueness if changing it
    if (username) {
      const { data: exists, error: existsErr } = await supabase
        .from("users")
        .select("id")
        .eq("username", username)
        .neq("id", id)
        .limit(1);
      if (existsErr) throw existsErr;
      if (exists && exists.length > 0) {
        return res.status(409).json({ message: "Username already taken." });
      }
    }

    const { data, error } = await supabase
      .from("users")
      .upsert([{ id, email, username, name, gender, bio, avatar }])
      .select("*")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("create-profile error:", err);
    res.status(500).json({ message: "Server error while creating/updating profile." });
  }
});

/**
 * Get profile by user id (with counters)
 * GET /users/id/:id
 */
router.get("/id/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const user = await getUserById(id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const [followers, following, posts] = await Promise.all([
      countFollowers(user.username),
      countFollowing(user.username),
      countPosts(user.username),
    ]);

    res.json({ ...user, followers, following, posts });
  } catch (err) {
    console.error("get by id error:", err);
    res.status(500).json({ message: "Server error while fetching profile." });
  }
});

/**
 * Get profile by username (with counters)
 * GET /users/username/:username
 */
router.get("/username/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const user = await getUserByUsername(username);
    if (!user) return res.status(404).json({ message: "User not found." });

    const [followers, following, posts] = await Promise.all([
      countFollowers(username),
      countFollowing(username),
      countPosts(username),
    ]);

    res.json({ ...user, followers, following, posts });
  } catch (err) {
    console.error("get by username error:", err);
    res.status(500).json({ message: "Server error while fetching profile." });
  }
});

/**
 * Update profile by id
 * PUT /users/:id
 * Body: { name?, gender?, bio?, avatar?, username?, status?, age?, date_of_birth?,
 *         country?, city?, flag?, interests?, about_me?, specialties?, 
 *         latitude?, longitude?, is_online? }
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { 
    name, gender, bio, avatar, username, status, age, date_of_birth,
    country, city, flag, interests, about_me, specialties,
    latitude, longitude, is_online
  } = req.body;

  try {
    if (username) {
      const { data: exists, error: existsErr } = await supabase
        .from("users")
        .select("id")
        .eq("username", username)
        .neq("id", id)
        .limit(1);
      if (existsErr) throw existsErr;
      if (exists && exists.length > 0) {
        return res.status(409).json({ message: "Username already taken." });
      }
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (gender !== undefined) updates.gender = gender;
    if (bio !== undefined) updates.bio = bio;
    if (avatar !== undefined) updates.avatar = avatar;
    if (username !== undefined) updates.username = username;
    if (status !== undefined) updates.status = status;
    if (age !== undefined) updates.age = age;
    if (date_of_birth !== undefined) updates.date_of_birth = date_of_birth;
    if (country !== undefined) updates.country = country;
    if (city !== undefined) updates.city = city;
    if (flag !== undefined) updates.flag = flag;
    if (interests !== undefined) updates.interests = interests;
    if (about_me !== undefined) updates.about_me = about_me;
    if (specialties !== undefined) updates.specialties = specialties;
    if (latitude !== undefined) updates.latitude = latitude;
    if (longitude !== undefined) updates.longitude = longitude;
    if (is_online !== undefined) updates.is_online = is_online;
    if (is_online !== undefined || latitude !== undefined) {
      updates.location_updated_at = new Date().toISOString();
    }
    if (!is_online && is_online !== undefined) {
      updates.last_seen = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("update profile error:", err);
    res.status(500).json({ message: "Server error while updating profile." });
  }
});

/* ------------------------------- Search & Check ------------------------------ */

/**
 * Get all users with optional filters
 * GET /users?limit=20&gender=Male&min_age=18&max_age=30
 */
router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const genderParam = req.query.gender;
  const minAge = req.query.min_age ? Number(req.query.min_age) : null;
  const maxAge = req.query.max_age ? Number(req.query.max_age) : null;

  // Validate gender parameter (only allow specific values)
  const validGenders = ["Male", "Female", "Other"];
  const gender = genderParam && validGenders.includes(genderParam) ? genderParam : null;

  try {
    let query = supabase
      .from("users")
      .select("id, email, name, avatar, bio, username, country, city, status, gender, age, latitude, longitude, is_online, interests")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (gender) {
      query = query.eq("gender", gender);
    }

    if (minAge !== null) {
      query = query.gte("age", minAge);
    }

    if (maxAge !== null) {
      query = query.lte("age", maxAge);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error("get users error:", err);
    res.status(500).json({ message: "Server error while fetching users." });
  }
});

/**
 * Search users by username or name (case-insensitive)
 * GET /users/search?q=keyword
 */
router.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, email, name, avatar, bio, username, is_following, is_follower")
      .or(`username.ilike.%${q}%,name.ilike.%${q}%`)
      .order("username", { ascending: true })
      .limit(30);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("search users error:", err);
    res.status(500).json({ message: "Server error while searching users." });
  }
});

/**
 * Check username availability
 * GET /users/check-username?username=foo
 */
router.get("/check-username", async (req, res) => {
  const username = (req.query.username || "").trim();
  if (!username) return res.status(400).json({ message: "Missing username." });
  try {
    const { data, error } = await supabase.from("users").select("id").eq("username", username).limit(1);
    if (error) throw error;
    const available = !data || data.length === 0;
    res.json({ username, available });
  } catch (err) {
    console.error("check-username error:", err);
    res.status(500).json({ message: "Server error while checking username." });
  }
});

/**
 * Get user by ID (UUID format) - client-preferred endpoint
 * GET /users/:id
 * This must come before /:username routes to properly match UUIDs
 */
router.get("/:id([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", async (req, res) => {
  const { id } = req.params;
  try {
    const user = await getUserById(id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const [followers, following, posts] = await Promise.all([
      countFollowers(user.username),
      countFollowing(user.username),
      countPosts(user.username),
    ]);

    res.json({ ...user, followers, following, posts });
  } catch (err) {
    console.error("get by id error:", err);
    res.status(500).json({ message: "Server error while fetching profile." });
  }
});

/* ------------------------------- Follow System ------------------------------- */

/**
 * Follow a user
 * POST /users/:username/follow
 * Body: { followerUsername }
 */
router.post("/:username/follow", async (req, res) => {
  const followeeUsername = req.params.username;
  const { followerUsername } = req.body;

  if (!followerUsername) return res.status(400).json({ message: "Missing follower username." });
  if (followerUsername === followeeUsername)
    return res.status(400).json({ message: "You cannot follow yourself." });

  try {
    // Ensure both users exist
    const [follower, followee] = await Promise.all([
      getUserByUsername(followerUsername),
      getUserByUsername(followeeUsername),
    ]);
    if (!follower || !followee) return res.status(404).json({ message: "User not found." });

    // Insert follow relation (ignore duplicate)
    const ins = await supabase
      .from("user_follows")
      .insert([{ follower_username: followerUsername, followee_username: followeeUsername }])
      .select();
    if (ins.error && !String(ins.error.message).toLowerCase().includes("duplicate")) throw ins.error;

    // Update counters
    await updateFollowCounters({ followerUsername, followeeUsername });

    res.json({ message: "Followed successfully." });
  } catch (err) {
    console.error("follow error:", err);
    res.status(500).json({ message: "Server error while following user." });
  }
});

/**
 * Unfollow a user
 * DELETE /users/:username/follow
 * Body: { followerUsername }
 */
router.delete("/:username/follow", async (req, res) => {
  const followeeUsername = req.params.username;
  const { followerUsername } = req.body;

  if (!followerUsername) return res.status(400).json({ message: "Missing follower username." });

  try {
    const del = await supabase
      .from("user_follows")
      .delete()
      .eq("follower_username", followerUsername)
      .eq("followee_username", followeeUsername);

    if (del.error) throw del.error;

    // Update counters
    await updateFollowCounters({ followerUsername, followeeUsername });

    res.json({ message: "Unfollowed successfully." });
  } catch (err) {
    console.error("unfollow error:", err);
    res.status(500).json({ message: "Server error while unfollowing user." });
  }
});

/**
 * Get followers of a user
 * GET /users/:username/followers
 * Optional query: viewer=<username> to include "is_followed_by_viewer"
 */
router.get("/:username/followers", async (req, res) => {
  const { username } = req.params;
  const viewer = (req.query.viewer || "").trim();

  try {
    // Base list of followers
    const { data: list, error } = await supabase
      .from("user_follows")
      .select("follower_username")
      .eq("followee_username", username);
    if (error) throw error;

    const followerUsernames = list.map((r) => r.follower_username);
    if (followerUsernames.length === 0) return res.json([]);

    // Fetch minimal profiles
    const { data: profiles, error: pErr } = await supabase
      .from("users")
      .select("id, username, name, avatar, bio")
      .in("username", followerUsernames);
    if (pErr) throw pErr;

    // Optionally compute if viewer follows each profile
    if (viewer) {
      const { data: viewerFollows, error: vfErr } = await supabase
        .from("user_follows")
        .select("followee_username")
        .eq("follower_username", viewer)
        .in("followee_username", followerUsernames);
      if (vfErr) throw vfErr;
      const set = new Set(viewerFollows.map((r) => r.followee_username));
      return res.json(profiles.map((p) => ({ ...p, is_followed_by_viewer: set.has(p.username) })));
    }

    res.json(profiles);
  } catch (err) {
    console.error("get followers error:", err);
    res.status(500).json({ message: "Server error while fetching followers." });
  }
});

/**
 * Get following (who the user follows)
 * GET /users/:username/following
 * Optional query: viewer=<username>
 */
router.get("/:username/following", async (req, res) => {
  const { username } = req.params;
  const viewer = (req.query.viewer || "").trim();

  try {
    const { data: list, error } = await supabase
      .from("user_follows")
      .select("followee_username")
      .eq("follower_username", username);
    if (error) throw error;

    const followeeUsernames = list.map((r) => r.followee_username);
    if (followeeUsernames.length === 0) return res.json([]);

    const { data: profiles, error: pErr } = await supabase
      .from("users")
      .select("id, username, name, avatar, bio")
      .in("username", followeeUsernames);
    if (pErr) throw pErr;

    if (viewer) {
      const { data: viewerFollows, error: vfErr } = await supabase
        .from("user_follows")
        .select("followee_username")
        .eq("follower_username", viewer)
        .in("followee_username", followeeUsernames);
      if (vfErr) throw vfErr;
      const set = new Set(viewerFollows.map((r) => r.followee_username));
      return res.json(profiles.map((p) => ({ ...p, is_followed_by_viewer: set.has(p.username) })));
    }

    res.json(profiles);
  } catch (err) {
    console.error("get following error:", err);
    res.status(500).json({ message: "Server error while fetching following." });
  }
});

/**
 * Check follow status (does viewer follow target?)
 * GET /users/:username/follow-status?viewer=<viewerUsername>
 */
router.get("/:username/follow-status", async (req, res) => {
  const target = req.params.username;
  const viewer = (req.query.viewer || "").trim();
  if (!viewer) return res.status(400).json({ message: "Missing viewer." });

  try {
    const { data, error } = await supabase
      .from("user_follows")
      .select("id")
      .eq("follower_username", viewer)
      .eq("followee_username", target)
      .limit(1);

    if (error) throw error;
    res.json({ viewer, target, is_following: !!(data && data.length) });
  } catch (err) {
    console.error("follow-status error:", err);
    res.status(500).json({ message: "Server error while checking follow status." });
  }
});

/* ------------------------------- User Content -------------------------------- */

/**
 * Get a user's posts with media
 * GET /users/:username/posts
 * Optional: ?limit=20
 */
router.get("/:username/posts", async (req, res) => {
  const { username } = req.params;
  const limit = Number(req.query.limit || 20);

  try {
    const { data, error } = await supabase
      .from("posts")
      .select(
        "id, author_username, content, status, audience, disable_comments, hide_like_count, like_count, comment_count, created_at, updated_at, post_media(id, media_url, media_type, position)"
      )
      .eq("author_username", username)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("user posts error:", err);
    res.status(500).json({ message: "Server error while fetching user posts." });
  }
});

/**
 * Get posts liked by a user
 * GET /users/:username/liked-posts
 * Optional: ?limit=20
 */
router.get("/:username/liked-posts", async (req, res) => {
  const { username } = req.params;
  const limit = Number(req.query.limit || 20);

  try {
    // Get post_ids liked by user
    const { data: likes, error: lErr } = await supabase
      .from("post_likes")
      .select("post_id")
      .eq("username", username)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (lErr) throw lErr;

    const ids = likes.map((r) => r.post_id);
    if (ids.length === 0) return res.json([]);

    // Fetch posts with media
    const { data: posts, error: pErr } = await supabase
      .from("posts")
      .select(
        "id, author_username, content, status, audience, disable_comments, hide_like_count, like_count, comment_count, created_at, updated_at, post_media(id, media_url, media_type, position)"
      )
      .in("id", ids);
    if (pErr) throw pErr;

    // Keep original like ordering
    const map = new Map(posts.map((p) => [p.id, p]));
    const ordered = ids.map((id) => map.get(id)).filter(Boolean);

    res.json(ordered);
  } catch (err) {
    console.error("liked-posts error:", err);
    res.status(500).json({ message: "Server error while fetching liked posts." });
  }
});

/* ------------------------------- Avatar Upload -------------------------------- */

/**
 * Upload avatar to Supabase Storage and update profile (client-preferred endpoint)
 * POST /users/:userId/avatar
 * FormData: avatar (file)
 */
router.post("/:userId/avatar", upload.single("avatar"), async (req, res) => {
  const userId = req.params.userId;
  const file = req.file;

  if (!userId) return res.status(400).json({ message: "Missing user id." });
  if (!file) return res.status(400).json({ message: "No file uploaded." });

  try {
    // Get user to read username for filename
    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found." });

    const fileName = `${user.username || userId}_${Date.now()}_${file.originalname}`;
    const filePath = `avatars/${fileName}`;

    // Upload to Storage
    const up = await supabase.storage
      .from("avatars")
      .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });
    if (up.error) throw up.error;

    // Public URL
    const { data: publicUrl } = supabase.storage.from("avatars").getPublicUrl(filePath);
    const avatarUrl = publicUrl.publicUrl;

    // Update DB
    const { error: updateErr } = await supabase.from("users").update({ avatar: avatarUrl }).eq("id", userId);
    if (updateErr) throw updateErr;

    res.json({ avatarUrl });
  } catch (err) {
    console.error("upload-avatar error:", err);
    res.status(500).json({ message: "Server error while uploading avatar." });
  }
});

/**
 * Upload avatar to Supabase Storage and update profile (legacy endpoint)
 * POST /users/upload-avatar?id=<user_id>
 * FormData: avatar (file)
 */
router.post("/upload-avatar", upload.single("avatar"), async (req, res) => {
  const userId = req.query.id;
  const file = req.file;

  if (!userId) return res.status(400).json({ message: "Missing user id." });
  if (!file) return res.status(400).json({ message: "No file uploaded." });

  try {
    // Get user to read username for filename
    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found." });

    const fileName = `${user.username || userId}_${Date.now()}_${file.originalname}`;
    const filePath = `avatars/${fileName}`;

    // Upload to Storage
    const up = await supabase.storage
      .from("avatars")
      .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });
    if (up.error) throw up.error;

    // Public URL
    const { data: publicUrl } = supabase.storage.from("avatars").getPublicUrl(filePath);
    const avatarUrl = publicUrl.publicUrl;

    // Update DB
    const { error: updateErr } = await supabase.from("users").update({ avatar: avatarUrl }).eq("id", userId);
    if (updateErr) throw updateErr;

    res.json({ avatarUrl });
  } catch (err) {
    console.error("upload-avatar error:", err);
    res.status(500).json({ message: "Server error while uploading avatar." });
  }
});

/* --------------------------------- User Stats -------------------------------- */

/**
 * Get lightweight user stats (followers, following, posts)
 * GET /users/:username/stats
 */
router.get("/:username/stats", async (req, res) => {
  const { username } = req.params;
  try {
    const [followers, following, posts] = await Promise.all([
      countFollowers(username),
      countFollowing(username),
      countPosts(username),
    ]);
    res.json({ username, followers, following, posts });
  } catch (err) {
    console.error("stats error:", err);
    res.status(500).json({ message: "Server error while fetching stats." });
  }
});

/* ---------------------------- User Languages ------------------------------- */

/**
 * Get user languages
 * GET /users/:username/languages
 */
router.get("/:username/languages", async (req, res) => {
  const { username } = req.params;
  
  try {
    const { data, error } = await supabase
      .from("user_languages")
      .select("*")
      .eq("username", username)
      .order("created_at", { ascending: true });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("get user languages error:", err);
    res.status(500).json({ message: "Server error while fetching languages." });
  }
});

/**
 * Add or update user language
 * POST /users/:username/languages
 * Body: { language, proficiency }
 */
router.post("/:username/languages", async (req, res) => {
  const { username } = req.params;
  const { language, proficiency = "Intermediate" } = req.body;
  
  if (!language) return res.status(400).json({ message: "Missing language." });
  
  try {
    const { data, error } = await supabase
      .from("user_languages")
      .upsert([{ username, language, proficiency }])
      .select("*")
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("add user language error:", err);
    res.status(500).json({ message: "Server error while adding language." });
  }
});

/**
 * Delete user language
 * DELETE /users/:username/languages/:languageId
 */
router.delete("/:username/languages/:languageId", async (req, res) => {
  const { username } = req.params;
  const languageId = Number(req.params.languageId);
  
  try {
    const { error } = await supabase
      .from("user_languages")
      .delete()
      .eq("id", languageId)
      .eq("username", username);
    
    if (error) throw error;
    res.json({ message: "Language deleted." });
  } catch (err) {
    console.error("delete user language error:", err);
    res.status(500).json({ message: "Server error while deleting language." });
  }
});

/* ----------------------------- User Countries ------------------------------ */

/**
 * Get user countries (lived/visited)
 * GET /users/:username/countries?type=lived|visited
 */
router.get("/:username/countries", async (req, res) => {
  const { username } = req.params;
  const type = req.query.type; // 'lived' or 'visited'
  
  try {
    let query = supabase
      .from("user_countries")
      .select("*")
      .eq("username", username)
      .order("created_at", { ascending: true });
    
    if (type) {
      query = query.eq("country_type", type);
    }
    
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("get user countries error:", err);
    res.status(500).json({ message: "Server error while fetching countries." });
  }
});

/**
 * Add user country
 * POST /users/:username/countries
 * Body: { country, country_type: 'lived'|'visited' }
 */
router.post("/:username/countries", async (req, res) => {
  const { username } = req.params;
  const { country, country_type } = req.body;
  
  if (!country || !country_type) {
    return res.status(400).json({ message: "Missing country or country_type." });
  }
  
  try {
    const { data, error } = await supabase
      .from("user_countries")
      .upsert([{ username, country, country_type }])
      .select("*")
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("add user country error:", err);
    res.status(500).json({ message: "Server error while adding country." });
  }
});

/**
 * Delete user country
 * DELETE /users/:username/countries/:countryId
 */
router.delete("/:username/countries/:countryId", async (req, res) => {
  const { username } = req.params;
  const countryId = Number(req.params.countryId);
  
  try {
    const { error } = await supabase
      .from("user_countries")
      .delete()
      .eq("id", countryId)
      .eq("username", username);
    
    if (error) throw error;
    res.json({ message: "Country deleted." });
  } catch (err) {
    console.error("delete user country error:", err);
    res.status(500).json({ message: "Server error while deleting country." });
  }
});

/* ------------------------- Profile Completion ------------------------------ */

/**
 * Calculate and get profile completion percentage
 * GET /users/:username/profile-completion
 */
router.get("/:username/profile-completion", async (req, res) => {
  const { username } = req.params;
  
  try {
    const user = await getUserByUsername(username);
    if (!user) return res.status(404).json({ message: "User not found." });
    
    let completion = 0;
    const checklist = [];
    
    // Name (10%)
    if (user.name && user.name.trim()) {
      completion += 10;
      checklist.push({ item: "Add name", completed: true });
    } else {
      checklist.push({ item: "Add name", completed: false });
    }
    
    // Bio (10%)
    if (user.bio && user.bio.trim()) {
      completion += 10;
      checklist.push({ item: "Add bio", completed: true });
    } else {
      checklist.push({ item: "Add bio", completed: false });
    }
    
    // About me (10%)
    if (user.about_me && user.about_me.trim()) {
      completion += 10;
      checklist.push({ item: "Add about me", completed: true });
    } else {
      checklist.push({ item: "Add about me", completed: false });
    }
    
    // Avatar (15%)
    if (user.avatar && user.avatar.trim()) {
      completion += 15;
      checklist.push({ item: "Upload photo", completed: true });
    } else {
      checklist.push({ item: "Upload photo", completed: false });
    }
    
    // Email confirmed (15%)
    if (user.email_confirmed) {
      completion += 15;
      checklist.push({ item: "Confirm email", completed: true });
    } else {
      checklist.push({ item: "Confirm email", completed: false });
    }
    
    // Location (10%)
    if (user.country && user.city) {
      completion += 10;
      checklist.push({ item: "Add location", completed: true });
    } else {
      checklist.push({ item: "Add location", completed: false });
    }
    
    // Languages (10%)
    const { data: languages, error: langErr } = await supabase
      .from("user_languages")
      .select("id")
      .eq("username", username)
      .limit(1);
    
    if (!langErr && languages && languages.length > 0) {
      completion += 10;
      checklist.push({ item: "Add languages", completed: true });
    } else {
      checklist.push({ item: "Add languages", completed: false });
    }
    
    // Interests (10%)
    if (user.interests && Array.isArray(user.interests) && user.interests.length > 0) {
      completion += 10;
      checklist.push({ item: "Add interests", completed: true });
    } else {
      checklist.push({ item: "Add interests", completed: false });
    }
    
    // Countries visited/lived (10%)
    const { data: countries, error: countryErr } = await supabase
      .from("user_countries")
      .select("id")
      .eq("username", username)
      .limit(1);
    
    if (!countryErr && countries && countries.length > 0) {
      completion += 10;
      checklist.push({ item: "Add countries", completed: true });
    } else {
      checklist.push({ item: "Add countries", completed: false });
    }
    
    // Update the completion percentage in the database
    await supabase
      .from("users")
      .update({ profile_completion_percentage: completion })
      .eq("username", username);
    
    res.json({
      username,
      completion_percentage: completion,
      checklist
    });
  } catch (err) {
    console.error("profile completion error:", err);
    res.status(500).json({ message: "Server error while calculating profile completion." });
  }
});

module.exports = router;
