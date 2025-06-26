const IApexStore = require('activitypub-express/store/interface');
const { QuickDB } = require('quick.db');

class QuickDBStore extends IApexStore {
    constructor() {
        super();
        this.db = new QuickDB({ filePath: 'mayaspace.sqlite' });
    }

    async getObject(id, includeMeta) {
        const object = await this.db.get(`objects.${this.safeKey(id)}`);
        if (!object) return null;
        if (includeMeta) {
            return object;
        }
        return object.object;
    }

    async saveObject(object) {
        if (!object.id) return new Error('object must have an id');
        const storageObject = {
            id: object.id,
            object: object,
            meta: {
                createdAt: new Date().toISOString()
            }
        };
        await this.db.set(`objects.${this.safeKey(object.id)}`, storageObject);
        return storageObject;
    }

    async getActivity(id, includeMeta) {
        const activity = await this.db.get(`activities.${this.safeKey(id)}`);
        if (!activity) return null;
        if (includeMeta) {
            return activity;
        }
        return activity.activity;
    }
    
    async saveActivity(activity) {
        if (!activity.id) return new Error('activity must have an id');
        const storageActivity = {
            id: activity.id,
            activity: activity,
            meta: {
                createdAt: new Date().toISOString()
            }
        };
        await this.db.set(`activities.${this.safeKey(activity.id)}`, storageActivity);
        return storageActivity;
    }
    
    // quick.db keys can't contain '.' so we replace them
    safeKey(key) {
        return key.replace(/[\.\/]/g, '_');
    }
    
    // --- Methods to be implemented ---
    
    setup(optionalActor) {
        // No setup needed for quick.db
        return Promise.resolve(this);
    }
    
    findActivityByCollectionAndObjectId(collection, objectId, includeMeta) {
        throw new Error('Not implemented');
    }

    findActivityByCollectionAndActorId(collection, actorId, includeMeta) {
        throw new Error('Not implemented');
    }
    
    async getStream(collectionId, limit = 50, after, blockList = [], query) {
        const allActivities = await this.db.get('activities') || {};
        let activities = Object.values(allActivities);

        // This is a very basic implementation.
        // A real implementation would need to handle collections properly.
        // For now, we assume all activities are in a single "stream".
        
        if (after) {
            const afterIndex = activities.findIndex(a => a.id === after);
            if (afterIndex > -1) {
                activities = activities.slice(afterIndex + 1);
            }
        }

        activities = activities.filter(a => !blockList.includes(a.activity.actor));
        
        return activities
            .sort((a, b) => new Date(b.activity.published) - new Date(a.activity.published))
            .slice(0, limit);
    }
    
    async getStreamCount(collectionId) {
        const allActivities = await this.db.get('activities') || {};
        return Object.keys(allActivities).length;
    }
    
    getContext(documentUrl) {
        // For now, we won't cache contexts
        return Promise.resolve(null);
    }
    
    getUsercount() {
        throw new Error('Not implemented');
    }
    
    saveContext(context) {
        // For now, we won't cache contexts
        return Promise.resolve();
    }
    
    async removeActivity(activity, actorId) {
        await this.db.delete(`activities.${this.safeKey(activity.id)}`);
    }

    async updateActivity(activity, fullReplace) {
        const id = activity.id;
        if (fullReplace) {
            return this.saveActivity(activity);
        }
        const existing = await this.db.get(`activities.${this.safeKey(id)}`);
        if (!existing) {
            return this.saveActivity(activity);
        }
        const newActivity = { ...existing.activity, ...activity };
        existing.activity = newActivity;
        await this.db.set(`activities.${this.safeKey(id)}`, existing);
        return existing;
    }
    
    async updateActivityMeta(activity, key, value, remove) {
        const id = activity.id;
        const existing = await this.db.get(`activities.${this.safeKey(id)}`);
        if (!existing) {
            return;
        }
        if (remove) {
            delete existing.meta[key];
        } else {
            existing.meta[key] = value;
        }
        await this.db.set(`activities.${this.safeKey(id)}`, existing);
        return existing;
    }
    
    generateId() {
        return `https://${this.domain}/o/${Date.now()}`;
    }
    
    async updateObject(obj, actorId, fullReplace) {
        if (!obj.id) return new Error('object must have an id');
        return this.saveObject(obj);
    }
    
    deliveryDequeue() {
        throw new Error('Not implemented');
    }
    
    deliveryEnqueue(actorId, body, addresses, signingKey) {
        throw new Error('Not implemented');
    }
    
    deliveryRequeue(delivery) {
        throw new Error('Not implemented');
    }
}

module.exports = QuickDBStore; 