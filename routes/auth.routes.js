const express = require('express');
const router = express.Router();
const { supabase } = require('../db/supabaseClient');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');

/**
 * POST /auth/signup
 * Body: { name, email, password, country?, city? }
 * Mô phỏng: tạo user trong bảng users (chưa có mã hoá password thực)
 */
router.post('/signup', async (req, res) => {
  const { name, email, password, country, city, username: customUsername, gender } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Missing email or password' });

  try {
    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    // Kiểm tra email tồn tại
    const { data: exists, error: existsErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .limit(1);

    if (existsErr) throw existsErr;
    if (exists && exists.length > 0) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Tạo id (nếu bạn đang tham chiếu auth.users thì phần này phải đổi sang id từ Supabase Auth)
    const id = randomUUID();
    const username = customUsername || (email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') + '_' + Math.floor(Math.random() * 1000));

    const { data: inserted, error: insErr } = await supabase
      .from('users')
      .insert([{
        id,
        email,
        username,
        name: name || username,
        country: country || null,
        city: city || null,
        gender: gender || null,
        password_hash: passwordHash,
        email_confirmed: false
      }])
      .select('*')
      .single();

    if (insErr) throw insErr;

    // Create default hangout status for new user (visible by default)
    try {
      await supabase
        .from('user_hangout_status')
        .insert([{
          username: inserted.username,
          is_available: true, // Auto-enable visibility for new users
          current_activity: null,
          activities: []
        }]);
      console.log(`✅ Created default hangout status for ${inserted.username}`);
    } catch (hangoutErr) {
      // Non-critical - log but don't fail signup
      console.error('Warning: Could not create hangout status:', hangoutErr);
    }

    // Remove password_hash from response
    delete inserted.password_hash;

    // Giả token (production: dùng JWT thực hoặc Supabase Auth)
    const fakeToken = Buffer.from(`${id}:${Date.now()}`).toString('base64');

    res.json({
      user: inserted,
      token: fakeToken
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ message: 'Server error during signup' });
  }
});

/**
 * POST /auth/login
 * Body: { email, password }
 * Validates password hash and returns user + token
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Missing email or password' });

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .limit(1)
      .single();

    if (error) {
      if (String(error.message).toLowerCase().includes('row')) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
      throw error;
    }

    // Check if user has password_hash (for users created before this update)
    if (!user.password_hash) {
      return res.status(401).json({ message: 'Invalid credentials. Please reset your password.' });
    }

    // Validate password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Remove password_hash from response
    delete user.password_hash;

    // Giả token
    const fakeToken = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');

    res.json({
      user,
      token: fakeToken
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error during login' });
  }
});

/**
 * POST /auth/logout
 * Không làm gì đặc biệt (client tự xóa token)
 */
router.post('/logout', (_req, res) => {
  res.json({ message: 'Logged out' });
});

module.exports = router;