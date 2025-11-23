const { supabase } = require('../db/supabaseClient');

/**
 * Middleware to verify Supabase Auth token
 */
async function requireAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ message: 'Missing authorization header' });
        }

        const token = authHeader.replace('Bearer ', '');

        // Verify token with Supabase
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            console.error('Auth error:', error?.message);
            return res.status(401).json({ message: 'Invalid or expired token' });
        }

        // Attach user to request
        // We might want to fetch the full profile from 'users' table too?
        // For now, let's just attach the auth user and maybe the public user if needed.
        // But existing code expects req.user to have username, etc.
        // So we MUST fetch the public user profile.

        const { data: publicUser, error: publicError } = await supabase
            .from('users')
            .select('*')
            .eq('id', user.id)
            .single();

        if (publicError || !publicUser) {
            // Fallback if user is in Auth but not in public table (shouldn't happen if synced)
            // Or maybe we just use the metadata?
            // But existing code relies on 'username' which is in public table.
            return res.status(401).json({ message: 'User profile not found' });
        }

        req.user = publicUser;
        req.auth = user; // Supabase auth user
        next();
    } catch (err) {
        console.error('Auth middleware error:', err);
        res.status(500).json({ message: 'Server error during authentication' });
    }
}

/**
 * Middleware to optionally verify Supabase Auth token
 * If valid token, populates req.user
 * If no token or invalid, req.user is null
 */
async function optionalAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            req.user = null;
            return next();
        }

        const token = authHeader.replace('Bearer ', '');

        // Verify token with Supabase
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            req.user = null;
            return next();
        }

        const { data: publicUser, error: publicError } = await supabase
            .from('users')
            .select('*')
            .eq('id', user.id)
            .single();

        if (publicError || !publicUser) {
            req.user = null;
            return next();
        }

        req.user = publicUser;
        req.auth = user;
        next();
    } catch (err) {
        console.error('Optional auth middleware error:', err);
        req.user = null;
        next();
    }
}

module.exports = { requireAuth, optionalAuth };
