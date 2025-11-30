// routes/events.routes.js
const express = require("express");
const multer = require("multer");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");
const upload = multer({ storage: multer.memoryStorage() });

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                  */
/* -------------------------------------------------------------------------- */

function calculateDistance(lat1, lon1, lat2, lon2) {
   const R = 6371;
   const dLat = ((lat2 - lat1) * Math.PI) / 180;
   const dLon = ((lon2 - lon1) * Math.PI) / 180;

   const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;

   return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getEventById(id) {
   const { data, error } = await supabase.from("events").select("*").eq("id", id).single();
   if (error) throw error;
   return data;
}

async function getParticipants(eventId) {
   const { data, error } = await supabase
      .from("event_participants")
      .select("username, status, joined_at")
      .eq("event_id", eventId)
      .in("status", ["interested", "going"]);

   if (error) throw error;
   return data || [];
}

/* -------------------------------------------------------------------------- */
/*                      1. SEARCH – USER EVENTS – ORDER FIRST                 */
/* -------------------------------------------------------------------------- */

router.get("/search", async (req, res) => {
   const q = (req.query.q || "").trim();
   if (!q) return res.json([]);

   try {
      const { data, error } = await supabase
         .from("events")
         .select("*")
         .or(`name.ilike.%${q}%,description.ilike.%${q}%`)
         .eq("status", "upcoming")
         .order("date_start", { ascending: true });

      if (error) throw error;
      res.json(data || []);
   } catch (err) {
      console.error("Search events error:", err);
      res.status(500).json({ message: "Search failed." });
   }
});

/* Get events created by a user */
router.get("/user/:username/created", async (req, res) => {
   try {
      const { data, error } = await supabase
         .from("events")
         .select("*")
         .eq("hosted_by", req.params.username)
         .order("date_start");

      if (error) throw error;
      res.json(data || []);
   } catch (err) {
      console.error("Created events error:", err);
      res.status(500).json({ message: "Failed to fetch created events." });
   }
});

/* Get events user is participating in */
router.get("/user/:username/participating", async (req, res) => {
   try {
      const { data: participation, error } = await supabase
         .from("event_participants")
         .select("event_id")
         .eq("username", req.params.username)
         .in("status", ["interested", "going"]);

      if (error) throw error;
      if (!participation?.length) return res.json([]);

      const ids = participation.map((p) => p.event_id);

      const { data, error: eventErr } = await supabase.from("events").select("*").in("id", ids).order("date_start");

      if (eventErr) throw eventErr;

      res.json(data || []);
   } catch (err) {
      console.error("Participating events error:", err);
      res.status(500).json({ message: "Failed to fetch participating events." });
   }
});

/* -------------------------------------------------------------------------- */
/*                         UPLOAD EVENT IMAGE (SUPABASE)                      */
/* -------------------------------------------------------------------------- */

router.post("/upload-image", upload.single("image"), async (req, res) => {
   console.log("🔥 FILE RECEIVED:", req.file);

   const file = req.file;
   if (!file) {
      return res.status(400).json({ message: "No image provided." });
   }

   try {
      const fileName = `event_images/${Date.now()}_${file.originalname}`;

      const { error: uploadErr } = await supabase.storage.from("posts").upload(fileName, file.buffer, {
         contentType: file.mimetype,
         upsert: true,
      });

      if (uploadErr) {
         console.error("Supabase upload error:", uploadErr);
         return res.status(500).json({ message: "Failed to upload event image." });
      }

      const { data: publicUrlData } = supabase.storage.from("posts").getPublicUrl(fileName);

      return res.json({
         publicUrl: publicUrlData.publicUrl,
         fileName,
      });
   } catch (err) {
      console.error("Upload event image error:", err);
      return res.status(500).json({ message: "Failed to upload event image." });
   }
});

/* -------------------------------------------------------------------------- */
/*                         2. CREATE EVENT (PRO ONLY)                         */
/* -------------------------------------------------------------------------- */

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
      category,
   } = req.body;

   if (!hosted_by || !name || !address || !date_start || !date_end)
      return res.status(400).json({ message: "Missing required fields." });

   try {
      // CHECK PRO
      const { data: user, error: userErr } = await supabase
         .from("users")
         .select("is_premium")
         .eq("username", hosted_by)
         .single();

      if (userErr || !user) return res.status(404).json({ message: "Host not found." });

      if (!user.is_premium) return res.status(403).json({ message: "Only PRO users can create events." });

      // CREATE EVENT
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
               category,
            },
         ])
         .select("*")
         .single();

      if (error) throw error;
      res.status(201).json(data);
   } catch (err) {
      console.error("Create event error:", err);
      res.status(500).json({ message: "Failed to create event." });
   }
});

