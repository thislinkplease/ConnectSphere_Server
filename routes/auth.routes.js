const express = require('express');
const router = express.Router();
const { supabase } = require('../db/supabaseClient');
const { randomUUID } = require('crypto');

/**
 * POST /auth/signup
 * Body: { name, email, password, country?, city? }
 * Mô phỏng: tạo user trong bảng users (chưa có mã hoá password thực)
 */
router.post('/signup', async (req, res) => {
  const { name, email, password, country, city } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Missing email or password' });

  try {
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

    // Tạo id (nếu bạn đang tham chiếu auth.users thì phần này phải đổi sang id từ Supabase Auth)
    const id = randomUUID();
    const username = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') + '_' + Math.floor(Math.random() * 1000);

    const { data: inserted, error: insErr } = await supabase
      .from('users')
      .insert([{
        id,
        email,
        username,
        name: name || username,
        country: country || null,
        city: city || null,
        email_confirmed: false
      }])
      .select('*')
      .single();

    if (insErr) throw insErr;

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
 * Giả lập: tìm user theo email và trả token giả
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