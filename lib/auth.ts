import { betterAuth } from "better-auth";
import { MongoClient } from "mongodb";
import {mongodbAdapter} from 'better-auth/adapters/mongodb';

const mongoUri = process.env.MONGO_URI;

if(!mongoUri){
    throw new Error("MONGO URI is not set");
};

const client = new MongoClient(mongoUri);
const db = client.db();

export const auth = betterAuth({
    database: mongodbAdapter(db, {
        client,
    }),
    emailAndPassword:{
        enabled: true,
        autoSignIn: false,
    },
});