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

app.post('/posts', upload.single('media'), async (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    const { content } = req.body;
    if (!content) return res.status(400).send('Post content cannot be empty.');

    const user = await db.get(`users.${req.session.user.username}`);
    
    let attachment = null;
    if (req.file) {
        const tempPath = req.file.path;
        const extension = path.extname(req.file.originalname).toLowerCase();
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        let newFilename;
        let newMimeType = req.file.mimetype;

        if (req.file.mimetype.startsWith('image/') && extension !== '.gif') {
            newFilename = uniqueSuffix + '.webp';
            newMimeType = 'image/webp';
        } else if (req.file.mimetype.startsWith('video/') || extension === '.gif') {
            newFilename = uniqueSuffix + '.mp4';
            newMimeType = 'video/mp4';
        } else {
            newFilename = uniqueSuffix + extension;
        }
        
        const targetPath = path.join(__dirname, 'public/media', newFilename);

        try {
            if (req.file.mimetype.startsWith('image/') && extension !== '.gif') {
                await sharp(tempPath)
                    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                    .toFormat('webp', { quality: 80 })
                    .toFile(targetPath);
                fs.unlinkSync(tempPath); // Clean up temp file
            } else if (req.file.mimetype.startsWith('video/') || extension === '.gif') {
                await new Promise((resolve, reject) => {
                    ffmpeg(tempPath)
                        .outputOptions('-c:v libx264')
                        .outputOptions('-crf 23')
                        .outputOptions('-preset fast')
                        .outputOptions('-c:a aac')
                        .outputOptions('-b:a 128k')
                        .on('end', () => {
                             fs.unlinkSync(tempPath);
                             resolve(); 
                        })
                        .on('error', (err) => {
                            fs.unlinkSync(tempPath);
                            reject(err);
                        })
                        .save(targetPath);
                });
            } else {
                 fs.renameSync(tempPath, targetPath);
            }
        } catch (error) {
            console.error('Error processing file:', error);
            // Fallback to just moving the file if processing fails
            if (fs.existsSync(tempPath)) fs.renameSync(tempPath, targetPath);
        }

        const mediaUrl = `https://${DOMAIN}/media/${newFilename}`;
        attachment = {
            type: 'Document',
            mediaType: newMimeType,
            url: mediaUrl,
            name: 'User upload'
        };
    }

    const noteObject = {
        type: 'Note',
        content: content,
        attributedTo: user.actor.id,
        to: 'https://www.w3.org/ns/activitystreams#Public',
        cc: [user.actor.followers],
        attachment: attachment ? [attachment] : []
    };

    const activity = await apex.publish(user.actor.id, noteObject);

    const post = {
        id: activity.object.id,
        author: req.session.user.username,
        content: content,
        attachment: attachment,
        createdAt: new Date().toISOString()
    };
    await db.push('posts', post);
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

// -- Server --
app.listen(port, () => {
    console.log(`MayaSpace is listening on port ${port}`);
});
