# Backend Authentication — MERN Password Manager

> **Stack:** Node.js · Express · MongoDB · better-auth  
> **Auth strategy:** Email/password with better-auth handling sessions, tokens, and user lifecycle  
> **Security model:** Zero-knowledge — server never sees plaintext passwords or vault encryption keys

---

## Table of Contents

1. [Dependencies](#dependencies)
2. [Folder & File Structure](#folder--file-structure)
3. [Environment Variables](#environment-variables)
4. [File-by-File Breakdown](#file-by-file-breakdown)
5. [How It All Connects](#how-it-all-connects)
6. [Auth Endpoints Reference](#auth-endpoints-reference)
7. [Setup Instructions](#setup-instructions)

---

## Dependencies

```bash
npm install better-auth mongodb mongoose express cors helmet express-rate-limit dotenv argon2
npm install -D nodemon
```

| Package | Purpose |
|---|---|
| `better-auth` | Handles the entire auth lifecycle — registration, login, sessions, token rotation |
| `mongodb` | Native MongoDB driver — required by better-auth's MongoDB adapter |
| `mongoose` | ODM for your own vault/user extension models |
| `express` | HTTP server framework |
| `cors` | Restricts which origins can call the API |
| `helmet` | Sets secure HTTP headers automatically |
| `express-rate-limit` | Rate limits the auth endpoints to block brute-force attacks |
| `dotenv` | Loads environment variables from `.env` |
| `argon2` | Used for hashing the master password hash stored on the user document (separate from better-auth's own password hashing) |

> **Note:** `better-auth` handles its own password hashing internally using Argon2 by default. You do not need to manually call Argon2 for login/register — better-auth does this for you.

---

## Folder & File Structure

```
server/
├── src/
│   ├── index.js                  ← Entry point — starts the Express server
│   ├── app.js                    ← Express app setup — middleware, routes, error handling
│   │
│   ├── config/
│   │   ├── db.js                 ← MongoDB native client (for better-auth adapter)
│   │   ├── mongoose.js           ← Mongoose connection (for your vault models)
│   │   └── auth.js               ← better-auth instance configuration
│   │
│   ├── middleware/
│   │   ├── requireSession.js     ← Protects routes — verifies active better-auth session
│   │   └── rateLimiter.js        ← Rate limiting rules for sensitive endpoints
│   │
│   ├── models/
│   │   └── VaultEntry.js         ← Mongoose schema for encrypted vault entries
│   │
│   ├── routes/
│   │   └── vault.js              ← Vault CRUD routes (protected — requires session)
│   │
│   └── controllers/
│       └── vaultController.js    ← Business logic for vault operations
│
├── .env                          ← Secret keys and config (never commit this)
├── .env.example                  ← Safe template users copy to create their .env
├── .gitignore
├── package.json
└── Dockerfile                    ← Container definition for self-hosting
```

---

## Environment Variables

### `.env.example`

```bash
# ─── App ───────────────────────────────────────────
PORT=3000
NODE_ENV=production

# ─── MongoDB ────────────────────────────────────────
# For self-hosted Docker, the hostname is the Docker service name
MONGO_URI=mongodb://admin:yourpassword@mongo:27017/vault?authSource=admin

# ─── Better Auth ────────────────────────────────────
# Generate with: openssl rand -base64 32
BETTER_AUTH_SECRET=replace_with_a_random_32_char_string_minimum
BETTER_AUTH_URL=http://localhost:3000

# ─── CORS ───────────────────────────────────────────
# The URL of your React frontend
CLIENT_URL=http://localhost:5173
```

> Copy this to `.env` and fill in real values before running the server.

---

## File-by-File Breakdown

---

### `src/index.js` — Entry Point

This is the file Node.js runs first. Its only job is to import the configured Express app and start listening on the port defined in `.env`. Keeping this file minimal means the app logic lives in `app.js`, which makes testing easier because you can import `app.js` without binding to a port.

```js
import 'dotenv/config';
import app from './app.js';
import { connectMongoose } from './config/mongoose.js';

const PORT = process.env.PORT || 3000;

// Connect Mongoose (your vault models) then start the server
connectMongoose().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
```

---

### `src/app.js` — Express Application

This is the core of the server. It wires together every piece: middleware, the better-auth handler, and your protected API routes. The order of middleware registration matters — CORS and Helmet run first on every request, better-auth mounts its own handler before `express.json()` (required by better-auth), and then your own routes come last.

```js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './config/auth.js';
import { authRateLimiter } from './middleware/rateLimiter.js';
import vaultRoutes from './routes/vault.js';

const app = express();

// ── Security headers ─────────────────────────────────────────────────────────
// Helmet sets X-Frame-Options, Content-Security-Policy, and 14 other headers
// automatically. Always run this before everything else.
app.use(helmet());

// ── CORS ─────────────────────────────────────────────────────────────────────
// Restrict requests to your React frontend only.
// credentials: true is required because better-auth uses cookies for sessions.
app.use(cors({
  origin: process.env.CLIENT_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));

// ── Better Auth handler ───────────────────────────────────────────────────────
// IMPORTANT: This MUST be mounted before express.json().
// better-auth parses its own request bodies. If express.json() runs first,
// it consumes the body stream and better-auth breaks.
//
// This single line gives you: register, login, logout, session refresh,
// password reset, email verification — all handled by better-auth automatically.
//
// All these routes live under /api/auth/* — e.g.:
//   POST /api/auth/sign-up/email
//   POST /api/auth/sign-in/email
//   POST /api/auth/sign-out
//   GET  /api/auth/get-session
app.all('/api/auth/*', authRateLimiter, toNodeHandler(auth));

// ── Body parsing ──────────────────────────────────────────────────────────────
// Only runs for your own routes — not the better-auth routes above.
app.use(express.json());

// ── Your API routes ───────────────────────────────────────────────────────────
app.use('/api/vault', vaultRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── Global error handler ─────────────────────────────────────────────────────
// Catches any error thrown by a route and returns a clean JSON response.
// Never exposes stack traces in production.
app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

export default app;
```

---

### `src/config/db.js` — Native MongoDB Client (for better-auth)

better-auth's MongoDB adapter needs a **native `MongoClient`** instance, not a Mongoose connection. These are two different things. Mongoose wraps the native driver for you, but better-auth needs the raw client so it can manage its own collections (`user`, `session`, `account`, `verification`) independently from your app's collections.

```js
import { MongoClient } from 'mongodb';

// This client is used exclusively by better-auth.
// Your vault models use Mongoose (see config/mongoose.js).
const client = new MongoClient(process.env.MONGO_URI);

// Export the connected client and point better-auth at the 'vault' database.
// better-auth will create its own collections here automatically.
export const mongoClient = client;
export const db = client.db('vault');
```

> **Why separate from Mongoose?** better-auth manages its own schema. Mixing it into Mongoose would require you to manually maintain better-auth's internal models every time you upgrade the package. Keeping them separate means upgrades just work.

---

### `src/config/mongoose.js` — Mongoose Connection (for your models)

This handles the Mongoose connection that your vault models (`VaultEntry.js`, etc.) use. Mongoose provides the nice schema/model API, validation, and middleware that makes working with your own data easier.

```js
import mongoose from 'mongoose';

export const connectMongoose = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Mongoose connected to MongoDB');
  } catch (err) {
    console.error('Mongoose connection error:', err);
    process.exit(1); // Kill the server — no point running without a database
  }
};
```

---

### `src/config/auth.js` — better-auth Instance

This is the most important configuration file. It creates the `auth` object that powers everything authentication-related. Every option — the database adapter, email/password settings, session lifetime, security plugins — is configured here in one place. This makes the auth system easy to audit, update, and reason about.

```js
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { db } from './db.js';

export const auth = betterAuth({
  // ── Database ──────────────────────────────────────────────────────────────
  // Tells better-auth to use MongoDB via the native driver.
  // better-auth will auto-create these collections: user, session, account, verification
  database: mongodbAdapter(db),

  // ── Base URL ──────────────────────────────────────────────────────────────
  // Used for generating email verification and password reset links.
  // Must match BETTER_AUTH_URL in your .env exactly.
  baseURL: process.env.BETTER_AUTH_URL,

  // ── Email & Password ──────────────────────────────────────────────────────
  emailAndPassword: {
    enabled: true,

    // Enforce minimum password strength.
    // This is for the account password, NOT the vault master password.
    // The master password is handled entirely client-side.
    minPasswordLength: 12,

    // When true, better-auth sends a verification email on sign-up.
    // Set to false for local/self-hosted setups without email config.
    requireEmailVerification: false,
  },

  // ── Session ───────────────────────────────────────────────────────────────
  session: {
    // How long the session token stays valid.
    // 7 days is a good balance for a password manager.
    expiresIn: 60 * 60 * 24 * 7,

    // If the user is active, extend the session automatically.
    // This means active users never get logged out unexpectedly.
    updateAge: 60 * 60 * 24,

    // Store session data in a cookie — secure, httpOnly, sameSite: lax
    // better-auth handles all cookie settings correctly by default.
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // Cache session in cookie for 5 minutes to reduce DB reads
    },
  },

  // ── Rate Limiting ─────────────────────────────────────────────────────────
  // better-auth has a built-in rate limiter for auth routes.
  // This works alongside your express-rate-limit middleware for extra protection.
  rateLimit: {
    enabled: true,
    window: 60,   // 60-second window
    max: 10,      // Max 10 auth requests per window
  },

  // ── Advanced Security ─────────────────────────────────────────────────────
  advanced: {
    // Use secure cookies in production (requires HTTPS).
    // In development this is set to false automatically.
    useSecureCookies: process.env.NODE_ENV === 'production',

    // Prevents session fixation attacks by generating a new session
    // ID on every login.
    generateId: () => crypto.randomUUID(),
  },
});
```

---

### `src/middleware/requireSession.js` — Route Protection Middleware

This middleware is what turns an unprotected Express route into a session-protected one. Every vault route runs through this before the controller. It uses better-auth's `getSession` API to verify the session cookie in the incoming request. If the session is missing or expired, it returns a 401 immediately — the controller code never runs.

This is the key integration point between better-auth and your own routes. better-auth handles auth — your middleware uses its result to gate access.

```js
import { auth } from '../config/auth.js';
import { fromNodeHeaders } from 'better-auth/node';

export const requireSession = async (req, res, next) => {
  try {
    // fromNodeHeaders converts Node's IncomingHttpHeaders to
    // the standard Web API Headers object that better-auth expects.
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized — no active session' });
    }

    // Attach the session and user to the request object so controllers
    // can access the authenticated user without calling getSession again.
    req.session = session.session;
    req.user = session.user;

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized — session invalid' });
  }
};
```

---

### `src/middleware/rateLimiter.js` — Rate Limiting

Rate limiting is critical for a password manager. Without it an attacker can attempt thousands of passwords against an account per minute. This file defines the limiter for auth endpoints specifically. The limiter in `app.js` applies it to all `/api/auth/*` routes before better-auth's own built-in limiter — giving you two independent layers of protection.

```js
import rateLimit from 'express-rate-limit';

// Applied to all /api/auth/* routes
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // Max 20 requests per 15 minutes per IP
  standardHeaders: true,     // Returns RateLimit-* headers so clients know their limit
  legacyHeaders: false,
  message: {
    error: 'Too many requests — please try again later',
  },
  // Skip rate limiting for health checks
  skip: (req) => req.path === '/api/health',
});

// Stricter limiter for sign-in specifically — brute force protection
export const signInRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,  // Only 5 sign-in attempts per 15 minutes per IP
  message: {
    error: 'Too many login attempts — please wait 15 minutes',
  },
});
```

---

### `src/models/VaultEntry.js` — Vault Entry Schema

This Mongoose model defines the shape of an encrypted password entry. Notice that no field here stores a real password. `encryptedData` is an opaque blob that only the client can decrypt. The server is literally storing structured garbage from a security perspective — which is exactly the goal.

```js
import mongoose from 'mongoose';

const vaultEntrySchema = new mongoose.Schema(
  {
    // Links the entry to the authenticated user from better-auth's user collection.
    // This is the userId from req.user — always enforce this in every query.
    userId: {
      type: String,
      required: true,
      index: true,  // Index this for fast per-user queries
    },

    // Plaintext metadata — safe to store unencrypted since it's not sensitive.
    // Allows users to search/filter entries without decrypting everything.
    siteName: {
      type: String,
      required: true,
      trim: true,
    },

    siteUrl: {
      type: String,
      trim: true,
    },

    // The AES-256-GCM encrypted blob — produced client-side before sending.
    // Contains: encrypted username, encrypted password, encrypted notes.
    // The server never decrypts this. Ever.
    encryptedData: {
      type: String,
      required: true,
    },

    // Initialization Vector — unique per entry, required for AES-GCM decryption.
    // Not secret — safe to store plaintext alongside the ciphertext.
    iv: {
      type: String,
      required: true,
    },

    // GCM Authentication Tag — proves the ciphertext hasn't been tampered with.
    // Also not secret — required for decryption integrity check.
    authTag: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// Compound index: fast queries for "all entries belonging to user X"
vaultEntrySchema.index({ userId: 1, createdAt: -1 });

export const VaultEntry = mongoose.model('VaultEntry', vaultEntrySchema);
```

---

### `src/routes/vault.js` — Vault Routes

This file defines the URL structure of the vault API. Every route here runs `requireSession` first — nothing gets through without a valid better-auth session. The routes themselves are thin: they just hand off to the controller for actual logic. This separation makes the code easy to test and maintain.

```js
import { Router } from 'express';
import { requireSession } from '../middleware/requireSession.js';
import {
  getVaultEntries,
  createVaultEntry,
  updateVaultEntry,
  deleteVaultEntry,
} from '../controllers/vaultController.js';

const router = Router();

// All vault routes require an authenticated session
router.use(requireSession);

// GET  /api/vault        → list all entries for the authenticated user
// POST /api/vault        → create a new encrypted entry
router.route('/')
  .get(getVaultEntries)
  .post(createVaultEntry);

// PUT    /api/vault/:id  → update a specific entry (only if owned by user)
// DELETE /api/vault/:id  → delete a specific entry (only if owned by user)
router.route('/:id')
  .put(updateVaultEntry)
  .delete(deleteVaultEntry);

export default router;
```

---

### `src/controllers/vaultController.js` — Vault Controller

This file contains the business logic for every vault operation. Two things every function here enforces:

1. **Always scope queries to `req.user.id`** — so a user can never read or modify another user's entries, even if they guess a valid MongoDB ObjectId.
2. **Never decrypt** — the controller works only with the encrypted blobs it receives and stores.

```js
import { VaultEntry } from '../models/VaultEntry.js';

// GET /api/vault
// Returns all vault entries belonging to the authenticated user.
// Returns only ciphertext — no decryption happens here.
export const getVaultEntries = async (req, res, next) => {
  try {
    const entries = await VaultEntry
      .find({ userId: req.user.id })
      .select('-__v')
      .sort({ createdAt: -1 });

    res.json({ entries });
  } catch (err) {
    next(err);
  }
};

// POST /api/vault
// Stores a new encrypted vault entry.
// The client has already encrypted the password before sending.
// Body: { siteName, siteUrl, encryptedData, iv, authTag }
export const createVaultEntry = async (req, res, next) => {
  try {
    const { siteName, siteUrl, encryptedData, iv, authTag } = req.body;

    if (!siteName || !encryptedData || !iv || !authTag) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const entry = await VaultEntry.create({
      userId: req.user.id,  // Always set from session — never trust client for this
      siteName,
      siteUrl,
      encryptedData,
      iv,
      authTag,
    });

    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
};

// PUT /api/vault/:id
// Updates an existing entry — only if it belongs to the authenticated user.
// The { userId: req.user.id } filter is the ownership check —
// if the entry exists but belongs to someone else, findOneAndUpdate returns null.
export const updateVaultEntry = async (req, res, next) => {
  try {
    const { siteName, siteUrl, encryptedData, iv, authTag } = req.body;

    const entry = await VaultEntry.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },  // ← ownership enforced here
      { siteName, siteUrl, encryptedData, iv, authTag },
      { new: true, runValidators: true }
    );

    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json({ entry });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/vault/:id
// Deletes an entry — only if it belongs to the authenticated user.
export const deleteVaultEntry = async (req, res, next) => {
  try {
    const entry = await VaultEntry.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id,  // ← ownership enforced here too
    });

    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json({ message: 'Entry deleted' });
  } catch (err) {
    next(err);
  }
};
```

---

### `Dockerfile` — Container Definition

Defines how the server is packaged for self-hosting via Docker Compose. Uses a multi-stage build: the first stage installs dependencies, the second stage copies only the production artifacts — keeping the final image small and free of dev tools.

```dockerfile
# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: Production image ──────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
```

---

### `.env.example` — Safe Template for Users

```bash
# Copy this file to .env and fill in your values.
# NEVER commit .env to git.

PORT=3000
NODE_ENV=production
MONGO_URI=mongodb://admin:yourpassword@mongo:27017/vault?authSource=admin
BETTER_AUTH_SECRET=generate_with_openssl_rand_base64_32
BETTER_AUTH_URL=http://localhost:3000
CLIENT_URL=http://localhost:5173
```

---

## How It All Connects

```
React Client
│
│  1. POST /api/auth/sign-up/email  → better-auth registers user, hashes password
│  2. POST /api/auth/sign-in/email  → better-auth verifies, sets session cookie
│  3. Client derives encryption key from master password (Web Crypto — never sent)
│  4. Client encrypts password entry → sends only ciphertext
│  5. POST /api/vault              → requireSession checks cookie → controller stores blob
│  6. GET  /api/vault              → requireSession checks cookie → controller returns blobs
│  7. Client decrypts blobs locally with derived key
│
Express Server
│
├── Helmet (secure headers)
├── CORS (allow only your React app)
├── Rate Limiter (20 req / 15min on /api/auth/*)
├── better-auth handler (/api/auth/*)   ← manages users, sessions, cookies
├── express.json()
└── /api/vault (protected by requireSession)
    └── VaultController → VaultEntry (Mongoose)
                                │
                        MongoDB
                        ├── user          ← managed by better-auth
                        ├── session       ← managed by better-auth
                        ├── account       ← managed by better-auth
                        └── vaultentries  ← managed by your Mongoose model
```

---

## Auth Endpoints Reference

These endpoints are automatically created by better-auth — you write zero code for them.

| Method | Endpoint | What it does |
|---|---|---|
| `POST` | `/api/auth/sign-up/email` | Register a new user |
| `POST` | `/api/auth/sign-in/email` | Login — sets session cookie |
| `POST` | `/api/auth/sign-out` | Logout — destroys session |
| `GET` | `/api/auth/get-session` | Returns current session info |
| `POST` | `/api/auth/change-password` | Changes account password |
| `GET` | `/api/auth/ok` | Health check for better-auth |

**Register body:**
```json
{
  "email": "user@example.com",
  "password": "strongpassword123",
  "name": "Oshen"
}
```

**Login body:**
```json
{
  "email": "user@example.com",
  "password": "strongpassword123"
}
```

Sessions are stored in an `httpOnly` cookie automatically. No token management code needed.

---

## Setup Instructions

```bash
# 1. Clone the repo
git clone https://github.com/you/vault-server
cd vault-server

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
# Edit .env with your values
# Generate secret: openssl rand -base64 32

# 4. Start development server
npm run dev

# 5. Verify better-auth is running
curl http://localhost:3000/api/auth/ok
# → { "ok": true }

# 6. For Docker (self-hosting)
docker-compose up -d
```

---

## Security Checklist

- [x] Passwords hashed by better-auth (Argon2id internally)
- [x] Sessions stored in `httpOnly` cookies — not localStorage
- [x] All vault queries scoped to `req.user.id` — no IDOR possible
- [x] Rate limiting on auth endpoints — brute force protection
- [x] MongoDB not exposed to host network in Docker
- [x] `helmet` sets all security headers
- [x] CORS restricted to your frontend origin only
- [x] `.env` never committed to git
- [x] Non-root user in Docker container
- [x] Server never decrypts vault entries — zero-knowledge maintained

---

*This document covers the authentication layer only. The client-side encryption module (Web Crypto API, key derivation, AES-256-GCM) is documented separately.*