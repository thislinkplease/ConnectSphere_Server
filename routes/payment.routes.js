const express = require("express");
const router = express.Router();
const { supabase } = require("../db/supabaseClient");

// Initialize Stripe with secret key from environment
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || "");

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

/* --------------------------- Stripe Payment Intent ---------------------------- */

/**
 * Create a Stripe payment intent
 * POST /payments/create-payment-intent
 * Body: { username, amount?: number }
 */
router.post("/create-payment-intent", async (req, res) => {
  const { username, amount = 1 } = req.body;

  if (!username) {
    return res.status(400).json({ message: "Missing username." });
  }

  try {
    // Verify user exists
    const user = await getUserByUsername(username);
    if (!user) return res.status(404).json({ message: "User not found." });

    // Stripe requires amounts in cents, minimum is $0.50 (50 cents)
    // We'll use 1 cent ($0.01) as the test price
    const amountInCents = Math.max(1, Math.floor(amount * 100));

    // Create a payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "usd",
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        username,
        plan_type: "pro",
        test_mode: "true",
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("create payment intent error:", err);
    res.status(500).json({ 
      message: "Server error while creating payment intent.",
      error: err.message 
    });
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
 * Body: { username, plan_type: 'pro', payment_method: 'test' | 'stripe', payment_intent_id?: string }
 */
router.post("/subscribe", async (req, res) => {
  const { username, plan_type, payment_method = "test", payment_intent_id } = req.body;

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

    // For Stripe payments, verify the payment intent was successful
    if (payment_method === "stripe") {
      if (!payment_intent_id) {
        return res.status(400).json({ message: "Missing payment_intent_id for Stripe payment." });
      }

      try {
        // Retrieve the payment intent from Stripe to verify it succeeded
        const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
        
        if (paymentIntent.status !== "succeeded") {
          return res.status(400).json({ 
            message: "Payment not completed. Please complete the payment first.",
            status: paymentIntent.status 
          });
        }

        // Verify the payment intent hasn't been used before
        const { data: existingTx, error: txCheckErr } = await supabase
          .from("payment_transactions")
          .select("*")
          .eq("payment_intent_id", payment_intent_id)
          .maybeSingle();

        if (txCheckErr) throw txCheckErr;

        if (existingTx) {
          return res.status(400).json({ message: "This payment has already been used." });
        }
      } catch (stripeErr) {
        console.error("Stripe verification error:", stripeErr);
        return res.status(400).json({ 
          message: "Failed to verify payment with Stripe.",
          error: stripeErr.message 
        });
      }
    }

    // Calculate subscription period (1 month from now)
    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    // Determine amount and currency based on payment method
    const amount = payment_method === "stripe" ? 0.01 : 50000;
    const currency = payment_method === "stripe" ? "USD" : "VND";

    // Create payment transaction
    const transactionData = {
      username,
      amount,
      currency,
      plan_type: "pro",
      status: "completed",
      payment_method,
      transaction_date: startDate.toISOString(),
    };

    // Add payment_intent_id if it's a Stripe payment
    if (payment_method === "stripe" && payment_intent_id) {
      transactionData.payment_intent_id = payment_intent_id;
    }

    const { data: transaction, error: txErr } = await supabase
      .from("payment_transactions")
      .insert([transactionData])
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
