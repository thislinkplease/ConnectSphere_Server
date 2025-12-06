# Connect Sphere — Backend (Server)

The backend of Connect Sphere is built using Node.js, Express and Supabase.
It serves as the core API layer handling authentication, user data, communities, posts, chat, events, hangouts, media uploads and real-time style interactions.

The backend communicates with Supabase (PostgreSQL + Storage) and provides REST APIs for the mobile client.

---

## 1. Tech Stack

- Node.js (Express)

- Supabase (PostgreSQL, Storage, Auth)

- Multer (file uploads)

- JSON Web Tokens

- Stripe (for subscription payments)

- CORS / Middleware

- RESTful API architecture

---

## 2. Setup & Installation
**Requirements**

- Node.js 18 or higher

- npm or yarn

- A Supabase project

- Stripe test account (optional for payments)

**Clone the project**
```bash
git clone https://github.com/thislinkplease/ConnectSphere_Server.git
cd .\ConnectSphere-Server\
```

**Install dependencies**
`npm install`

---

## 3. Environment Variables

Create a .env file in the backend/ directory.
Below is the full template needed for the backend to run:
```bash
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...

CORS_ORIGIN=http://localhost:3000,http://localhost:19006

POSTS_BUCKET=posts
AVATARS_BUCKET=avatars
MESSAGES_BUCKET=messages
CHAT_IMAGE_BUCKET=chat-image
COMMUNITY_BUCKET=community

# Stripe keys for test mode
# Get keys from: https://dashboard.stripe.com/test/apikeys
STRIPE_SECRET_KEY=sk_test....
```

Make sure all keys match your Supabase project configuration.
Missing any required variable will cause the backend to fail during startup.

---

## 4. Running the Server

To start the backend in development mode:

`npm run dev`


Or start normally:

`npm start`


The server typically runs on:

`http://localhost:3000`