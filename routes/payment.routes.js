const express = require("express");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");

/* ---------------------------------- Helpers ---------------------------------- */

async function getUserByUsername(username) {
  const { data, error } = await supabase.from("users").select("*").eq("username", username).single();
  if (error) throw error;
  return data || null;
}

/* -------------------------------- Payment Plans ------------------------------- */

/**
 * Get available payment plans
 * GET /payments/plans
 */
router.get("/plans", async (req, res) => {
  try {
    const plans = [
      {
        id: "free",
        name: "Free Plan",
        price: 0,
        currency: "VND",
        features: [
          "16 friends limit",
          "Basic messaging",
          "Standard theme (Blue)",
          "Event participation",
          "Community access",
        ],
        max_friends: 16,
        theme: "blue",
        ai_enabled: false,
      },
      {
        id: "pro",
        name: "Pro Plan",
        price: 50000, // 50,000 VND per month (test price)
        currency: "VND",
        duration: "monthly",
        features: [
          "512 friends limit",
          "Premium messaging",
          "Premium theme (Yellow)",
          "AI post writing assistant (coming soon)",
          "Priority event access",
          "Ad-free experience",
        ],
        max_friends: 512,
        theme: "yellow",
        ai_enabled: true,
      },
    ];

    res.json({ plans });
  } catch (err) {
    console.error("get plans error:", err);
    res.status(500).json({ message: "Server error while fetching payment plans." });
  }
});

/* ------------------------------- Subscriptions -------------------------------- */

/**
 * Get user's current subscription
 * GET /payments/subscription?username=johndoe
 */
router.get("/subscription", async (req, res) => {
  const username = (req.query.username || "").trim();
  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { data: subscription, error } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("username", username)
      .maybeSingle();

    if (error) throw error;

    // If no subscription exists, create a free one
    if (!subscription) {
      const { data: newSub, error: createErr } = await supabase
        .from("user_subscriptions")
        .insert([
          {
            username,
            plan_type: "free",
            status: "active",
            start_date: new Date().toISOString(),
            end_date: null,
          },
        ])
        .select("*")
        .single();

      if (createErr) throw createErr;
      return res.json(newSub);
    }

    // Check if subscription has expired
    if (subscription.end_date && new Date(subscription.end_date) < new Date()) {
      // Downgrade to free
      const { data: updated, error: updateErr } = await supabase
        .from("user_subscriptions")
        .update({
          plan_type: "free",
          status: "expired",
        })
        .eq("username", username)
        .select("*")
        .single();

      if (updateErr) throw updateErr;

      // Update user's premium status and max_friends
      await supabase
        .from("users")
        .update({
          is_premium: false,
          max_friends: 16,
          theme_preference: "blue",
        })
        .eq("username", username);

      return res.json(updated);
    }

    res.json(subscription);
  } catch (err) {
    console.error("get subscription error:", err);
    res.status(500).json({ message: "Server error while fetching subscription." });
  }
});

/**
 * Subscribe to Pro plan (Test Payment)
 * POST /payments/subscribe
 * Body: { username, plan_type: 'pro', payment_method: 'test' }
 */
router.post("/subscribe", async (req, res) => {
  const { username, plan_type, payment_method = "test" } = req.body;

  if (!username || !plan_type) {
    return res.status(400).json({ message: "Missing username or plan_type." });
  }

  if (plan_type !== "pro") {
    return res.status(400).json({ message: "Only Pro plan can be subscribed to." });
  }

  try {
    // Verify user exists
    const user = await getUserByUsername(username);
    if (!user) return res.status(404).json({ message: "User not found." });

    // Calculate subscription period (1 month from now)
    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    // Create payment transaction
    const { data: transaction, error: txErr } = await supabase
      .from("payment_transactions")
      .insert([
        {
          username,
          amount: 50000, // 50,000 VND
          currency: "VND",
          plan_type: "pro",
          status: "completed", // Auto-complete for test payments
          payment_method,
          transaction_date: startDate.toISOString(),
        },
      ])
      .select("*")
      .single();

    if (txErr) throw txErr;

    // Update or create subscription
    const { data: subscription, error: subErr } = await supabase
      .from("user_subscriptions")
      .upsert(
        [
          {
            username,
            plan_type: "pro",
            status: "active",
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
          },
        ],
        { onConflict: "username" }
      )
      .select("*")
      .single();

    if (subErr) throw subErr;

    // Update user's premium status, max_friends, and theme
    const { error: userErr } = await supabase
      .from("users")
      .update({
        is_premium: true,
        max_friends: 512,
        theme_preference: "yellow",
      })
      .eq("username", username);

    if (userErr) throw userErr;

    res.json({
      subscription,
      transaction,
      message: "Successfully subscribed to Pro plan!",
    });
  } catch (err) {
    console.error("subscribe error:", err);
    res.status(500).json({ message: "Server error while processing subscription." });
  }
});

/**
 * Cancel subscription (downgrade to free)
 * POST /payments/cancel
 * Body: { username }
 */
router.post("/cancel", async (req, res) => {
  const { username } = req.body;

  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    // Update subscription to cancelled
    const { data: subscription, error: subErr } = await supabase
      .from("user_subscriptions")
      .update({
        plan_type: "free",
        status: "cancelled",
        end_date: new Date().toISOString(),
      })
      .eq("username", username)
      .select("*")
      .single();

    if (subErr) throw subErr;

    // Update user's premium status and max_friends
    const { error: userErr } = await supabase
      .from("users")
      .update({
        is_premium: false,
        max_friends: 16,
        theme_preference: "blue",
      })
      .eq("username", username);

    if (userErr) throw userErr;

    res.json({
      subscription,
      message: "Subscription cancelled. Downgraded to Free plan.",
    });
  } catch (err) {
    console.error("cancel subscription error:", err);
    res.status(500).json({ message: "Server error while cancelling subscription." });
  }
});

/* ---------------------------- Payment History --------------------------------- */

/**
 * Get payment transaction history
 * GET /payments/history?username=johndoe
 */
router.get("/history", async (req, res) => {
  const username = (req.query.username || "").trim();
  if (!username) return res.status(400).json({ message: "Missing username." });

  try {
    const { data: transactions, error } = await supabase
      .from("payment_transactions")
      .select("*")
      .eq("username", username)
      .order("transaction_date", { ascending: false });

    if (error) throw error;
    res.json(transactions || []);
  } catch (err) {
    console.error("get payment history error:", err);
    res.status(500).json({ message: "Server error while fetching payment history." });
  }
});

module.exports = router;
