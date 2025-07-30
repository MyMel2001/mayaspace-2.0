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
const http = require('http');
const { Server } = require('socket.io');
const { BskyAgent } = require('@atproto/api');

const upload = multer({ 
  dest: 'uploads/',
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);
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

// Remove timeouts for upload processing
app.use((req, res, next) => {
  if (req.path === '/new-post') {
    req.setTimeout(0); // No timeout
    res.setTimeout(0); // No timeout
  }
  next();
});

// Session configuration (must come before routes that use sessions)
app.use(session({
    store: new SQLiteStore({ db: process.env.SESSIONS_DATABASE_PATH || 'sessions.sqlite', concurrentDB: true }),
    secret: process.env.SESSION_SECRET || 'a very secret key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));

// API Routes
// User search endpoint
app.get('/api/search/users', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { q } = req.query;
  if (!q || q.length < 2) {
    return res.json([]);
  }
  
  try {
    const results = [];
    
    // Search local users
    const allUsers = await db.get('users') || {};
    for (const [username, user] of Object.entries(allUsers)) {
      if (username.toLowerCase().includes(q.toLowerCase()) || 
          (user.displayName && user.displayName.toLowerCase().includes(q.toLowerCase()))) {
        results.push({
          id: user.actor.id,
          username: username,
          name: user.displayName || username,
          domain: 'Local user',
          type: 'local'
        });
      }
    }
    
    // Search federated users (WebFinger lookup)
    if (q.includes('@') || q.includes('.')) {
      try {
        const federatedUser = await searchFederatedUser(q);
        if (federatedUser) {
          results.push(federatedUser);
        }
      } catch (error) {
        console.error('Federated search error:', error);
      }
    }
    
    res.json(results.slice(0, 10)); // Limit to 10 results
  } catch (error) {
    console.error('User search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Like/dislike post endpoint
app.post('/api/posts/react', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { postId, action } = req.body;
  if (!postId || !['like', 'dislike'].includes(action)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  try {
    const posts = await db.get('posts') || [];
    const postIndex = posts.findIndex(p => p.id === postId);
    
    if (postIndex === -1) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const post = posts[postIndex];
    const userId = req.session.user.username;
    
    // Initialize reaction arrays if they don't exist
    if (!post.likedBy) post.likedBy = [];
    if (!post.dislikedBy) post.dislikedBy = [];
    
    // Remove existing reactions from this user
    post.likedBy = post.likedBy.filter(u => u !== userId);
    post.dislikedBy = post.dislikedBy.filter(u => u !== userId);
    
    // Add new reaction
    if (action === 'like') {
      post.likedBy.push(userId);
    } else {
      post.dislikedBy.push(userId);
    }
    
    // Update counts
    post.likes = post.likedBy.length;
    post.dislikes = post.dislikedBy.length;
    
    // Calculate post score for sorting
    post.score = post.likes - post.dislikes;
    
    posts[postIndex] = post;
    await db.set('posts', posts);
    
    res.json({
      likes: post.likes,
      dislikes: post.dislikes,
      score: post.score
    });
  } catch (error) {
    console.error('Reaction error:', error);
    res.status(500).json({ error: 'Failed to update reaction' });
  }
});

// Follow user endpoint
app.post('/api/follow', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }
  
  try {
    const currentUser = req.session.user.username;
    
    // Check if it's a local or remote user
    const isLocal = userId.includes(`https://${DOMAIN}/u/`);
    
    if (isLocal) {
      // Handle local follow
      const targetUsername = userId.split('/u/')[1];
      const targetUser = await db.get(`users.${targetUsername}`);
      
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Add to local following list
      const following = await db.get(`users.${currentUser}.following`) || [];
      if (!following.includes(userId)) {
        await db.push(`users.${currentUser}.following`, userId);
      }
      
      // Add to target's followers
      const followers = await db.get(`users.${targetUsername}.followers`) || [];
      if (!followers.includes(`https://${DOMAIN}/u/${currentUser}`)) {
        await db.push(`users.${targetUsername}.followers`, `https://${DOMAIN}/u/${currentUser}`);
      }
    } else {
      // Handle federated follow
      const followActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `https://${DOMAIN}/activities/${crypto.randomBytes(16).toString('hex')}`,
        type: 'Follow',
        actor: `https://${DOMAIN}/u/${currentUser}`,
        object: userId,
        published: new Date().toISOString()
      };
      
      // Store the follow activity
      await apex.store.saveActivity(followActivity);
      
      // Add to following list
      const following = await db.get(`users.${currentUser}.following`) || [];
      if (!following.includes(userId)) {
        await db.push(`users.${currentUser}.following`, userId);
      }
      
      // Send federated follow request
      try {
        await apex.net.activity.send(followActivity, currentUser);
      } catch (federationError) {
        console.error('Federation error:', federationError);
        // Don't fail the whole request if federation fails
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

// Reply to post endpoint
app.post('/reply', async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  
  const { postId, content } = req.body;
  if (!postId || !content) {
    return res.status(400).send('Post ID and content are required');
  }
  
  try {
    const posts = await db.get('posts') || [];
    const parentPost = posts.find(p => p.id === postId);
    
    if (!parentPost) {
      return res.status(404).send('Post not found');
    }
    
    const replyId = crypto.randomBytes(16).toString('hex');
    const reply = {
      id: replyId,
      author: req.session.user.username,
      content,
      createdAt: new Date().toISOString(),
      replyTo: postId,
      likes: 0,
      dislikes: 0,
      likedBy: [],
      dislikedBy: [],
      score: 0
    };
    
    await db.push('posts', reply);
    res.redirect('/');
  } catch (error) {
    console.error('Reply error:', error);
    res.status(500).send('Failed to create reply');
  }
});

// Helper function for federated user search
async function searchFederatedUser(query) {
  try {
    let identifier = query;
    
    // Handle different input formats
    if (!identifier.startsWith('http') && !identifier.includes('@')) {
      return null; // Can't search without proper identifier
    }
    
    if (identifier.includes('@') && !identifier.startsWith('http')) {
      // WebFinger lookup
      const [username, domain] = identifier.split('@').slice(-2);
      if (!username || !domain) return null;
      
      const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`;
      
      const response = await fetch(webfingerUrl, {
        headers: {
          'Accept': 'application/json'
        },
        timeout: 5000
      });
      
      if (!response.ok) return null;
      
      const webfingerData = await response.json();
      const actorLink = webfingerData.links?.find(link => 
        link.rel === 'self' && link.type === 'application/activity+json'
      );
      
      if (!actorLink) return null;
      identifier = actorLink.href;
    }
    
    // Fetch actor data
    const actorResponse = await fetch(identifier, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
      },
      timeout: 5000
    });
    
    if (!actorResponse.ok) return null;
    
    const actorData = await actorResponse.json();
    
    return {
      id: actorData.id,
      username: actorData.preferredUsername,
      name: actorData.name || actorData.preferredUsername,
      domain: new URL(actorData.id).hostname,
      type: 'federated',
      summary: actorData.summary
    };
  } catch (error) {
    console.error('Federated search error:', error);
    return null;
  }
}

// Bluesky bridge functionality
async function bridgeToBluesky(username, post) {
  const blueskySettings = await db.get(`users.${username}.blueskySettings`);
  
  if (!blueskySettings || !blueskySettings.enabled || !blueskySettings.handle || !blueskySettings.password) {
    return; // Bridge not enabled or configured
  }
  
  try {
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({
      identifier: blueskySettings.handle,
      password: blueskySettings.password
    });
    
    let postText = post.content;
    
    // Add source attribution
    postText += `\n\n— Posted from MayaSpace`;
    
    // Create Bluesky post
    const blueskyPost = {
      text: postText,
      createdAt: new Date().toISOString()
    };
    
    // Handle media attachments (basic implementation)
    if (post.attachment && post.attachment.mediaType.startsWith('image/')) {
      try {
        // For now, we'll skip image uploads as they require more complex handling
        // In a production environment, you'd want to download the image and upload it to Bluesky
        console.log('Image attachment detected but not yet supported for Bluesky bridge');
      } catch (mediaError) {
        console.error('Media upload to Bluesky failed:', mediaError);
      }
    }
    
    const result = await agent.post(blueskyPost);
    console.log('Successfully bridged post to Bluesky:', result.uri);
    
    // Update the post with Bluesky URI for reference
    const posts = await db.get('posts') || [];
    const postIndex = posts.findIndex(p => p.id === post.id);
    if (postIndex !== -1) {
      posts[postIndex].blueskyUri = result.uri;
      await db.set('posts', posts);
    }
    
  } catch (error) {
    console.error('Bluesky bridge error:', error);
    throw error;
  }
}

// Session middleware moved above to before API routes

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
    
    // Initialize missing reaction data and calculate scores
    const postsWithScores = posts.map(post => {
        if (!post.likedBy) post.likedBy = [];
        if (!post.dislikedBy) post.dislikedBy = [];
        if (typeof post.likes !== 'number') post.likes = post.likedBy.length;
        if (typeof post.dislikes !== 'number') post.dislikes = post.dislikedBy.length;
        if (typeof post.score !== 'number') post.score = post.likes - post.dislikes;
        return post;
    });
    
    // Sort posts by score (likes - dislikes) first, then by creation time
    // Higher score means higher position
    const sortedPosts = postsWithScores
        .filter(post => !post.replyTo) // Only show top-level posts on home
        .sort((a, b) => {
            // Primary sort: by score (likes - dislikes)
            const scoreDiff = b.score - a.score;
            if (scoreDiff !== 0) return scoreDiff;
            
            // Secondary sort: by creation time (newest first)
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
    
    res.render('home', { 
        title: 'Welcome to MayaSpace',
        posts: sortedPosts
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
    } else if (ext === '.gif') {
      const outputPath = targetPath + '.gif';
      mediaPath += '.gif';
      await new Promise((resolve, reject) => {
        ffmpeg(tempPath)
          .outputOptions([
            '-vf', 'scale=iw*0.7:ih*0.7', // Scale to 70% of original dimensions
            '-q:v', '20' // Quality setting (lower is better, 1-31 range, ~20 gives 80% quality)
          ])
          .toFormat('gif')
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(outputPath);
      }).finally(() => fs.unlinkSync(tempPath));
    } else if (['.mp4', '.mov', '.webm'].includes(ext)) {
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
    } else if (mediaPath.endsWith('.gif')) {
      mimeType = 'image/gif';
    }
    post.attachment = {
      mediaType: mimeType,
      url: mediaUrl
    };
  }
  
  await db.push('posts', post);

  // Bridge to Bluesky if enabled
  try {
    await bridgeToBluesky(req.session.user.username, post);
  } catch (error) {
    console.error('Bluesky bridge error:', error);
    // Don't fail the post if Bluesky bridge fails
  }

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
    const blueskySettings = await db.get(`users.${req.session.user.username}.blueskySettings`) || {};
    res.render('settings', { title: 'Settings', user, blueskySettings });
});

app.post('/settings', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    const { displayName, bio, customCss, blueskyHandle, blueskyPassword, enableBlueskyBridge } = req.body;
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

    // Handle Bluesky settings
    if (blueskyHandle || blueskyPassword || enableBlueskyBridge !== undefined) {
        const blueskySettings = {
            handle: blueskyHandle || '',
            password: blueskyPassword || '',
            enabled: enableBlueskyBridge === 'on'
        };
        
        // Test Bluesky connection if credentials provided
        if (blueskySettings.enabled && blueskySettings.handle && blueskySettings.password) {
            try {
                const agent = new BskyAgent({ service: 'https://bsky.social' });
                await agent.login({
                    identifier: blueskySettings.handle,
                    password: blueskySettings.password
                });
                blueskySettings.connected = true;
            } catch (error) {
                console.error('Bluesky connection test failed:', error);
                blueskySettings.connected = false;
                blueskySettings.error = 'Failed to connect to Bluesky. Please check your credentials.';
            }
        }
        
        await db.set(`users.${username}.blueskySettings`, blueskySettings);
    }

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

// Chat routes
app.get('/chat', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    
    // Get recent chat messages
    const messages = await db.get('chat_messages') || [];
    const recentMessages = messages.slice(-50); // Last 50 messages
    
    res.render('chat', {
        title: 'Chat',
        messages: recentMessages
    });
});

// Socket.io for real-time chat
io.on('connection', (socket) => {
    console.log('User connected to chat');
    
    socket.on('join', (userData) => {
        socket.userData = userData;
        socket.join('global_chat');
        socket.broadcast.to('global_chat').emit('user_joined', userData.username);
    });
    
    socket.on('send_message', async (data) => {
        if (!socket.userData) return;
        
        const message = {
            id: crypto.randomBytes(16).toString('hex'),
            author: socket.userData.username,
            content: sanitizeHtml(data.content, {
                allowedTags: [],
                allowedAttributes: {}
            }),
            timestamp: new Date().toISOString()
        };
        
        // Save to database
        await db.push('chat_messages', message);
        
        // Broadcast to all users
        io.to('global_chat').emit('new_message', message);
    });
    
    socket.on('disconnect', () => {
        if (socket.userData) {
            socket.broadcast.to('global_chat').emit('user_left', socket.userData.username);
        }
        console.log('User disconnected from chat');
    });
});

// -- Server --
server.listen(port, () => {
    console.log(`MayaSpace is listening on port ${port}`);
});
