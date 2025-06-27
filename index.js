require('dotenv').config();
const express = require('express');
const { QuickDB } = require('quick.db');
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const activitypub = require('activitypub-express');
const sanitizeHtml = require('sanitize-html');
const QuickDBStore = require('./store');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');

const upload = multer({ dest: 'uploads/' });

const app = express();
const port = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || 'localhost';

// -- Database --
const db = new QuickDB({ filePath: process.env.DATABASE_PATH || 'mayaspace.sqlite' });
const apexStore = new QuickDBStore();

// -- App Settings --
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    store: new SQLiteStore({ db: process.env.SESSIONS_DATABASE_PATH || 'sessions.sqlite', concurrentDB: true }),
    secret: process.env.SESSION_SECRET || 'a very secret key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));

// -- ActivityPub --
const apex = activitypub({
    name: 'MayaSpace',
    version: '1.0.0',
    domain: DOMAIN,
    actorParam: 'username',
    objectParam: 'id',
    activityParam: 'id',
    store: apexStore,
    endpoints: {
        proxyUrl: `https://${DOMAIN}/proxy`,
    },
    routes: {
        actor: '/u/:username',
        object: '/o/:id',
        activity: '/s/:id',
        inbox: '/u/:username/inbox',
        outbox: '/u/:username/outbox',
        followers: '/u/:username/followers',
        following: '/u/:username/following',
        liked: '/u/:username/liked',
        collections: '/u/:username/c/:id',
        blocked: '/u/:username/blocked',
        rejections: '/u/:username/rejections',
        rejected: '/u/:username/rejected',
        shares: '/s/:id/shares',
        likes: '/s/:id/likes'
    }
});

app.use((req, res, next) => {
    res.locals.sessionUser = req.session.user;
    res.locals.apex = apex;
    res.locals.DOMAIN = DOMAIN;
    next();
});

// Mount ActivityPub routes
app.use(
  '/',
  (req, res, next) => {
    if (req.session.user) {
      res.locals.apex.actor = req.session.user;
    }
    next();
  },
  apex
);

// -- Routes --
app.get('/', async (req, res) => {
    const posts = await db.get('posts') || [];
    res.render('home', { 
        title: 'Welcome to MayaSpace',
        posts: posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    });
});

app.post('/new-post', upload.single('media'), async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  const { content } = req.body;
  if (!content) {
    return res.status(400).send('Content is required');
  }

  let mediaPath = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const tempPath = req.file.path;
    
    // Ensure uploads directory exists
    const uploadsDir = path.join('public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    const targetPath = path.join('public', 'uploads', req.file.filename);
    mediaPath = req.file.filename;

    if (['.jpg', '.jpeg', '.png'].includes(ext)) {
      const outputPath = targetPath + '.webp';
      mediaPath += '.webp';
      await sharp(tempPath).webp({ quality: 80 }).toFile(outputPath);
      fs.unlinkSync(tempPath); // Clean up original upload
    } else if (['.gif', '.mp4', '.mov', '.webm'].includes(ext)) {
      const outputPath = targetPath + '.mp4';
      mediaPath += '.mp4';
      await new Promise((resolve, reject) => {
        ffmpeg(tempPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .toFormat('mp4')
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(outputPath);
      }).finally(() => fs.unlinkSync(tempPath));
    } else {
       fs.renameSync(tempPath, targetPath);
    }
  }


  const id = crypto.randomBytes(16).toString('hex');
  const post = {
    id,
    author: req.session.user.username,
    content,
    createdAt: new Date().toISOString()
  };
  
  // Add attachment if media was uploaded
  if (mediaPath) {
    const mediaUrl = `https://${DOMAIN}/uploads/${mediaPath}`;
    let mimeType = 'image/webp';
    if (mediaPath.endsWith('.mp4')) {
      mimeType = 'video/mp4';
    }
    post.attachment = {
      mediaType: mimeType,
      url: mediaUrl
    };
  }
  
  await db.push('posts', post);

  // Federate post
  if (process.env.APEX_DOMAIN) {
    const note = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${process.env.APEX_URL}/posts/${post.id}`,
      type: 'Note',
      published: new Date().toISOString(),
      attributedTo: `${process.env.APEX_URL}/u/${req.session.user.username}`,
      content: `<p>${post.content}</p>`,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${process.env.APEX_URL}/u/${req.session.user.username}/followers`]
    };
    if (post.attachment) {
      note.attachment = [{
        type: 'Document',
        mediaType: post.attachment.mediaType,
        url: post.attachment.url.replace(`https://${DOMAIN}`, process.env.APEX_URL || `https://${DOMAIN}`),
        name: 'attachment'
      }];
    }
    const actorName = req.session.user.username;
    // Manually invoke the outbox post handler
    const mockReq = { ...req, body: note, params: { actor: actorName } };
    const mockRes = {
      locals: res.locals,
      status: (code) => {
        console.log(`Federation returned status ${code} for ${post.id}`);
        return {
          json: (data) => {
            if (!res.headersSent) res.redirect('/');
          }
        }
      },
      json: (data) => {
         if (!res.headersSent) res.redirect('/');
      }
    };
    const next = (err) => {
      if (err) console.error('Federation error', err);
      if (!res.headersSent) res.redirect('/');
    };
    return apex.net.outbox.post(mockReq, mockRes, next);
  }
  res.redirect('/');
});