router.put("/:id", async (req, res) => {
   const id = Number(req.params.id);
   const username = req.body.username;
   if (!username) {
      return res.status(400).json({ message: "Missing username." });
   }
   const { date_start, date_end, address } = req.body;
   try {
      const { data: event, error: eventErr } = await supabase.from("events").select("hosted_by").eq("id", id).single();

      if (eventErr || !event) {
         return res.status(404).json({ message: "Event not found." });
      }

      if (event.hosted_by !== username) {
         return res.status(403).json({ message: "Only the host can update this event." });
      }

      const updateData = {};

      if (date_start) updateData.date_start = date_start;
      if (date_end) updateData.date_end = date_end;
      if (address) updateData.address = address;

      if (Object.keys(updateData).length === 0) {
         return res.status(400).json({ message: "No valid fields provided to update." });
      }

      // 4. Update event
      const { data, error } = await supabase.from("events").update(updateData).eq("id", id).select("*").single();

      if (error) throw error;

      res.json(data);
   } catch (err) {
      console.error("Update event error:", err);
      res.status(500).json({ message: "Failed to update event." });
   }
});

router.delete("/:id", async (req, res) => {
   const id = Number(req.params.id);
   const username = req.query.username;

   if (!username) return res.status(400).json({ message: "Missing username." });

   const { data: event } = await supabase.from("events").select("hosted_by").eq("id", id).single();

   if (!event) return res.status(404).json({ message: "Event not found" });

   if (event.hosted_by !== username) {
      return res.status(403).json({ message: "Only the host can delete this event." });
   }

   await supabase.from("events").delete().eq("id", id);

   res.json({ message: "Event deleted." });
});

/* -------------------------------------------------------------------------- */
/*                          3. LIST EVENTS (with distance)                    */
/* -------------------------------------------------------------------------- */

router.get("/", async (req, res) => {
   const { user_lat, user_lng, distance_km = 0 } = req.query;

   try {
      const { data, error } = await supabase.from("events").select("*").eq("status", "upcoming").order("date_start");

      if (error) throw error;

      let events = data || [];

      // Attach distance
      if (user_lat && user_lng) {
         const uLat = Number(user_lat);
         const uLng = Number(user_lng);

         events = events.map((e) => {
            const dist = e.latitude && e.longitude ? calculateDistance(uLat, uLng, e.latitude, e.longitude) : null;

            return { ...e, distance: dist };
         });

         if (distance_km > 0) {
            events = events.filter((e) => e.distance !== null && e.distance <= distance_km);
         }

         events.sort((a, b) => {
            if (a.distance == null) return 1;
            if (b.distance == null) return -1;
            return a.distance - b.distance;
         });
      }

      res.json(events);
   } catch (err) {
      console.error("List events error:", err);
      res.status(500).json({ message: "Failed to fetch events." });
   }
});

/* -------------------------------------------------------------------------- */
/*       4. EVENT DETAILS + PARTICIPANTS + COMMENTS + VIEWER STATUS          */
/* -------------------------------------------------------------------------- */

