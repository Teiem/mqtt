import Dexie, { type Table } from 'dexie';

export type Message = {
    id: string;
    topic: string;
    message: string;
    timestamp: string; // timestamp in ISO 8601 format
}

export class TypedDexie extends Dexie {
    messages!: Table<Message>;

    constructor() {
        super('myDatabase');
        this.version(1).stores({
            messages: '++id, topic, message, timestamp',
        });
    }
}

export const db = new TypedDexie();