app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('register', { title: 'Register' });
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Username and password are required.");

    const existingUser = await db.get(`users.${username}`);
    if (existingUser) return res.status(400).send("User already exists.");

    const hashedPassword = await bcrypt.hash(password, 10);
    const actor = await apex.createActor(username, username, 'A MayaSpace user');
    
    // Add collections to the actor
    actor.followers = `https://${DOMAIN}/u/${username}/followers`;
    actor.following = `https://${DOMAIN}/u/${username}/following`;
    actor.liked = `https://${DOMAIN}/u/${username}/liked`;

    const user = {
        username,
        password: hashedPassword,
        actor: actor,
        createdAt: new Date().toISOString()
    };
    await db.set(`users.${username}`, user);
    await apexStore.saveObject(actor);

    res.redirect('/login');
});

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { title: 'Login' });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db.get(`users.${username}`);
    if (!user) return res.status(400).send("Invalid username or password.");

    const match = await bcrypt.compare(password, user.password);
    if (match) {
        req.session.user = {
            username: user.username,
            id: user.actor.id
        };
        res.redirect(`/u/${user.username}`);
    } else {
        res.status(400).send("Invalid username or password.");
    }
});

app.get('/settings', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const user = await db.get(`users.${req.session.user.username}`);
    res.render('settings', { title: 'Settings', user });
});

app.post('/settings', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    const { displayName, bio, customCss } = req.body;
    const { username } = req.session.user;

    const sanitizedCss = sanitizeHtml(customCss, {
        allowedTags: [],
        allowedAttributes: {},
        allowedStyles: {
            '*': {
                // Allow all text and layout styling
                'color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
                'background-color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
                'font-size': [/^\d+px$/],
                'font-family': [/^[\s\w,-]+$/],
                'text-align': [/^left$/, /^right$/, /^center$/],
                'text-decoration': [/^none$/, /^underline$/, /^overline$/, /^line-through$/],
                'border': [/^\d+px\s(solid|dashed|dotted)\s(rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)|#([0-9a-f]{3}){1,2})$/],
                'padding': [/^\d+px$/],
                'margin': [/^\d+px$/],
            }
        }
    });
    
    await db.set(`users.${username}.displayName`, displayName);
    await db.set(`users.${username}.bio`, bio);
    await db.set(`users.${username}.customCss`, sanitizedCss);

    const actorId = req.session.user.id;
    const actor = await apex.store.getObject(actorId);
    if (!actor) {
        return res.status(404).send('Actor not found.');
    }
    
    actor.name = displayName;
    actor.summary = bio;
    await apex.store.updateObject(actor, actorId, true);

    res.redirect(`/u/${username}`);
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.redirect('/');
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/u/:username', async (req, res) => {
    const { username } = req.params;
    const user = await db.get(`users.${username}`);
    if (!user) return res.status(404).send('User not found');
    
    const allPosts = await db.get('posts') || [];
    const userPosts = allPosts.filter(p => p.author === username)
                              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.render('profile', {
        title: `${user.displayName || user.username}'s Profile`,
        user: user,
        posts: userPosts
    });
});

app.get('/u/:username/followers', async (req, res) => {
    const { username } = req.params;
    const user = await db.get(`users.${username}`);
    if (!user) return res.status(404).send('Not Found');
    const followers = await db.get(`users.${username}.followers`) || [];
    res.json(apex.utils.toCollection(req.originalUrl, followers));
});

app.get('/u/:username/following', (req, res) => {
    res.json(apex.utils.toCollection(req.originalUrl, []));
});

app.get('/u/:username/liked', (req, res) => {
    res.json(apex.utils.toCollection(req.originalUrl, []));
});

// ActivityPub event handlers
app.on('apex-inbox', async ({ activity }) => {
    try {
        if (activity.type === 'Follow') {
            const followedUsername = apex.utils.nameFromIRI(activity.object);
            if (!followedUsername) return;
            
            const user = await db.get(`users.${followedUsername}`);
            if (!user) return;

            const followers = await db.get(`users.${followedUsername}.followers`) || [];
            if (!followers.includes(activity.actor)) {
                await db.push(`users.${followedUsername}.followers`, activity.actor);
            }
        } else if (activity.type === 'Undo' && activity.object.type === 'Follow') {
            const followedUsername = apex.utils.nameFromIRI(activity.object.object);
            if (!followedUsername) return;

            const user = await db.get(`users.${followedUsername}`);
            if (!user) return;

            const currentFollowers = await db.get(`users.${followedUsername}.followers`) || [];
            const newFollowers = currentFollowers.filter(follower => follower !== activity.actor);
            await db.set(`users.${followedUsername}.followers`, newFollowers);
        }
    } catch (err) {
        console.error('Error in inbox handler:', err);
    }
});

app.get('/posts/:id', (req, res) => {
// ... existing code ...

});

// -- Server --
app.listen(port, () => {
    console.log(`MayaSpace is listening on port ${port}`);
});