router.get("/:id", async (req, res) => {
   const id = Number(req.params.id);
   const viewer = req.query.viewer;

   try {
      // 1) Load event
      const { data: event, error: err1 } = await supabase.from("events").select("*").eq("id", id).single();

      if (err1) throw err1;

      // 2) Load participants
      const { data: participants } = await supabase
         .from("event_participants")
         .select("username, status")
         .eq("event_id", id);

      const going_count = participants.filter((p) => p.status === "going").length;
      const interested_count = participants.filter((p) => p.status === "interested").length;

      // 3) Viewer status
      let viewer_status = null;
      if (viewer) {
         const { data: viewerData } = await supabase
            .from("event_participants")
            .select("status")
            .eq("event_id", id)
            .eq("username", viewer)
            .single();

         viewer_status = viewerData?.status || null;
      }

      // 4) Load comments
      const { data: comments, error: errComments } = await supabase
         .from("event_comments")
         .select("id, author_username, content, image_url, created_at")
         .eq("event_id", id)
         .order("created_at", { ascending: true });

      if (errComments) throw errComments;

      // 5) Final response
      res.json({
         ...event,
         participants,
         participant_count: participants.length,
         going_count,
         interested_count,
         comment_count: comments?.length || 0,
         viewer_status,
         comments: comments || [],
      });
   } catch (err) {
      console.error("Get event error:", err);
      res.status(500).json({ message: "Failed to fetch event." });
   }
});
/* -------------------------------------------------------------------------- */
/*                        5. JOIN / LEAVE EVENT (CLEAN)                       */
/* -------------------------------------------------------------------------- */

router.post("/:id/participate", async (req, res) => {
   const id = Number(req.params.id);
   const { username, status = "interested" } = req.body;

   if (!username) return res.status(400).json({ message: "Missing username." });

   try {
      const { data, error } = await supabase
         .from("event_participants")
         .upsert([{ event_id: id, username, status }])
         .select("*")
         .single();

      if (error) throw error;

      res.json(data);
   } catch (err) {
      console.error("Join event error:", err);
      res.status(500).json({ message: "Failed to join event." });
   }
});

router.delete("/:id/leave", async (req, res) => {
   const id = Number(req.params.id);
   const { username } = req.body;

   if (!username) return res.status(400).json({ message: "Missing username." });

   try {
      await supabase.from("event_participants").delete().eq("event_id", id).eq("username", username);
      res.json({ message: "Left event." });
   } catch (err) {
      console.error("Leave event error:", err);
      res.status(500).json({ message: "Failed to leave event." });
   }
});

/* -------------------------------------------------------------------------- */
/*                              6. COMMENTS CLEAN                             */
/* -------------------------------------------------------------------------- */

router.post("/:id/comments", upload.single("image"), async (req, res) => {
   const id = Number(req.params.id);
   const { author_username, content } = req.body;
   const file = req.file;

   if (!author_username || !content) return res.status(400).json({ message: "Missing content or author." });

   try {
      let image_url = null;

      if (file) {
         const fileName = `event_comments/${id}/${Date.now()}_${file.originalname}`;
         const uploadRes = await supabase.storage.from("posts").upload(fileName, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
         });

         if (uploadRes.error) throw uploadRes.error;

         const { data } = supabase.storage.from("posts").getPublicUrl(fileName);
         image_url = data.publicUrl;
      }

      const { data, error } = await supabase
         .from("event_comments")
         .insert([{ event_id: id, author_username, content, image_url }])
         .select("*")
         .single();

      if (error) throw error;

      res.status(201).json(data);
   } catch (err) {
      console.error("Add comment error:", err);
      res.status(500).json({ message: "Failed to add comment." });
   }
});

router.get("/:id/comments", async (req, res) => {
   const id = Number(req.params.id);

   try {
      const { data, error } = await supabase.from("event_comments").select("*").eq("event_id", id).order("created_at");

      if (error) throw error;
      res.json(data || []);
   } catch (err) {
      console.error("Get comments error:", err);
      res.status(500).json({ message: "Failed to get comments." });
   }
});

module.exports = router;
