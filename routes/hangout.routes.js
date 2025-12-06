const express = require("express");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");
const { calculateDistance } = require("../utils/distance");

/* ----------------------------- HELPER FUNCTIONS ---------------------------- */

/* ============================================================================
   1) USER HANGOUT STATUS (VISIBLE / HIDDEN)
   ========================================================================== */

/**
 * UPDATE HANGOUT STATUS
 * PUT /hangouts/status
 */
router.put("/status", async (req, res) => {
   const { username, is_available, current_activity, activities } = req.body;

   if (!username) return res.status(400).json({ message: "Missing username." });

   try {
      const payload = {
         username,
         is_available: !!is_available,
         current_activity: current_activity || "",
         activities: Array.isArray(activities) ? activities : [],
      };

      const { data, error } = await supabase
         .from("user_hangout_status")
         .upsert([payload], { onConflict: "username" })
         .select("*")
         .single();

      if (error) throw error;

      res.json(data);
   } catch (err) {
      console.error("update hangout status error:", err);
      res.status(500).json({ message: "Server error while updating status." });
   }
});

/**
 * GET USER HANGOUT STATUS
 * GET /hangouts/status/:username
 */
router.get("/status/:username", async (req, res) => {
   const { username } = req.params;

   try {
      const { data, error } = await supabase
         .from("user_hangout_status")
         .select("*")
         .eq("username", username)
         .maybeSingle();

      if (error) throw error;

      res.json(
         data || {
            username,
            is_available: false,
            current_activity: "",
            activities: [],
         }
      );
   } catch (err) {
      console.error("fetch status error:", err);
      res.status(500).json({ message: "Server error while fetching status." });
   }
});

/* ============================================================================
   2) UPDATE USER LOCATION
   ========================================================================== */

/**
 * UPDATE LOCATION
 * PUT /hangouts/location
 */
router.put("/location", async (req, res) => {
   try {
      const { username, latitude, longitude } = req.body;

      if (!username) return res.status(400).json({ error: "username is required" });

      const { error } = await supabase
         .from("users")
         .update({
            latitude,
            longitude,
            updated_at: new Date(),
         })
         .eq("username", username);

      if (error) throw error;

      return res.json({ success: true });
   } catch (err) {
      console.error("Update location error:", err);
      res.status(500).json({ error: "Failed to update location" });
   }
});

/**
 * GET VISIBLE USERS WITH LOCATION
 * GET /hangouts/locations
 */
router.get("/locations", async (req, res) => {
   try {
      const { data, error } = await supabase
         .from("users")
         .select("id, username, name, avatar, latitude, longitude")
         .not("latitude", "is", null)
         .not("longitude", "is", null);

      if (error) throw error;

      const formatted = (data || []).map((u) => ({
         id: u.id,
         username: u.username,
         name: u.name,
         avatar: u.avatar,
         location: {
            latitude: u.latitude,
            longitude: u.longitude,
         },
      }));

      return res.json(formatted);
   } catch (err) {
      console.error("Get locations error:", err);
      res.status(500).json({ error: "Failed to fetch locations" });
   }
});

/* ============================================================================
   3) GET USERS AVAILABLE FOR HANGOUT (TINDER FEATURE)
   ========================================================================== */

router.get("/", async (req, res) => {
   const limit = Math.min(Number(req.query.limit || 50), 100);
   const distanceKm = Number(req.query.distance_km || 0);
   const userLat = req.query.user_lat ? Number(req.query.user_lat) : null;
   const userLng = req.query.user_lng ? Number(req.query.user_lng) : null;

   try {
      // Get all available usernames
      const { data: statuses } = await supabase.from("user_hangout_status").select("username").eq("is_available", true);

      const available = statuses?.map((s) => s.username) || [];
      if (available.length === 0) return res.json([]);

      // Fetch users
      let query = supabase
         .from("users")
         .select(
            `
        id, username, name, avatar, background_image,
        country, city, bio, age, interests,
        latitude, longitude, is_online, current_activity
      `
         )
         .in("username", available)
         .eq("is_online", true);

      if (limit) query = query.limit(limit);

      const { data: users, error } = await query;
      if (error) throw error;

      let result = users;

      // Calculate distance
      if (userLat !== null && userLng !== null) {
         result = result.map((u) => {
            const dist =
               u.latitude && u.longitude ? calculateDistance(userLat, userLng, u.latitude, u.longitude) : null;

            return { ...u, distance: dist };
         });

         if (distanceKm > 0) {
            result = result.filter((u) => u.distance !== null && u.distance <= distanceKm);
         }

         result.sort((a, b) => {
            if (a.distance === null) return 1;
            if (b.distance === null) return -1;
            return a.distance - b.distance;
         });
      }

      res.json(result);
   } catch (err) {
      console.error("list hangout users error:", err);
      res.status(500).json({ message: "Server error while fetching hangout users." });
   }
});

///POST /hangouts/swipe
router.post("/swipe", async (req, res) => {
   console.log(">>> SWIPE REQUEST BODY:", req.body);
   const { swiper, target, direction } = req.body;

   if (!swiper || !target || !direction) return res.status(400).json({ message: "Missing fields" });

   const { error } = await supabase
      .from("user_swipes")
      .insert([{ swiper_username: swiper, target_username: target, direction }]);

   if (error) return res.status(500).json({ error });

   res.json({ success: true });
});

// DELETE swipe
router.delete("/swipe", async (req, res) => {
   const { swiper, target } = req.body;

   if (!swiper || !target) {
      return res.status(400).json({ message: "Missing fields" });
   }
   try {
      const { error } = await supabase
         .from("user_swipes")
         .delete()
         .eq("swiper_username", swiper)
         .eq("target_username", target)
         .eq("direction", "right");

      if (error) throw error;

      res.json({ success: true });
   } catch (err) {
      console.error("delete swipe error:", err);
      res.status(500).json({ error: "Server error while deleting swipe" });
   }
});

//GET /hangouts/swipe/right?username=khanh
router.get("/swipe/right", async (req, res) => {
   const username = req.query.username;

   const { data, error } = await supabase
      .from("user_swipes")
      .select("target_username")
      .eq("swiper_username", username)
      .eq("direction", "right")
      .order("created_at", { ascending: false });

   if (error) return res.status(500).json({ error });

   res.json(data.map((row) => row.target_username));
});

module.exports = router;
